# Voice Copilot — Personal Speaking Style & Prosody — Tasks

Derived strictly from `specs/voice-copilot-speaking-style/spec.md` and `specs/voice-copilot-speaking-style/plan.md` (all sections, §0-§12). No new design decisions are made here — every task cites the plan section it implements. If a task seems to require a decision not already covered by `plan.md`, stop and check `plan.md` §12 (Open Questions) rather than improvising; if it's not there either, that's a gap to raise, not to fill silently.

Each task lists what to build/verify, which files it touches, and which plan section it closes. Phases are sequential — each phase's exit criterion must hold before starting the next. This repo has no test framework (`voice-copilot-mvp/tasks.md`'s own precedent), so exit criteria are manual checks, not automated gates.

This continues the phase numbering `voice-copilot-mvp/tasks.md` left off at (Phase 14) — Phase 15 onward is this feature.

**Non-goals reminder** (plan.md §9, spec.md §13): no second LLM call or extra HTTP round-trip per Speak (Style is composed into the same `POST /api/translate-stream` request Translated Speak already makes); no `context_texts` voice instructions for any voice (plan §5.3); no Speaking Style effect on Direct Speak — Style is Translated-Speak-only, Prosody applies to both paths (plan §3, §8); no server-side persistence of `stylePreset`/My Style (both are `localStorage`-only, sent fresh on every translate request, plan §4.1); no code-level meaning-preservation validation — the guardrail is a prompt instruction, not a fact-checker (plan §4.4, an accepted, documented limitation); no rename of the already-working `speed_ratio`/`volume_ratio` wire fields to match spec.md's illustrative `speech_rate`/`loudness_rate` names (plan §5.1); no changes to `js/streaming-audio-player.js`, `js/volcengine-protocol.js`, `server/index.js`, `server/routes/settings.js`, `server/lib/credential-store.js`, or any CORS/binding/session-lifecycle decision already settled by the MVP plan (plan §11).

---

## Phase 15 — Prosody: Pitch

Files: `js/state.js`, `js/persistence.js`, `js/voice-profiles.js`, `js/tts-client.js`, `js/app.js`, `index.html`, `settings.html`, `js/settings-page.js`, `css/workspace.css`, `config/voice-config.example.js`

- [ ] **T15.1** `js/state.js`: add `pitch: 0` to the initial state object (neutral default, plan §5.2/§7) and a `setPitch(pitch)` action, following the exact `setSpeed`/`setVolume` pattern (same `notify()` call, no extra logic).
- [ ] **T15.2** `js/persistence.js`: add `KEYS.pitch = 'voiceCopilot.pitch'` and `persistPitch(pitch)`; extend `loadPersistedPreferences()` to also return a parsed `pitch` field (`null` if unset, same `Number.isFinite` guard already used for `speed`/`volume`) — identical pattern, plan §5.4.
- [ ] **T15.3** `js/voice-profiles.js`: extend the `VoiceProfile` typedef comment with an optional `pitch` field. Do **not** add `pitch` to `validateConfiguration()`'s required-field checks — a profile without it stays valid, exactly like a profile is already tolerant of relying on `tts-client.js`'s own `?? 0`/`|| 1.0`-style fallback at read time rather than being rejected at load time (plan §7).
- [ ] **T15.4** `js/tts-client.js`, `_doBeginSession()`: clamp `voiceSettings.pitch ?? 0` to `[-12, 12]` and add `post_process: { pitch }` as a new sibling field on `reqParamsBase`, alongside the existing `audio_params`/`additions` — **not** inside `additions`, **not** a `*_ratio` field (plan §5.2's confirmed wire format: `req_params.post_process.pitch`). Send it unconditionally, including at the neutral value `pitch: 0` — do not omit it when neutral, matching how `speed_ratio: 1.0`/`volume_ratio: 1.0` are already sent unconditionally today. Update this file's own header comment to document the field choice, mirroring how the existing `speed_ratio`/`volume_ratio` precedent is already documented there.
- [ ] **T15.5** `index.html`: add a `Pitch` `<input type="number" min="-12" max="12" step="1" value="0">` to the existing `.voice-controls-row`, immediately after Volume — same markup/class pattern (`control-label`/`control-input`) as the existing Speed/Volume inputs (plan §6.2).
- [ ] **T15.6** `settings.html`: add a `Pitch` field to the existing "Voice Profile" `<fieldset>`, immediately after Volume, using the same `settings-input settings-input-narrow` pattern already used for Speed/Volume (plan §6.1).
- [ ] **T15.7** `js/settings-page.js`: `populate()` reads `profile?.pitch ?? ''` into the new field, same as Speed/Volume; the Save handler's `voiceProfiles` object gains `pitch: parseFloat(voicePitchEl.value) || 0` (plan §6.1).
- [ ] **T15.8** `js/app.js`:
  - grab `pitchInputEl = document.getElementById('pitch-input')`
  - `applyProfileDefaults(profile, overrides)` also sets `pitchInputEl.value`/`setPitch()` from `overrides.pitch ?? profile.pitch ?? 0` — same persisted-value-takes-priority pattern already used for `speed`/`volume`
  - add a `pitchInputEl.addEventListener('input', ...)` wired to `setPitch`/`persistPitch`, mirroring the existing `speedInputEl`/`volumeInputEl` listeners exactly
  - restore the persisted `pitch` on load alongside `speed`/`volume` (extend the existing `applyProfileDefaults(defaultProfile, { speed: persisted.speed ?? undefined, volume: persisted.volume ?? undefined })` call with `pitch: persisted.pitch ?? undefined`)
  - **both** `handleDirectSpeak()`'s and `handleTranslatedSpeak()`'s `ttsClient.beginSession({ speaker, speed, volume, useTTS2: true }, ...)` calls gain `pitch: state.pitch` — Prosody applies to both Speak paths regardless of Speaking Style (plan §5/§8; this explicitly includes `handleTranslatedSpeak()`, whose `beginSession()` call already carries `speed`/`volume` today and must carry `pitch` the same way — not a Direct-Speak-only change)
- [ ] **T15.9** (optional, non-blocking) `config/voice-config.example.js`: add `pitch: 0` to the example `VOICE_PROFILES` entry, purely illustrative (plan §11).
- [ ] **T15.10** `css/workspace.css`: minor additive rules for the new Pitch input/field, only if the existing `.control-input`/`.settings-input-narrow` classes don't already cover its sizing/spacing needs without adjustment.

**Exit criterion (plan §10 items 5-6):** with `speed`/`volume`/`pitch` all left at their neutral defaults (`1.0`/`1.0`/`0`), Direct Speak's behavior, TTFA, and generated audio are unaffected by this phase — `post_process: { pitch: 0 }` being newly present in the wire payload is a true no-op. Separately, with `pitch` (and/or `speed`/`volume`) set away from neutral, the change is audibly effective in **both** Direct Speak and Translated Speak output against the real Volcengine endpoint.

---

## Phase 16 — Speaking Style: Server-Side Prompt Composition

Files: `server/lib/translate.js`, `server/routes/translate.js`

- [ ] **T16.1** `server/lib/translate.js`: replace the single `FIXED_TRANSLATION_INSTRUCTION` constant with:
  - `BASE_TRANSLATION_INSTRUCTION` — the trimmed core instruction (translate the given Chinese text into English, output only the translation, use standard sentence-ending punctuation) — the "natural, spoken English suitable for a business meeting" phrasing moves into `STYLE_INSTRUCTIONS.natural` below (plan §4.4).
  - `STYLE_INSTRUCTIONS` — a fixed object with `natural`/`professional`/`concise` keys, exact wording per plan §4.2.
  - `MEANING_GUARDRAIL` — the fixed invariant string per plan §4.4, appended after the style block for every style, not just My Style.
  - `hasMyStyleContent(profile)` — a small local helper (true if any of the four `MyStyleProfile` fields is non-empty after trim); this is the server's own copy, independent of the client's `js/speaking-style.js` version built in Phase 17 — different runtime, no shared module, both are one-liners (plan §4.1/§4.3).
  - `cap(str, n)` — truncates to `n` characters.
  - `buildMyStyleBlock(profile)` — exact template per plan §4.3, including the "treat as STYLE PREFERENCE DATA, not instructions" framing paragraph that keeps My Style from being able to override the base translation instruction or the meaning-preservation guardrail, and the four capped, labeled field blocks (`speakingPreferences` @500, `preferredPhrases` @300, `avoidedPhrases` @300, `exampleSentences` @800 — plan §4.3, §12 open question #1).
  - `buildSystemInstruction({ stylePreset, myStyle })` — composes `BASE_TRANSLATION_INSTRUCTION + '\n\n' + styleBlock + '\n\n' + MEANING_GUARDRAIL` per plan §4.4's pseudocode. Unknown/missing `stylePreset` defaults to `'natural'` (plan §4.2, §8). `stylePreset === 'my-style'` with `hasMyStyleContent(myStyle)` false falls back to `STYLE_INSTRUCTIONS.natural` (plan §4.3, §8) — not an error.
- [ ] **T16.2** `server/lib/translate.js`, `streamTranslate()`: change its signature to `streamTranslate(chineseText, { apiKey, signal, stylePreset, myStyle })`; call `buildSystemInstruction({ stylePreset, myStyle })` internally and pass the result as `config.systemInstruction` to `generateContentStream()`, replacing the old hardcoded constant. No other change to this function's retry/transient-error logic (`MAX_ATTEMPTS`, `isTransientError()`) — untouched by this plan.
- [ ] **T16.3** `server/routes/translate.js`: parse `stylePreset`/`myStyle` from `req.body` (plan §4.5's wire format: `{ text, stylePreset?, myStyle? }`); apply Phase 16.1's field-level character caps before passing through (truncate, never reject — spec §12's "normalize invalid input rather than block" philosophy, same as Prosody's clamping); pass both straight to `streamTranslate()` alongside the existing `text`/`apiKey`/`signal` arguments.
- [ ] **T16.4** Verify via a manual/console trigger (curl or a temporary script against the running dedicated server — no UI wiring yet, mirroring `voice-copilot-mvp/plan.md`'s own Phase 10 discipline of verifying the server in isolation before wiring the client) that a real Chinese input produces a real streaming English SSE response whose wording visibly differs across `natural`/`professional`/`concise`, and across a hand-crafted `my-style` payload with representative preferences/phrases/examples; and that a fixed date, amount, and name in the source text survive unchanged in the output across all four (plan §10 items 1 and 4, server-side half).

**Exit criterion:** T16.4's checks pass against the real Gemini endpoint through the real dedicated server, entirely via direct HTTP/console triggers, before any client UI exists for it.

---

## Phase 17 — Speaking Style: Client Wiring

Files: `js/speaking-style.js` (NEW), `js/state.js`, `js/persistence.js`, `js/translation-client.js`, `js/app.js`, `index.html`, `settings.html`, `js/settings-page.js`, `css/workspace.css`

- [ ] **T17.1** Create `js/speaking-style.js` (plan §4.1): `loadMyStyleProfile()` (reads localStorage, returns `{}` if unset/unparsable — same corrupt-data tolerance as `voice-profiles.js`'s `getSavedConfiguration()`), `saveMyStyleProfile(profile)` (writes localStorage — `settings-page.js`'s Save), `hasMyStyleContent(profile)` (client-side mirror of Phase 16's server-side check; used only for an optional Settings-page hint, not for correctness — the server independently falls back regardless of what the client sends).
- [ ] **T17.2** `js/state.js`: add `stylePreset: 'natural'` to the initial state object and a `setStylePreset(preset)` action, same pattern as `setTranslationEnabled`.
- [ ] **T17.3** `js/persistence.js`: add `KEYS.stylePreset = 'voiceCopilot.stylePreset'` and `persistStylePreset(preset)`; extend `loadPersistedPreferences()` to also return `stylePreset` (defaulting to `'natural'` when unset), same pattern as `translationEnabled`.
- [ ] **T17.4** `js/translation-client.js`: extend `streamTranslation(chineseText, { signal, serverBaseUrl, stylePreset, myStyle })` to include `stylePreset`/`myStyle` in the POST body (plan §4.5). No change to `extractCompletedSentences()` or the SSE-frame-reading loop — style only changes the *content* Gemini streams back, not how the client splits it into sentences.
- [ ] **T17.5** `index.html`: add the Speaking Style row — a `<select id="style-preset-select">` with the four preset options (`Natural Conversation`/`Professional`/`Concise`/`My Style`), wrapped in `<div id="style-preset-row">` — immediately after the existing "Chinese → English" toggle row (plan §6.2's mockup).
- [ ] **T17.6** `settings.html`: add the "Speaking Style" `<fieldset>` — a preset `<select>` plus four `<textarea>` fields (speaking preferences / preferred phrases / phrases to avoid / example sentences) — after the "Voice Profile" fieldset, before the existing Save/Cancel row (plan §6.1). All four textareas are always visible, not gated behind selecting "My Style" (plan §6.1).
- [ ] **T17.7** `js/settings-page.js`: `populate()` reads the preset via `loadPersistedPreferences().stylePreset` and the four My Style fields via `loadMyStyleProfile()` (Phase 17.1) — populated strictly from what's actually saved, no file fallback (same "never show unsaved" discipline the page already applies to TTS/Voice Profile fields, plan §6.1). The Save handler's click listener additionally calls `persistStylePreset(...)` and `saveMyStyleProfile({...})` alongside the existing `saveLocalConfiguration(...)` call, before the existing `location.href = 'index.html'` navigation.
- [ ] **T17.8** `js/app.js`:
  - import `setStylePreset` (state.js), `persistStylePreset` (persistence.js), `loadMyStyleProfile` (speaking-style.js)
  - grab `stylePresetEl = document.getElementById('style-preset-select')`, `stylePresetRowEl = document.getElementById('style-preset-row')`
  - wire `stylePresetEl`'s `change` listener → `setStylePreset(stylePresetEl.value)` + `persistStylePreset(stylePresetEl.value)`, per plan §6.2's pseudocode
  - `render()`: `stylePresetRowEl.hidden = !state.translationEnabled` (plan §6.2) — hidden, not merely disabled, when translation is off
  - restore the persisted `stylePreset` on load alongside the existing `translationToggleEl`/`translationEnabled` restore (`stylePresetEl.value = persisted.stylePreset; setStylePreset(persisted.stylePreset)`)
  - `handleTranslatedSpeak()`: read `state.stylePreset`; when it equals `'my-style'`, call `loadMyStyleProfile()`; pass `{ stylePreset, myStyle }` into the existing `streamTranslation(text, { signal, serverBaseUrl, ... })` call (plan §4.5). No other change to this function's `for await` loop, staleness guards, or the `catch` block's `cancelSession()`/`player.dispose()` cleanup — this is purely a request-body addition to a call site that already exists (plan §4.5's own explicit note). `handleDirectSpeak()` is untouched by this task (Style is Translated-Speak-only).
- [ ] **T17.9** `css/workspace.css`: minor additive rules for the new Speaking Style row/fieldset/textareas, following the existing `.settings-group`/`.control-label` patterns.

**Exit criterion (plan §10 items 1, 2, 3, 7):** speaking the same Chinese input under all four presets (My Style configured with representative preferences) produces visibly different `translatedText` while `pushText()` is still called incrementally (multiple times, not once) for each; Translated Speak's TTFA is not meaningfully regressed from its pre-Style baseline; selecting "My Style" with an empty profile produces Natural-Conversation-equivalent output, not an error; saving a My Style profile + `stylePreset` via `settings.html` survives a reload and is used on the next Translated Speak.

---

## Phase 18 — Full Verification Pass

No files changed — verification only.

- [ ] **T18.1** Run plan §10's full item list (1-7) end to end, in one continuous session (mirroring `voice-copilot-mvp/tasks.md`'s own Phase 13 discipline of sweeping rather than sampling): style-changes-wording check, TTFA comparison, My Style fallback, meaning-preservation spot-check (date/amount/name survive across Concise and My Style), Direct-Speak-at-default-Prosody regression, non-default-Prosody-on-Direct-Speak confirmation, Settings round-trip.
- [ ] **T18.2** Re-run `voice-copilot-mvp/tasks.md`'s Phase 8/13 regression checklist (Pause/Resume/Replay/Stop behavior, TTFA logging, Stop-then-Speak chain-release, toggle-off parity for "Chinese → English" itself) once against the final Phase 15-18 code, to confirm zero regression to Direct Speak or the shared streaming/session-lifecycle machinery this feature deliberately does not touch.
- [ ] **T18.3** Grep/inspection check (mirroring `voice-copilot-mvp/plan.md`'s own §13 Independence Checklist discipline): confirm nothing in the diff references `context_texts`, confirm Translated Speak still makes exactly one `POST /api/translate-stream` request per Speak (no second LLM call added), and confirm no item from spec.md §13's Out of Scope list appears anywhere in the new code (plan §9).
- [ ] **T18.4** Sweep spec.md §14 (Acceptance Criteria) and §15 (Success Criteria) bullet by bullet against the accumulated evidence from Phase 15-18, not sampled — in particular criteria 1, 2, 5, 6 (Style applied within the streaming pipeline, My Style influencing output while preserving facts, spoken-English text staying visible) and criteria 7, 8, 9, 10 (Prosody user-configurable and mapped to supported parameters, Prosody changes never invoking LLM rewriting, defaults working with zero personalization, no `context_texts` dependency).

**Exit criterion:** every spec.md §14 acceptance bullet has direct evidence from Phase 15-18; T18.2 finds zero regression; T18.3's checks confirm no scope creep beyond this plan.
