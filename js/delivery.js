/**
 * delivery.js — Natural Delivery (specs/voice-copilot-natural-delivery, plan.md §2.1).
 *
 * The one place that knows how a Delivery level maps onto the Volcengine TTS wire payload,
 * plus the word-safe text chunker used by the LLM Speak paths. Pure functions only — no
 * DOM, no network — so test/test-natural-delivery.js can import this file under Node.
 *
 * Why these choices (all measured, research.md):
 *  - Off reproduces the pre-feature payload byte-for-byte (rollback / A/B baseline).
 *  - Light/Natural drop `model`: the provider docs state a clone voice with `model` set
 *    does not accept `context_texts`, and no model variant measurably beat the default
 *    model on this clone (E2).
 *  - `context_texts` carries ONE conversational delivery instruction — the provider only
 *    honours the first element. It never lost a blind pairwise comparison (E2/E3).
 */

export const DELIVERY_LEVELS = Object.freeze(['off', 'light', 'natural']);
export const DEFAULT_DELIVERY = 'natural';

export function normalizeDelivery(value) {
  return DELIVERY_LEVELS.includes(value) ? value : DEFAULT_DELIVERY;
}

// Written in Chinese like the provider's own voice-instruction examples; applies to English
// text as well (research.md E3 measured it on English output).
export const TTS_DELIVERY_INSTRUCTION =
  '像在轻松的视频会议里跟同事自然交谈一样说话，语气真诚随意，有自然的停顿和语调起伏，不要像在朗读。';

/**
 * @param {string} delivery 'off' | 'light' | 'natural'
 * @returns {{ model?: string, additions: object }} `additions` is an object here; the
 *   caller JSON-stringifies it (the wire format requires a string).
 */
export function buildTtsDeliveryParams(delivery) {
  if (normalizeDelivery(delivery) === 'off') {
    return {
      model: 'seed-tts-2.0-expressive',
      additions: { disable_markdown_filter: true, use_tag_parser: true },
    };
  }
  return {
    additions: { disable_markdown_filter: true, context_texts: [TTS_DELIVERY_INSTRUCTION] },
  };
}

// Any whitespace or punctuation after which it is safe to cut (ASCII + CJK).
const BOUNDARY_RE = /[\s.,!?;:—…。，、；：！？]/;
// Safety valve for long CJK runs with no punctuation, keeps worst-case latency bounded.
const MAX_HELD_CHARS = 40;

/**
 * Word-safe incremental chunker for LLM deltas (plan.md §2.1, spec.md §3.3). The provider
 * segments sentences itself with lookahead (research.md E4b), so text should reach it as
 * early as possible — but never with a word cut in half across two TaskRequests.
 */
export function createSpeakableChunker() {
  let buffer = '';
  return {
    /** @param {string} delta @returns {string[]} zero or one chunk ready to push */
    push(delta) {
      buffer += delta;
      let cut = -1;
      for (let i = buffer.length - 1; i >= 0; i--) {
        if (BOUNDARY_RE.test(buffer[i])) { cut = i + 1; break; }
      }
      if (cut <= 0 && buffer.length > MAX_HELD_CHARS) cut = buffer.length;
      // Whitespace-only prefixes stay buffered, so the separator still reaches the provider
      // ahead of the next word.
      if (cut <= 0 || !buffer.slice(0, cut).trim()) return [];
      const chunk = buffer.slice(0, cut);
      buffer = buffer.slice(cut);
      return [chunk];
    },
    /** @returns {string} whatever is still held (may be '') */
    flush() {
      const rest = buffer;
      buffer = '';
      return rest.trim() ? rest : '';
    },
  };
}
