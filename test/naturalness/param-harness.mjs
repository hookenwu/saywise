// Raw Volcengine V3 bidirectional TTS harness used for the parameter experiments in
// specs/voice-copilot-natural-delivery/research.md (E1-E5): sends arbitrary req_params /
// additions / audio_params, bypassing js/tts-client.js. Node 24 (global WebSocket).
// Usage: import { synth } from './param-harness.mjs'
//   await synth({ texts: ['...'], additions: { context_texts: ['...'] }, out: 'a.mp3' })
globalThis.window = globalThis;
const REPO = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const P = await import(`${REPO}/js/volcengine-protocol.js`);
const CFG = await import(`${REPO}/config/voice-config.local.js`);
const { EventType, MsgType, MsgTypeFlagBits, createMessage, marshalMessage, unmarshalMessage } = P;
import fs from 'node:fs';
import crypto from 'node:crypto';

export const SPEAKER = CFG.VOICE_PROFILES[0].speakerId;

function send(ws, ev, sid, payload) {
  const m = createMessage(MsgType.FullClientRequest, MsgTypeFlagBits.WithEvent);
  m.event = ev; if (sid) m.sessionId = sid;
  m.payload = new TextEncoder().encode(payload || '{}');
  ws.send(marshalMessage(m));
}

/**
 * @param {object} o
 *  speaker, resourceId, texts: string[] (pushed as separate TaskRequests), reqParams (merged),
 *  additions (object, stringified), out (mp3 path), pushDelayMs (simulate streaming LLM)
 */
export async function synth(o) {
  const speaker = o.speaker || SPEAKER;
  const resourceId = o.resourceId || (speaker.startsWith('S_') ? 'seed-icl-2.0' : 'seed-tts-2.0');
  const url = new URL('wss://openspeech.bytedance.com/api/v3/tts/bidirection');
  url.searchParams.set('api_app_key', CFG.PROVIDER_CONFIGURATION.appKey);
  url.searchParams.set('api_access_key', CFG.PROVIDER_CONFIGURATION.accessToken);
  url.searchParams.set('api_resource_id', resourceId);
  url.searchParams.set('api_connect_id', crypto.randomUUID());
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  const q = []; let waiter = null; let closed = null;
  ws.onmessage = (e) => { const m = unmarshalMessage(new Uint8Array(e.data)); if (waiter) { const w = waiter; waiter = null; w(m); } else q.push(m); };
  ws.onclose = (e) => { closed = `closed ${e.code} ${e.reason}`; if (waiter) { const w = waiter; waiter = null; w(null); } };
  const next = (ms = 20000) => new Promise((res, rej) => {
    if (q.length) return res(q.shift());
    if (closed) return res(null);
    const t = setTimeout(() => { waiter = null; rej(new Error('timeout')); }, ms);
    waiter = (m) => { clearTimeout(t); res(m); };
  });
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
  const dec = (m) => new TextDecoder().decode(m.payload);
  const errOf = (m) => (m && m.type === MsgType.Error) ? `ERR ${m.errorCode} ${dec(m)}` : null;

  send(ws, EventType.StartConnection, null, '{}');
  let m = await next(); if (errOf(m) || !m) { ws.close(); return { error: errOf(m) || closed }; }

  const sid = crypto.randomUUID();
  const additions = { disable_markdown_filter: true, ...(o.additions || {}) };
  const reqBase = {
    speaker,
    audio_params: { format: 'mp3', sample_rate: 24000, ...(o.audioParams || {}) },
    additions: JSON.stringify(additions),
    ...(o.reqParams || {}),
  };
  for (const k of Object.keys(reqBase)) if (reqBase[k] === undefined) delete reqBase[k];
  send(ws, EventType.StartSession, sid, JSON.stringify({ user: { uid: 'harness' }, event: EventType.StartSession, req_params: reqBase }));
  m = await next();
  if (!m || errOf(m) || m.event !== EventType.SessionStarted) { ws.close(); return { error: errOf(m) || (m && `${m.event} ${dec(m)}`) || closed }; }

  const t0 = performance.now();
  let ttfa = null; const chunks = []; const sentences = []; let error = null; let usage = null;
  const pump = (async () => {
    while (true) {
      const r = await next(60000).catch((e) => ({ timeout: e }));
      if (!r) { error = error || closed; return; }
      if (r.timeout) { error = 'timeout'; return; }
      if (r.type === MsgType.Error) { error = errOf(r); return; }
      if (r.type === MsgType.AudioOnlyServer) { if (ttfa === null) ttfa = performance.now() - t0; chunks.push(Buffer.from(r.payload)); continue; }
      if (r.event === EventType.TTSSentenceStart) { sentences.push(dec(r)); continue; }
      if (r.event === EventType.SessionFinished) { const p = dec(r); if (!/"status_code":20000000|^\{\}$/.test(p) && p.includes('status_code')) error = p; return; }
      if (r.event === EventType.SessionFailed) { error = `SessionFailed ${dec(r)}`; return; }
      if (r.event === EventType.UsageResponse) usage = dec(r);
    }
  })();
  for (const text of o.texts) {
    send(ws, EventType.TaskRequest, sid, JSON.stringify({ user: { uid: 'harness' }, event: EventType.TaskRequest, req_params: { ...reqBase, text } }));
    if (o.pushDelayMs) await new Promise((r) => setTimeout(r, o.pushDelayMs));
  }
  send(ws, EventType.FinishSession, sid, '{}');
  await pump;
  const total = performance.now() - t0;
  try { send(ws, EventType.FinishConnection, null, '{}'); } catch {}
  setTimeout(() => { try { ws.close(); } catch {} }, 200);
  const audio = Buffer.concat(chunks);
  if (o.out && audio.length) fs.writeFileSync(o.out, audio);
  return { ttfa: ttfa && Math.round(ttfa), total: Math.round(total), bytes: audio.length, error, sentences: sentences.length, usage };
}
