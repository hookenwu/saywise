/**
 * translation-client.js — SSE consumption + sentence-chunk buffering for the optional
 * Chinese -> English Translated Speak path (spec.md §9, plan.md §8.3).
 *
 * Reimplemented independently of public/js/streaming-response-handler.js (plan.md §5
 * reuse matrix) — same SSE-over-fetch mechanics adapted, no shared code, no
 * LLM-response-format parsing (emoji/内心活动/对话回应), no Live2D coupling of any kind.
 *
 * `serverBaseUrl` is passed in explicitly by the caller (app.js, Phase 11) rather than
 * imported directly from config here — mirrors how tts-client.js receives its
 * ProviderConfiguration as a constructor argument instead of importing config itself,
 * keeping config-loading/error-banner responsibility solely in voice-profiles.js.
 * Default `''` matches plan.md §8.3's same-origin-by-default decision.
 */

const SENTENCE_RE = /[^。！？.!?\n]*[。！？.!?\n]+/g;

// chars; safety valve if no terminator arrives (tunable, plan.md §18 open question #2 —
// not a spec-mandated number).
const MAX_BUFFER_BEFORE_FORCED_FLUSH = 100;

export class TranslationError extends Error {
  constructor(message, options) {
    super(message);
    this.name = 'TranslationError';
    this.isTranslationError = true;
    if (options?.cause) this.cause = options.cause;
  }
}

/**
 * Splits a growing text buffer into completed sentences plus a remainder, using the
 * same split-on-terminator technique as the Live2D reference implementation's
 * `_sentenceBuf` (adapted logic, not the file — plan.md §5 reuse matrix).
 *
 * @param {string} buffer
 * @returns {{ sentences: string[], remainder: string }}
 */
export function extractCompletedSentences(buffer) {
  const sentences = [];
  let lastIndex = 0;
  let match;

  SENTENCE_RE.lastIndex = 0;
  while ((match = SENTENCE_RE.exec(buffer)) !== null) {
    sentences.push(match[0]);
    lastIndex = SENTENCE_RE.lastIndex;
  }

  let remainder = buffer.slice(lastIndex);

  // Forced-flush safety valve (plan.md §8.3, §14 risk #1): bounds worst-case TTFA/buffer
  // growth when the model produces a long run with no sentence terminator.
  if (remainder.length > MAX_BUFFER_BEFORE_FORCED_FLUSH) {
    sentences.push(remainder);
    remainder = '';
  }

  return { sentences, remainder };
}

/** Reads an SSE body, yielding each frame's raw `data: ...` payload string. */
async function* sseFrames(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const emitFrom = function* (chunkText) {
    const line = chunkText.split('\n').find((l) => l.startsWith('data: '));
    if (line) yield line.slice(6);
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop(); // last part may be an incomplete frame — keep it for the next read
    for (const part of parts) yield* emitFrom(part);
  }
  if (buffer) yield* emitFrom(buffer);
}

/**
 * @param {string} chineseText
 * @param {{ signal?: AbortSignal, serverBaseUrl?: string, stylePreset?: string, myStyle?: object }} [options]
 *   stylePreset/myStyle (speaking-style spec.md §4, plan.md §4.5) are optional — the server
 *   defaults stylePreset to 'natural' when omitted (server/routes/translate.js). Included
 *   here only as an addition to the request body; this function's SSE-consumption/
 *   sentence-chunking logic (extractCompletedSentences() below) is otherwise unchanged —
 *   Style only affects the *content* Gemini streams back, not how it's split into sentences.
 * @yields {{ content: string }}
 * @throws {TranslationError} on any fetch failure, non-OK response, or server-reported error frame
 */
export async function* streamTranslation(
  chineseText,
  { signal, serverBaseUrl = '', stylePreset, myStyle } = {}
) {
  let res;
  try {
    res = await fetch(`${serverBaseUrl}/api/translate-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: chineseText, stylePreset, myStyle }),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err; // caller's own abort (§7.3) — not a translation failure
    throw new TranslationError(`Failed to reach the translation server: ${err.message}`, { cause: err });
  }

  if (!res.ok) {
    let message = `Translation server returned HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch (_) {
      // non-JSON error body — fall back to the generic message above
    }
    throw new TranslationError(message);
  }

  for await (const payload of sseFrames(res.body)) {
    if (payload === '[DONE]') return;
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch (_) {
      continue; // malformed frame — skip rather than fail the whole round
    }
    if (parsed.error) throw new TranslationError(parsed.error);
    if (parsed.content) yield { content: parsed.content };
  }
}
