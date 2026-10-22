# Voice Copilot — Natural Delivery — Tasks

Derived from `plan.md`. Phase numbering continues from `voice-copilot-speaking-style/tasks.md`.

## Phase 19 — Research & measurement ✅
- [x] T19.1 Raw V3 bidirectional harness + objective evaluation (UTMOS22, ECAPA speaker similarity, Whisper error rate, Praat prosody) + blind pairwise audio-LLM judge (both orders). → `test/naturalness/`
- [x] T19.2 Experiments E1–E6 (parameter detection, model screening, text register, push granularity, pause shaping, bitrate, prompt adherence). → `research.md`

## Phase 20 — TTS-side Delivery ✅
- [x] T20.1 `js/delivery.js`: levels, normalizer, TTS instruction, `buildTtsDeliveryParams`, `createSpeakableChunker` (plan §2.1)
- [x] T20.2 `js/tts-client.js`: `delivery` replaces `useTTS2` (legacy-compatible mapping) (plan §2.2)

## Phase 21 — LLM-side Delivery + Humanize ✅
- [x] T21.1 `server/lib/translate.js`: delivery blocks, rewrite mode, composition order, normalizers (plan §2.3)
- [x] T21.2 `server/routes/translate.js`, `api/translate-stream.js`: pass normalized `delivery`/`mode` (plan §2.3)
- [x] T21.3 `js/translation-client.js`: request fields (plan §2.4)

## Phase 22 — Client wiring ✅
- [x] T22.1 `js/state.js`, `js/persistence.js` (plan §2.5)
- [x] T22.2 `index.html` controls (plan §2.7)
- [x] T22.3 `js/app.js`: dispatcher, `handleLlmSpeak(mode)`, chunked pushes, render labels (plan §2.6)

## Phase 23 — Verification ✅
- [x] T23.1 `test/test-natural-delivery.js` unit tests
- [x] T23.2 `test/test-audio-bridge.js` regression
- [x] T23.3 End-to-end A/B through the shipped modules, results recorded in `research.md` §5
- [x] T23.4 Browser smoke test
