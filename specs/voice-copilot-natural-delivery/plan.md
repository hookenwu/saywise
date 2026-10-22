# Voice Copilot — Natural Delivery — Plan

Derived from `spec.md`. Evidence for every choice is in `research.md`.

## 1. Data flow after this change

```text
Direct Speak (Humanize off)   Speech Text ───────────────────────────────┐
Direct Speak (Humanize on)    Speech Text → LLM rewrite (same language) ─┤ word-safe
Translated Speak              Chinese → LLM translate + Style + Delivery ┘ chunk pushes
                                                                          ↓
                         TTS session: Delivery → payload (Off: legacy | Light/Natural: context_texts)
                                                                          ↓
                         MP3 chunks → StreamingAudioPlayer + Audio Bridge (unchanged)
```

## 2. Files

### 2.1 `js/delivery.js` (new, browser)
- `DELIVERY_LEVELS = ['off', 'light', 'natural']`, `DEFAULT_DELIVERY = 'natural'`,
  `normalizeDelivery(v)`.
- `TTS_DELIVERY_INSTRUCTION`: the single `context_texts` string. Written in
  Chinese, as in the provider's own examples; it applies to English output too
  (`research.md` E3).
- `buildTtsDeliveryParams(delivery)` → `{ model?, additions }`: the only place
  that knows the legacy vs. new wire shape.
- `createSpeakableChunker()` → `{ push(delta): string[], flush(): string }`:
  emits everything up to the last whitespace or punctuation (ASCII and CJK,
  including `，、；：`). A trailing partial word stays buffered. If no boundary
  turns up for more than 40 chars (a CJK run with no punctuation), it emits
  anyway, so latency stays bounded.

### 2.2 `js/tts-client.js`
- `voiceSettings.delivery` replaces `useTTS2`. `useTTS2: true` without
  `delivery` maps to `'off'`, so existing callers and tests keep their exact
  legacy payload.
- `reqParamsBase` is built from `buildTtsDeliveryParams()`. Everything else
  (speech rate, loudness, pitch, format) is unchanged.

### 2.3 `server/lib/translate.js`
- `buildDeliveryBlock(level, outputLang)` builds the Light/Natural spoken-script block
  with a one-shot Written → Spoken example. Flash-lite under-applies the rules without
  one (`research.md` E6a). The vocabulary (markers, fillers, banned hedges) and the
  example come **only in the output language**. Mixing languages made Humanize switch
  languages (E6c). The block also includes the "exact figures stay exact" rule (E6d).
- `detectLanguage(text)` returns `'zh'` when CJK characters make up at least 1/3 as many
  as Latin letters, otherwise `'en'`. Translate mode always outputs English; rewrite mode
  outputs the input's language and appends a language lock.
- `REWRITE_INSTRUCTION`: base task for `mode: 'rewrite'` (same language, no
  translation, meaning preserved).
- `buildSystemInstruction({ stylePreset, myStyle, delivery, mode })` composes
  base (translate | rewrite) + style (translate only) + delivery block (unless
  `off`) + meaning guardrail. The guardrail always comes last.
- `normalizeDelivery`, `normalizeMode` are exported and shared by
  `server/routes/translate.js` and `api/translate-stream.js`.
- `delivery: 'off'` with `mode: 'translate'` must yield exactly the legacy
  system instruction (unit-tested).

### 2.4 `js/translation-client.js`
- `streamTranslation(text, { ..., delivery, mode })` adds the two fields to
  the request body.
- `extractCompletedSentences` stays exported (unchanged) for compatibility.
  `app.js` stops using it.

### 2.5 `js/state.js`, `js/persistence.js`
- State: `delivery: 'natural'`, `humanizeEnabled: true` (default on; only a persisted `'false'` turns it off), with setters.
- Persistence: `voiceCopilot.delivery` (allowlist-validated) and
  `voiceCopilot.humanizeEnabled`.

### 2.6 `js/app.js`
- Both `beginSession` calls pass `delivery: state.delivery`.
- `handleSpeak()`: translation on → `handleLlmSpeak('translate')`; else
  Humanize on and Delivery ≠ off → `handleLlmSpeak('rewrite')`; else
  `handleDirectSpeak()`.
- `handleTranslatedSpeak()` becomes `handleLlmSpeak(mode)`. Its body is
  unchanged except for (a) passing `mode`/`delivery`, and (b) using the
  chunker instead of sentence extraction. Guards, staleness checks, cleanup
  and error typing are untouched.
- Render: the text panel is shown for either LLM mode; its label is
  "Translated Text" or "Spoken Text"; the status line says "Translating…" or
  "Rewriting…"; the Humanize row is hidden while translation is on.

### 2.7 `index.html`
- "Delivery" `<select>` (Off / Light / Natural) in the controls section, plus a
  "Humanize" checkbox row. Reuses the existing `control-label` /
  `style-preset-select` / `translation-toggle` classes; no CSS changes
  needed.
- The text panel's `<label>` gets an id so its text can change.

### 2.8 Unchanged (R6)
`js/streaming-audio-player.js`, `js/audio-bridge-client.js`,
`server/lib/audio-bridge.js`, `injector/**`, `js/volcengine-protocol.js`.

## 3. Verification

1. `node test/test-natural-delivery.js`: unit tests for the chunker, the
   payload builder (Off = legacy, byte-for-byte), prompt composition
   (Off/translate = legacy), and the normalizers.
2. `node test/test-audio-bridge.js`: existing suite, must still pass.
3. `test/naturalness/`: end-to-end A/B on the real endpoints, run through the
   **shipped** `js/tts-client.js` and `server/lib/translate.js` (not the
   research harness). Baseline (legacy) vs. new default, for both Direct
   Speak and Translated Speak. Results go to `research.md` §5.
4. Browser smoke test (Chromium via puppeteer-core, already a dev
   dependency): the page loads, the new controls render and persist, and
   Direct Speak plays with the Delivery levels.
