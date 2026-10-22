/**
 * Natural Delivery tests — js/delivery.js, js/tts-client.js payload, server/lib/translate.js
 * prompt composition + normalizers (specs/voice-copilot-natural-delivery/plan.md §3).
 *
 * Run: node test/test-natural-delivery.js   (exits non-zero on any failure; no network)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window ??= globalThis; // js/volcengine-protocol.js installs window.__vlog

const {
  DELIVERY_LEVELS,
  normalizeDelivery,
  buildTtsDeliveryParams,
  createSpeakableChunker,
  TTS_DELIVERY_INSTRUCTION,
} = await import('../js/delivery.js');
const { StreamingTTSClient } = await import('../js/tts-client.js');
const P = await import('../js/volcengine-protocol.js');
const T = await import('../server/lib/translate.js');

// ---- chunker ----------------------------------------------------------------

function runChunker(deltas) {
  const c = createSpeakableChunker();
  const out = [];
  for (const d of deltas) out.push(...c.push(d));
  const tail = c.flush();
  if (tail) out.push(tail);
  return out;
}

test('chunker never splits an English word and loses no characters', () => {
  const text = "Yeah, I get your point. But, um, I'm a bit worried about the timeline... and we might push it.";
  // Simulate arbitrary LLM delta boundaries, including mid-word.
  for (const size of [1, 2, 3, 5, 7, 11]) {
    const deltas = [];
    for (let i = 0; i < text.length; i += size) deltas.push(text.slice(i, i + size));
    const chunks = runChunker(deltas);
    assert.equal(chunks.join(''), text, `size=${size}`);
    for (const ch of chunks.slice(0, -1)) {
      assert.match(ch, /[\s.,!?;:—…]$/, `chunk must end at a boundary (size=${size}): ${JSON.stringify(ch)}`);
    }
  }
});

test('chunker emits CJK at punctuation and bounds unpunctuated runs', () => {
  const zh = '嗯，我理解你的意思。不过呢，我有点担心时间……';
  const chunks = runChunker([...zh]);
  assert.equal(chunks.join(''), zh);
  assert.ok(chunks.length >= 3);
  const longRun = '一'.repeat(100);
  const c = createSpeakableChunker();
  const emitted = [...longRun].flatMap((ch) => c.push(ch));
  assert.ok(emitted.length >= 2, 'a 100-char run without punctuation is still emitted progressively');
  assert.equal(emitted.join('') + c.flush(), longRun);
});

test('chunker never emits whitespace-only chunks, and keeps the separator', () => {
  const c = createSpeakableChunker();
  assert.deepEqual(c.push('Hello'), []);
  assert.deepEqual(c.push(' '), ['Hello ']);
  assert.deepEqual(c.push(' '), []);
  assert.deepEqual(c.push('world.'), [' world.']);
  assert.equal(c.flush(), '');
});

// ---- normalizers ------------------------------------------------------------

test('delivery/mode normalizers allowlist and default', () => {
  assert.deepEqual(DELIVERY_LEVELS, ['off', 'light', 'natural']);
  for (const v of DELIVERY_LEVELS) assert.equal(normalizeDelivery(v), v);
  assert.equal(normalizeDelivery('loud'), 'natural');
  assert.equal(normalizeDelivery(undefined), 'natural');
  assert.equal(T.normalizeDelivery('off'), 'off');
  assert.equal(T.normalizeDelivery({}), 'natural');
  assert.equal(T.normalizeMode('rewrite'), 'rewrite');
  assert.equal(T.normalizeMode('jailbreak'), 'translate');
});

// ---- TTS payload ------------------------------------------------------------

test('buildTtsDeliveryParams: off = legacy expressive payload, light/natural = context_texts without model', () => {
  assert.deepEqual(buildTtsDeliveryParams('off'), {
    model: 'seed-tts-2.0-expressive',
    additions: { disable_markdown_filter: true, use_tag_parser: true },
  });
  for (const level of ['light', 'natural']) {
    const p = buildTtsDeliveryParams(level);
    assert.equal(p.model, undefined);
    assert.deepEqual(p.additions.context_texts, [TTS_DELIVERY_INSTRUCTION]);
    assert.equal(p.additions.use_tag_parser, undefined);
  }
});

/** Minimal fake of the Volcengine endpoint: acks StartConnection/StartSession, records frames. */
function installFakeWebSocket(sent) {
  const encode = (s) => new TextEncoder().encode(s);
  class FakeWS {
    static OPEN = 1;
    constructor() {
      this.readyState = 1;
      setTimeout(() => this.onopen?.(), 0);
    }
    send(bytes) {
      const msg = P.unmarshalMessage(new Uint8Array(bytes));
      sent.push(msg);
      if (msg.event === P.EventType.StartConnection) {
        // ConnectionStarted carries a connect-id field: header, event, connectId(len 0), payload
        const b = new Uint8Array(4 + 4 + 4 + 4 + 2);
        const dv = new DataView(b.buffer);
        b.set([0x11, (P.MsgType.FullServerResponse << 4) | P.MsgTypeFlagBits.WithEvent, 0x10, 0x00]);
        dv.setInt32(4, P.EventType.ConnectionStarted);
        dv.setUint32(8, 0);
        dv.setUint32(12, 2);
        b.set(encode('{}'), 16);
        this.#reply(b);
      } else if (msg.event === P.EventType.StartSession) {
        const r = P.createMessage(P.MsgType.FullServerResponse, P.MsgTypeFlagBits.WithEvent);
        r.event = P.EventType.SessionStarted;
        r.sessionId = msg.sessionId;
        r.payload = encode('{}');
        this.#reply(P.marshalMessage(r));
      }
    }
    #reply(bytes) {
      setTimeout(() => this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }), 0);
    }
    close() {
      this.readyState = 3;
    }
  }
  globalThis.WebSocket = FakeWS;
}

async function startSessionPayload(voiceSettings) {
  const sent = [];
  installFakeWebSocket(sent);
  const client = new StreamingTTSClient({ appKey: 'k', accessToken: 't' });
  const log = console.log;
  console.log = () => {};
  try {
    await client.beginSession({ speaker: 'S_test', ...voiceSettings }, {});
  } finally {
    console.log = log;
  }
  const start = sent.find((m) => m.event === P.EventType.StartSession);
  return JSON.parse(new TextDecoder().decode(start.payload)).req_params;
}

// Exactly what js/tts-client.js sent before Natural Delivery (git 666cec1) for
// { useTTS2: true } at neutral prosody — key order included.
const LEGACY_REQ_PARAMS = JSON.stringify({
  speaker: 'S_test',
  model: 'seed-tts-2.0-expressive',
  audio_params: { format: 'mp3', sample_rate: 24000, enable_timestamp: false, speech_rate: 0, loudness_rate: 0 },
  additions: JSON.stringify({ disable_markdown_filter: true, use_tag_parser: true }),
  post_process: { pitch: 0 },
});

test('tts-client: delivery off and legacy useTTS2 both reproduce the legacy wire payload byte-for-byte', async () => {
  assert.equal(JSON.stringify(await startSessionPayload({ delivery: 'off' })), LEGACY_REQ_PARAMS);
  assert.equal(JSON.stringify(await startSessionPayload({ useTTS2: true })), LEGACY_REQ_PARAMS);
});

test('tts-client: natural sends one context_texts instruction, no model, prosody unchanged', async () => {
  const rp = await startSessionPayload({ delivery: 'natural', speed: 1.2, pitch: 3 });
  assert.equal(rp.model, undefined);
  const additions = JSON.parse(rp.additions);
  assert.deepEqual(additions.context_texts, [TTS_DELIVERY_INSTRUCTION]);
  assert.equal(additions.disable_markdown_filter, true);
  assert.equal(rp.audio_params.speech_rate, 20);
  assert.equal(rp.audio_params.format, 'mp3');
  assert.deepEqual(rp.post_process, { pitch: 3 });
});

// ---- prompt composition -----------------------------------------------------

test('buildSystemInstruction: delivery off/translate is the legacy three-part prompt', () => {
  for (const stylePreset of ['natural', 'professional', 'concise', 'my-style', undefined]) {
    const off = T.buildSystemInstruction({ stylePreset, delivery: 'off' });
    const parts = off.split('\n\n');
    assert.equal(parts.length, 3, stylePreset);
    assert.match(parts[0], /^You are a translation engine/);
    assert.match(parts[2], /^Do not alter amounts/);
    assert.doesNotMatch(off, /SPOKEN DELIVERY/);
    // Omitting delivery (direct library callers that predate the feature) is also legacy.
    assert.equal(T.buildSystemInstruction({ stylePreset }), off);
  }
});

test('buildSystemInstruction: light/natural add the delivery block before the guardrail', () => {
  const light = T.buildSystemInstruction({ stylePreset: 'professional', delivery: 'light' });
  const natural = T.buildSystemInstruction({ stylePreset: 'professional', delivery: 'natural' });
  for (const s of [light, natural]) {
    assert.match(s, /^You are a translation engine/);
    assert.match(s, /business-appropriate/);
    assert.match(s, /SPOKEN DELIVERY/);
    assert.match(s, /Do not alter amounts[^\n]*$/, 'guardrail stays last');
  }
  assert.match(light, /Do NOT add hesitation sounds/);
  assert.match(natural, /"uh", "um"/);
});

test('buildSystemInstruction: rewrite mode keeps the language and drops the translation task', () => {
  const s = T.buildSystemInstruction({ mode: 'rewrite', delivery: 'natural', stylePreset: 'concise' });
  assert.match(s, /^You are a speech-script editor/);
  assert.match(s, /do not translate/);
  assert.doesNotMatch(s, /translation engine/);
  assert.doesNotMatch(s, /shorter sentences/, 'Speaking Style is translate-only');
  assert.match(s, /Do not alter amounts[^\n]*$/);
});

test('detectLanguage + rewrite language lock: each prompt shows only its output language', () => {
  assert.equal(T.detectLanguage('Sorry, could you repeat that?'), 'en');
  assert.equal(T.detectLanguage('好的，那我简单说一下'), 'zh');
  assert.equal(T.detectLanguage('我们的API延迟有点高，我先看一下log'), 'zh');
  assert.equal(T.detectLanguage('Let me check 一下 the logs first'), 'en');
  const en = T.buildSystemInstruction({ mode: 'rewrite', delivery: 'natural', inputText: 'Could you repeat that?' });
  assert.match(en, /MUST be English/);
  assert.doesNotMatch(en, /[一-鿿]{2}/, 'English rewrite prompt carries no Chinese example');
  const zh = T.buildSystemInstruction({ mode: 'rewrite', delivery: 'light', inputText: '能再说一遍吗？' });
  assert.match(zh, /输出必须是中文/);
  assert.match(zh, /Spoken: 我理解你的意思/);
  // Translation output is always English: English vocabulary and example only.
  const tr = T.buildSystemInstruction({ stylePreset: 'natural', delivery: 'natural' });
  assert.match(tr, /Spoken: Yeah, I get your point/);
  assert.doesNotMatch(tr, /Spoken: 嗯/);
  assert.doesNotMatch(tr, /OUTPUT LANGUAGE/);
});
