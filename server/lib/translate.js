/**
 * streamTranslate() — stateless, one-shot Chinese -> English translation via Gemini
 * (spec.md §9, plan.md §8.1).
 *
 * A fresh GoogleGenAI instance is created per call — this is deliberately NOT the
 * Live2D project's shared app.js client, and NOT its GEMINI_API_KEY. A Voice Copilot
 * user may configure a different Gemini account/key entirely (plan.md §5 reuse matrix,
 * §9.2). No history, no session caching: every call is independent, matching spec
 * §9.1/§9.5's "一次性、单向、无上下文记忆".
 */

import { GoogleGenAI } from '@google/genai';

const MODEL = 'gemini-3.1-flash-lite';

const FIXED_TRANSLATION_INSTRUCTION =
  'You are a translation engine. Translate the given Chinese text into natural, spoken ' +
  'English suitable for a business meeting or status update. Output only the English ' +
  'translation — no commentary, no quotation marks, no explanation. Use standard ' +
  'sentence-ending punctuation so the output can be split into sentences.';

function isTransientError(err) {
  const status = err?.status || err?.response?.status;
  return status === 503 || status === 429 || /overloaded|unavailable|resource_exhausted/i.test(err?.message || '');
}

/**
 * @param {string} chineseText
 * @param {{ apiKey: string, signal?: AbortSignal }} options
 * @yields {{ content: string }}
 */
export async function* streamTranslate(chineseText, { apiKey, signal }) {
  // Smaller than app.js's geminiChatStream deliberately (plan.md §8.2): translation has
  // no multi-turn session to protect, so at most one silent retry, and only before any
  // content has been yielded to the caller for this call.
  const MAX_ATTEMPTS = 2;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let emitted = false;
    try {
      const client = new GoogleGenAI({ apiKey });
      // `config.abortSignal` (plan.md §8.3's upstream-abort handling): without this, an
      // abort that arrives while this call is still awaiting its *first* response has
      // nothing to interrupt it — the for-await loop in routes/translate.js only gets a
      // chance to check its own `aborted` flag once a chunk is actually yielded, which
      // could be arbitrarily late for a slow/stalled upstream call. Passing the signal
      // straight into the SDK call lets it cancel the underlying HTTP request itself,
      // not just gate what we do with chunks after the fact.
      const stream = await client.models.generateContentStream({
        model: MODEL,
        contents: [{ role: 'user', parts: [{ text: chineseText }] }],
        config: { systemInstruction: FIXED_TRANSLATION_INSTRUCTION, abortSignal: signal },
      });

      for await (const chunk of stream) {
        if (chunk.text) {
          emitted = true;
          yield { content: chunk.text };
        }
      }
      return;
    } catch (err) {
      // An abort must never be retried, regardless of how it happens to surface from the
      // SDK (name/message vary by cause) — retrying would defeat the whole point of
      // wiring the signal through in the first place.
      if (signal?.aborted || emitted || attempt >= MAX_ATTEMPTS || !isTransientError(err)) {
        throw err;
      }
      // silent retry — nothing yielded yet for this call, safe to redo from scratch
    }
  }
}
