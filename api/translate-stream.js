/**
 * POST /api/translate-stream — Vercel Serverless Function adapter for streamTranslate()
 * (speaking-style spec.md §9, plan.md §8.3).
 *
 * Why this file exists: `server/index.js` is a long-running Express app (`app.listen()`),
 * which Vercel does not run — Vercel's deployment model is per-route serverless functions
 * under `/api/*`, auto-detected from this file's existence alone (no `vercel.json` route
 * config needed for the function itself; see `vercel.json` at the repo root only for this
 * route's extended `maxDuration`, since translation can legitimately take longer than a
 * default serverless timeout). `server/index.js` remains the local-dev entry point
 * (`node server/index.js`, per README) — this file is a second, independent adapter for the
 * exact same business logic, not a replacement.
 *
 * Zero duplicated logic: both this file and `server/routes/translate.js` (the Express
 * adapter) import the identical `streamTranslate`/`normalizeStylePreset`/`normalizeMyStyle`
 * from `server/lib/translate.js` and `readCredential` from `server/lib/credential-store.js`
 * — only the request/response plumbing differs between the two adapters.
 *
 * Same-origin by construction: once deployed, the static frontend (index.html etc.) and
 * this function are served from the same Vercel domain, so `js/translation-client.js`'s
 * default same-origin fetch (`config/voice-config.example.js`'s `SERVER_BASE_URL = ''`)
 * reaches this function with zero CORS configuration needed — unlike the local dedicated
 * server, which needs `VOICE_COPILOT_ALLOWED_ORIGIN` because local dev commonly serves the
 * page from a different origin than the API. This function does not set any CORS headers
 * at all, on purpose: it is not meant to be called cross-origin.
 */

import { streamTranslate, normalizeStylePreset, normalizeMyStyle } from '../server/lib/translate.js';
import { readCredential } from '../server/lib/credential-store.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

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
    res.status(500).json({
      error: 'Translation/LLM Provider Credential is not configured — set GEMINI_API_KEY in this Vercel project\'s Environment Variables',
    });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Upstream-abort handling (plan.md §8.3) — identical logic to server/routes/translate.js's
  // Express adapter; Vercel's Node.js runtime `res` is a standard http.ServerResponse, so the
  // same 'close' event semantics apply.
  let aborted = false;
  const upstreamAbort = new AbortController();
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
    console.error('[api/translate-stream] failed:', err?.message || err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'Translation failed' });
    } else {
      res.write(`data: ${JSON.stringify({ error: err.message || 'Translation failed' })}\n\n`);
      res.end();
    }
  }
}
