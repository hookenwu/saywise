/**
 * End-to-end A/B for Natural Delivery through the SHIPPED modules (js/tts-client.js,
 * server/lib/translate.js, js/delivery.js) against the real Volcengine + Gemini endpoints.
 * Reproduces app.js's two push strategies faithfully: legacy = sentence-batched pushes via
 * extractCompletedSentences(); new = createSpeakableChunker() word-safe pushes.
 *
 * usage (from repo root):
 *   node --env-file=server/.env test/naturalness/run-ab.mjs <outDir> [reps=2] [direct|translated|all] [cond,cond]
 * Credentials: config/voice-config.local.js (TTS) + GEMINI_API_KEY (LLM). Writes
 * <outDir>/*.mp3, manifest.json (for evaluate.py / judge.mjs) and timing.json.
 */
import fs from 'node:fs';
import path from 'node:path';

globalThis.window ??= globalThis;
const repo = new URL('../../', import.meta.url).pathname;
const { StreamingTTSClient } = await import(`${repo}js/tts-client.js`);
const { createSpeakableChunker } = await import(`${repo}js/delivery.js`);
const { extractCompletedSentences } = await import(`${repo}js/translation-client.js`);
const { streamTranslate, normalizeDelivery } = await import(`${repo}server/lib/translate.js`);
const CFG = await import(`${repo}config/voice-config.local.js`);
const { DIRECT_TEXTS, CHINESE_INPUTS } = await import('./texts.mjs');

const [outDir, repsArg = '2', which = 'all', condFilter] = process.argv.slice(2);
const reps = Number(repsArg);
fs.mkdirSync(outDir, { recursive: true });
const speaker = CFG.VOICE_PROFILES[0].speakerId;
const apiKey = process.env.GEMINI_API_KEY;
const quiet = console.log;

async function speak({ delivery, textSource, push }) {
  const client = new StreamingTTSClient(CFG.PROVIDER_CONFIGURATION);
  const chunks = [];
  let firstAudio = null;
  let spokenText = '';
  const t0 = performance.now();
  console.log = () => {};
  try {
    await client.beginSession(
      { speaker, speed: 1.0, volume: 1.0, pitch: 0, delivery },
      { onChunk: (b) => { if (firstAudio === null) firstAudio = performance.now() - t0; chunks.push(Buffer.from(b)); } }
    );
    if (push === 'verbatim') {
      spokenText = textSource;
      await client.pushText(textSource);
    } else {
      // LLM path: textSource is an async iterable of { content }
      const chunker = createSpeakableChunker();
      let buf = '';
      for await (const { content } of textSource) {
        spokenText += content;
        if (push === 'sentences') {
          buf += content;
          const { sentences, remainder } = extractCompletedSentences(buf);
          for (const s of sentences) await client.pushText(s);
          buf = remainder;
        } else {
          for (const c of chunker.push(content)) await client.pushText(c);
        }
      }
      const tail = push === 'sentences' ? buf.trim() : chunker.flush();
      if (tail) await client.pushText(tail);
    }
    await client.endSession();
  } finally {
    console.log = quiet;
    await client._disconnect().catch(() => {});
  }
  return { audio: Buffer.concat(chunks), ttfa: Math.round(firstAudio), total: Math.round(performance.now() - t0), spokenText: spokenText.trim() };
}

const llm = (text, opts) => streamTranslate(text, { apiKey, stylePreset: 'natural', ...opts });

const CONDITIONS = {
  // Direct Speak
  direct_legacy: { group: 'direct', delivery: 'off', run: (t) => ({ textSource: t, push: 'verbatim' }) },
  direct_natural: { group: 'direct', delivery: 'natural', run: (t) => ({ textSource: t, push: 'verbatim' }) },
  direct_humanize: { group: 'direct', delivery: 'natural', run: (t) => ({ textSource: llm(t, { mode: 'rewrite', delivery: 'natural' }), push: 'chunks' }) },
  // Translated Speak (Chinese -> English)
  trans_legacy: { group: 'translated', delivery: 'off', run: (t) => ({ textSource: llm(t, { delivery: 'off' }), push: 'sentences' }) },
  trans_light: { group: 'translated', delivery: 'light', run: (t) => ({ textSource: llm(t, { delivery: 'light' }), push: 'chunks' }) },
  trans_natural: { group: 'translated', delivery: 'natural', run: (t) => ({ textSource: llm(t, { delivery: 'natural' }), push: 'chunks' }) },
};

const manifest = [];
const timing = [];
for (const [cond, c] of Object.entries(CONDITIONS)) {
  if (which !== 'all' && which !== c.group) continue;
  if (condFilter && !condFilter.split(',').includes(cond)) continue;
  const inputs = c.group === 'direct' ? DIRECT_TEXTS : CHINESE_INPUTS;
  for (const item of inputs) for (let rep = 0; rep < reps; rep++) {
    let r;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { r = await speak({ delivery: normalizeDelivery(c.delivery), ...c.run(item.text) }); break; } catch (e) { r = { error: e.message }; await new Promise((x) => setTimeout(x, 2000)); }
    }
    if (r.error) { console.log('FAIL', cond, item.id, r.error); continue; }
    const file = path.join(outDir, `${cond}__${item.id}_${rep}.mp3`);
    fs.writeFileSync(file, r.audio);
    // `text` is what the judge sees as the intended message: the legacy rendering of the same
    // content, so every condition in a group is judged against the same meaning.
    manifest.push({ file, cond, group: c.group, tid: item.id, rep, lang: c.group === 'direct' ? item.lang : 'en', text: r.spokenText, spokenText: r.spokenText, ref: cond.endsWith('_legacy') });
    timing.push({ cond, tid: item.id, rep, ttfa: r.ttfa, total: r.total });
    process.stdout.write(`${cond}/${item.id}/${rep} ttfa=${r.ttfa}  `);
  }
}
// With a condition filter, replace only those conditions in an existing manifest/timing.
const merge = (name, rows) => {
  const f = path.join(outDir, name);
  const prev = condFilter && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).filter((r) => !condFilter.split(',').includes(r.cond)) : [];
  fs.writeFileSync(f, JSON.stringify([...prev, ...rows], null, 1));
};
merge('manifest.json', manifest);
merge('timing.json', timing);
console.log('\n\nTTFA from Speak to first audio chunk (ms):');
const by = {};
for (const t of timing) (by[t.cond] ||= []).push(t.ttfa);
for (const [c, v] of Object.entries(by)) { v.sort((a, b) => a - b); console.log(`${c.padEnd(18)} median ${v[v.length >> 1]}  p90 ${v[Math.min(v.length - 1, Math.floor(v.length * 0.9))]}  n ${v.length}`); }
