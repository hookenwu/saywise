/**
 * POST /api/translate-stream — thin SSE relay for streamTranslate() (spec.md §9,
 * plan.md §8.3). No buffering, no sentence-splitting here: chunking is a client-side
 * concern (js/translation-client.js) so this route stays a minimal-latency relay.
 *
 * Phase 12 (tasks.md T12.2): the Gemini API key is resolved via credential-store.js's
 * file-store-then-env-fallback (server/llm-credential.local.json, written through
 * Settings, else process.env.GEMINI_API_KEY as a bootstrap convenience) — replacing
 * Phase 10's temporary direct `process.env.GEMINI_API_KEY` read.
 */

import { Router } from 'express';

import { streamTranslate } from '../lib/translate.js';
import { readCredential } from '../lib/credential-store.js';

const router = Router();

// Speaking Style (speaking-style spec.md §4, plan.md §4.5): the only normalization this
// route performs on stylePreset/myStyle is type/shape and the stylePreset allowlist below
// — NOT character-count truncation. The 500/300/300/800 caps live exclusively in
// buildMyStyleBlock()/cap() inside ../lib/translate.js, so a field is truncated exactly
// once, not twice at two layers (tasks.md T16.3).
const STYLE_PRESETS = new Set(['natural', 'professional', 'concise', 'my-style']);

function normalizeStylePreset(value) {
  return STYLE_PRESETS.has(value) ? value : 'natural';
}

function normalizeMyStyle(value) {
  const v = value && typeof value === 'object' ? value : {};
  const asString = (field) => (typeof v[field] === 'string' ? v[field] : '');
  return {
    speakingPreferences: asString('speakingPreferences'),
    preferredPhrases: asString('preferredPhrases'),
    avoidedPhrases: asString('avoidedPhrases'),
    exampleSentences: asString('exampleSentences'),
  };
}

router.post('/translate-stream', async (req, res) => {
  const text = req.body?.text;
  if (typeof text !== 'string' || !text.trim()) {
    res.status(400).json({ error: 'Request body must include a non-empty "text" field' });
    return;
  }
  const stylePreset = normalizeStylePreset(req.body?.stylePreset);
  const myStyle = normalizeMyStyle(req.body?.myStyle);

  const credential = await readCredential();
  const apiKey = credential?.accessToken;
  if (!apiKey) {
    res.status(500).json({ error: 'Translation/LLM Provider Credential is not configured — set it via Settings, or GEMINI_API_KEY in server/.env' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Upstream-abort handling (plan.md §8.3) — not optional polish. Once the browser aborts
  // its fetch (§7.3's translationAbort.abort()), Express surfaces the closed connection as
  // a 'close' event here. `upstreamAbort` is passed straight into streamTranslate() (which
  // forwards it to the Gemini SDK call itself, lib/translate.js) so this stops the
  // underlying upstream HTTP request directly, not just gated after the fact — an abort
  // that lands while still awaiting the *first* upstream response has nothing else to
  // interrupt it, since the relay loop below only gets a chance to check `aborted` once a
  // chunk has actually been yielded to it.
  let aborted = false;
  const upstreamAbort = new AbortController();
  // `res.on('close')`, not `req.on('close')`: in current Node/Express, the request's
  // 'close' event can fire once the (already fully-buffered, tiny) request body has been
  // consumed, well before the response is actually done — which reads as a false
  // "client disconnected" the moment a slow upstream call (like Gemini here) takes more
  // than an instant to produce its first chunk. `res`'s 'close' event is what actually
  // means "the response's underlying connection is gone," which is the real signal
  // plan.md §8.3 wants this handler to react to.
  res.on('close', () => {
    aborted = true;
    upstreamAbort.abort();
  });

  try {
    for await (const { content } of streamTranslate(text, { apiKey, signal: upstreamAbort.signal, stylePreset, myStyle })) {
      if (aborted) break;
      res.write(`data: ${JSON.stringify({ content })}\n\n`);
    }
    if (!aborted) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  } catch (err) {
    if (aborted) return;
    console.error('[translate-stream] failed:', err?.message || err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'Translation failed' });
    } else {
      res.write(`data: ${JSON.stringify({ error: err.message || 'Translation failed' })}\n\n`);
      res.end();
    }
  }
});

export default router;
