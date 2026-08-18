# Voice Copilot MVP Implementation Plan

Status: rewritten against the current `spec.md` (independent GitHub Repo + lightweight Node.js Runtime, Direct Speak / Translated Speak, §9's optional LLM Streaming Translation, §13's user-configurable Settings/Credential). No code in this pass. No `tasks.md` changes in this pass — Phase 1-8 in `tasks.md` remain `✅ Done` and describe already-shipped, already-verified code; this revision only plans the *new* work spec's three additions require. Everything from the previous revision that spec.md did not change (Streaming TTS / MediaSource-SourceBuffer architecture, Voice Profile shape, the `StreamingTTSClient`/`StreamingAudioPlayer` design, Direct Speak's wiring) carries forward as **already built and not to be re-architected** — this plan is additive on top of it, not a rewrite of it.

---

## 1. Plan Summary

Voice Copilot MVP Phase 1 (spec.md pre-this-revision) is complete and verified: `public/voice-copilot/` is a working Streaming-TTS personal-voice workspace — `StreamingTTSClient` (`js/tts-client.js`) drives one persistent Volcengine bidirectional WebSocket per page session, `StreamingAudioPlayer` (`js/streaming-audio-player.js`) plays `MediaSource`/`SourceBuffer`-backed audio starting from the first confirmed-playable range, and `js/app.js` wires Speak/Pause/Resume/Replay/Stop against a two-state-machine model in `js/state.js`. This is the foundation the current spec revision builds on, unchanged.

This revision adds three things, and this plan commits to concrete technical decisions for each (spec.md deliberately left these to `plan.md`, §9/§13/§14):

1. **A second Speak path — Translated Speak (spec §3.1, §9).** A new browser module (`js/translation-client.js`) consumes a Server-Sent-Events translation stream, buffers it into sentence-sized chunks using the same split-on-terminator technique the Live2D reference implementation uses for LLM output, and calls the *already-multi-call-capable* `StreamingTTSClient.pushText()` once per completed sentence — a capability that exists in the client today but Direct Speak never exercises (Direct Speak calls it exactly once). No changes to `tts-client.js`'s public contract are required.
2. **A new, dedicated, lightweight Node.js server — not `app.js` (spec §14).** `public/voice-copilot/server/` is a new, minimal Express app with its own `package.json`, independent of the Live2D project's dependencies and routes. Its only two jobs: (a) proxy the Chinese→English LLM streaming call so the LLM Provider's API key never reaches the browser, mirroring the *existing, already-accepted* asymmetry in this codebase where Volcengine TTS credentials are allowed client-side but Gemini/OpenAI/DeepSeek keys are not (§4.4 below); (b) hold the two Provider Credential stores (§13) behind a small settings API, so Settings becomes genuinely user-configurable rather than "edit a committed-adjacent file." This server can also serve the Voice Copilot static frontend itself, so `node server/index.js` alone is a fully independent way to run the whole app — the concrete implementation of spec §14.1's "should run independently."
3. **Settings becomes real (spec §13).** A Settings panel (new UI, currently a disabled placeholder button) lets the user fill in Voice/TTS Provider Credential, plus the Voice Profile fields and the "中文转英文" default. TTS credential storage moves from "browser dev config file only" to "localStorage, written by the Settings form" (the file becomes an optional first-run seed, not the only path). Translation/LLM Provider Credential is **not** part of this user-fillable Settings form (spec §13.1's exception) — it's a server-held deployment secret configured via the new server's `GEMINI_API_KEY` environment variable; Settings only ever displays whether it's configured, read-only, and is never sent back to the browser in plaintext.

Architecture stays deliberately small: one new Express app (a few hundred lines), one new browser module for translation consumption, one new UI panel, targeted additions to `state.js`/`app.js`. No database, no auth system, no message queue, no framework beyond Express — consistent with spec §14.1's "不引入不必要的复杂后端架构."

---

## 2. Spec Alignment

| spec.md section | Plan section |
|---|---|
| §1 Overview (repo independence, Node.js allowance, optional translation) | §1 Plan Summary, §4, §6 |
| §3.1 两条 Speak 链路 | §7 Speak Orchestration |
| §5.1 / §9.3 Provider Configuration concept split (two independent credential sets) | §9 Credential Architecture |
| §6, §7 (unchanged Streaming TTS / Audio Player) | §3 Existing Implementation Assessment — carried forward, not re-planned |
| §9 Optional Chinese → English Translation (all subsections) | §7 Speak Orchestration, §8 Translation Server, §8.3 Sentence Chunking |
| §9.4 Status / failure disambiguation | §7.4, §11 State Model Additions |
| §9.5 / §14.2 excluded Live2D business logic | §5 Reuse & Exclusion Matrix |
| §10 Out of Scope | §5 Reuse & Exclusion Matrix |
| §12 Main Workspace (toggle, Translated Text area) | §12 UI Structure Additions |
| §13 Settings / Configuration, §13.1-§13.3 | §9 Credential Architecture, §10 Settings UI |
| §14 Independent Runtime & Repository Relationship | §4 Independent Runtime Decision, §6 Project Structure, §15 Migration Checklist |
| §15/§16 Success/Acceptance Criteria (Scenario C, new bullets) | §16 Testing Strategy, §17 Implementation Phases |

---

## 3. Existing Implementation Assessment (carried forward, not re-planned)

Re-read in full for this revision: `js/app.js`, `js/state.js`, `js/tts-client.js`, `js/streaming-audio-player.js`, `js/voice-profiles.js`, `js/persistence.js`, `index.html`, `config/voice-config.example.js`. All of Phase 1-8 (`tasks.md`) is real, working, verified code — not a prototype to redo.

What this revision explicitly does **not** touch or re-architect:

* `StreamingTTSClient` (`tts-client.js`) — its session lifecycle (`connect`/`beginSession`/`pushText`/`endSession`/`cancelSession`), the forced-disconnect-on-cancel decision (T3.5a), and the two real concurrency bugs already found and fixed (Phase 6 notes) are unchanged. **Crucially, `pushText()` already supports being called multiple times per session** — nothing in its implementation assumes single-call use; Direct Speak simply never needed more than one call. Translated Speak (§7) uses this exact same method, called in a loop, with zero client changes.
* `StreamingAudioPlayer` (`streaming-audio-player.js`) — sole owner of the `<audio>` element, `firstPlayableReady` gating, the `'playing'`-event-based TTFA measurement, the Stop/dispose sequence. Unchanged; Translated Speak feeds it chunks exactly the same way Direct Speak does (`onChunk` from `tts-client.js`, indifferent to whether the text that produced those chunks was pushed once or many times).
* `state.js`'s two-state-machine model (`generationStatus`/`playbackStatus`) — kept as the single status vocabulary for both Speak paths, per spec §9.4's explicit "不新增独立于翻译的第三套状态机." Extended, not replaced (§11).
* `js/app.js`'s `teardownCurrentRound()`/interrupt-and-restart pattern (T6.4/T6.5) — reused as-is as the shared teardown for both Speak paths; extended only to also cancel an in-flight translation fetch (§7.3).
* Voice Profile shape, Provider Configuration concept split, `voice-profiles.js`'s validation-and-banner pattern — unchanged in shape; its *loading source* changes (§9.1), not its shape or its role.

What changes, and why, is covered section by section below.

---

## 4. Independent Runtime Decision (spec §14)

**Decision: a new, dedicated Express server, `public/voice-copilot/server/`, with its own `package.json` — not new routes on `app.js`.**

### 4.1 Why not just add routes to `app.js`

Spec §14 is explicit and this plan takes it literally: "不应为了 Voice Copilot 主动重构现有 Live2D 项目," "不应将 Voice Copilot 代码散落至现有 Live2D 页面和实验文件中," and "现有 Live2D 项目此后只作为参考实现...不应成为 Voice Copilot 的 Runtime Dependency." Adding `/api/voice-copilot/translate-stream` to `app.js` would satisfy none of these — it would be exactly the kind of "散落" the spec rules out, and it would make Voice Copilot's translation feature permanently depend on `app.js` being deployed and running, which directly contradicts "应能够独立启动和运行." A second, small, independent server is not over-engineering here — it is the literal shape of the requirement.

### 4.2 What the new server does — and only this

Two responsibilities, nothing else:

1. **Proxy the Chinese→English LLM streaming call** (§8) — the only reason a backend is needed for translation at all is to keep the LLM Provider's API key out of the browser.
2. **Hold Provider Credential storage behind a small settings API** (§9) — so Settings (spec §13) can be "user fills in a form" rather than "user edits a file that ships with the repo."

It does **not** become a general backend: no database, no user accounts, no session management beyond what's needed to read/write two small local credential files, no reuse of `app.js`'s `chatSessions` Map/retry machinery, no `ejs`/templating, no unrelated middleware.

### 4.3 The server also hosts the static frontend — this is what makes "independent" concrete

`server/index.js` is an Express app that does two things: `express.static(path.join(__dirname, '..'))` (serving `index.html`, `css/`, `js/`, `config/` — the exact same files the Live2D `app.js` already serves at `/voice-copilot/*`), plus the two API route groups (§4.2). Running `node server/index.js` alone — no `app.js`, no Live2D project files present at all — serves a fully working Voice Copilot at `http://localhost:<port>/`. This is the direct, testable implementation of spec §14.1's "Voice Copilot 应当能够独立启动和运行."

During the current co-located phase, **both hosting paths coexist**: `app.js`'s existing `express.static('public')` continues to serve `/voice-copilot/*` exactly as Phase 1-8 built and verified it (zero regression risk to already-shipped, already-tested code), while the new server additionally makes the same static tree independently servable. No frontend file needs to know or care which host served it — there is no hardcoded absolute path back to `app.js` anywhere in the browser code today, and this plan introduces none.

### 4.4 Why the LLM credential can't follow the TTS credential's precedent

The existing codebase already draws this exact line, for the existing Live2D product, and this plan inherits that line rather than inventing a new one: **Volcengine TTS credentials are treated as acceptable to expose client-side** (the bidirectional WebSocket connects directly from the browser, `appKey`/`accessToken` visible in the connection URL — already true today, already accepted as an MVP/personal-use boundary, spec §13.3 keeps this). **Gemini/OpenAI/DeepSeek API keys are not** — in `app.js` today, `GEMINI_API_KEY`/`OPENAI_API_KEY`/`DEEPSEEK_API_KEY` exist only as server-side environment variables and are never present in any browser-served file or network request the client makes directly. Voice Copilot's Translation/LLM Provider credential (§9.3) follows this same, already-established asymmetry: it lives only on the new server, never in browser JS, never in localStorage.

### 4.5 Lightweight, deliberately

`server/package.json` declares exactly: `express`, `dotenv`, `cors`, and `@google/genai` (the one LLM SDK actually used, §8.1) — nothing else. No shared `node_modules` with the root `package.json`; when the directory is later lifted into its own repository (§15), this is already a self-contained Node project that `npm install && node server/index.js` boots with no reference to anything outside itself.

### 4.6 Listening & CORS boundaries — tightened, not permissive-by-default

This server holds Provider Credential material server-side specifically to keep it off the network beyond the user's own machine (§4.4) — it would defeat that purpose to then bind it broadly or accept cross-origin requests from anywhere. Two concrete tightenings, both a correction from an earlier draft of this plan that described "permissive CORS, allow-all":

* **Bind to `127.0.0.1`, not `0.0.0.0`, by default.** `server/index.js` calls `app.listen(port, host, ...)` with `host` read from `process.env.VOICE_COPILOT_SERVER_HOST` defaulting to `127.0.0.1` — the server is reachable from the local machine only unless a user explicitly overrides this (e.g. to reach it from another device on their own LAN). This is a one-line, explicit decision, not an oversight to fix later.
* **CORS is an explicit origin allowlist, not `origin: '*'`.** The `cors()` middleware's `origin` option is set from `process.env.VOICE_COPILOT_ALLOWED_ORIGIN`, defaulting to `http://localhost:3000` — the one known cross-origin caller during the co-located dev phase (§8.3's default-same-origin design means this allowlist is only exercised at all when the page is served via `app.js` on a different port than the dedicated server; when the dedicated server serves the page itself, §4.3, browsers don't apply CORS to same-origin requests in the first place, so tightening this never affects the primary/independent runtime path).

**`express.json()` is mounted in `server/index.js`**, with a small size limit (`express.json({ limit: '64kb' })` — generous for a short Speech Text, restrictive enough to bound request size for a personal-use tool) — required for `POST /api/translate-stream`'s `{text}` body (§8.3); this was implied but not explicitly named in the prior draft of this plan, called out here so it isn't missed during implementation. (`GET /api/settings/llm-provider`, §9.2, has no body — the route group has no `PUT` at all, since that credential is read-only from the browser's perspective.)

---

## 5. Reuse & Exclusion Matrix (extends tasks.md Phase 3's matrix for the new pieces)

| Existing Live2D code | Decision | What's actually taken |
|---|---|---|
| `app.js`'s `geminiChatStream` (async generator, SSE `data: {"content":...}` wire format) | **Reference only, reimplemented independently** | The *shape* of the wire format and the "yield `{content}` chunks as an async generator" pattern — reimplemented in `server/lib/translate.js` as a **stateless**, one-shot call (no `chatSessions` Map, no session-key caching, no multi-turn history — translation has none of that, spec §9.5). The 4-attempt retry/backoff/error-classification machinery in `geminiChatStream` is *not* copied wholesale; a much smaller 1-retry-on-transient-error version is enough (§8.2). |
| `app.js`'s `/api/chat-stream` route (SSE header setup, `for await` → `res.write('data: ...')` loop) | **Reference only, reimplemented independently** | Same SSE mechanics, new route file, no shared code, no shared process. |
| `public/js/streaming-response-handler.js`'s sentence-buffer regex (`/[^。！？.!?\n]*[。！？.!?\n]+/g`) and its length-based fallback flush (`_sentenceBuf.length > 80`) | **Adapt** | The splitting *technique* — copied logic, not the file. Everything else in that file (emoji/emotion parsing, dialogue-marker detection, `_audioQueue`/`_playLoop`, Live2D motion triggers, `[gap]` diagnostics) is excluded, per spec §9.5/§14.2. |
| `public/js/streaming-tts-client.js`'s `beginSession`/`pushText` multi-call pattern (built for LLM sentence-by-sentence push, historically *not* used by Voice Copilot's Direct Speak) | **Now actually used, via the already-ported `tts-client.js`** | No new client code — Translated Speak is the first Voice Copilot code path to call `pushText()` more than once per session, which the already-shipped client already supports (§3). |
| `@google/genai` SDK, `new GoogleGenAI({apiKey})` instantiation pattern | **Reference only, separate instance** | Same SDK, same call shape family (`generateContentStream`), but instantiated fresh inside `server/lib/translate.js` with its *own* API key sourced from the new server's credential store (§9.2) — not the root `app.js` process's `client`, not its API key, not its `GEMINI_API_KEY` env var (a Voice Copilot user may configure an entirely different Gemini account/key). |
| `app.js`'s `/api/chat`, `/api/chat-stream`, `ConversationEngine`, Chat History, Character Prompt, emoji/内心活动 parsing, ASR, ProConversationMode | **Do Not Use** (unchanged from Phase 1-8's matrix) | Confirmed still zero references anywhere in the new code this plan describes. |

---

## 6. Project Structure

```text
public/
  voice-copilot/
    index.html                     # main workspace — Speak/Voice/Player controls, + toggle + Translated Text area (§12); Settings lives on its own page, not inline here (§10)
    settings.html                  # NEW — standalone Settings page, reached via a plain link from index.html (§10)
    css/
      workspace.css                 # + minimal styling for the new controls, shared by index.html and settings.html
    js/
      app.js                        # + translationEnabled branch in handleSpeak()
      state.js                      # + translationEnabled, translatedText, generationError.type gains 'translation-failed'
      tts-client.js                 # UNCHANGED
      volcengine-protocol.js        # UNCHANGED
      streaming-audio-player.js     # UNCHANGED
      voice-profiles.js             # loadConfiguration() gains a localStorage-first path (§9.1); shape unchanged. Also exports getSavedConfiguration() — strict localStorage-only read, no file fallback, used by settings.html so it never displays anything the user didn't explicitly save
      persistence.js                # + translationEnabled key
      translation-client.js         # NEW — SSE consumption + sentence-chunk buffering (§8.3)
      settings-client.js            # NEW — shared helpers used by both index.html (translation-availability probe) and settings.html (same probe, for its read-only LLM status); no write call exists for the LLM credential (§9.2)
      settings-page.js              # NEW — settings.html's entry script: populates TTS/Voice Profile fields from getSavedConfiguration() (empty/"Not Configured" if nothing saved), populates the read-only Translation status from settings-client.js, and saves TTS/Voice Profile to localStorage
    config/
      voice-config.example.js       # unchanged — still the first-run seed (§9.1)
      voice-config.local.js         # unchanged role, now optional once Settings has been used once
    server/                         # NEW — independent Node.js runtime layer (§4)
      index.js                      # Express app: express.json() + cors(allowlist) + static(..) + route mounting; listens on VOICE_COPILOT_SERVER_HOST:VOICE_COPILOT_SERVER_PORT (default 127.0.0.1:4100, §4.6)
      routes/
        translate.js                # POST /api/translate-stream (SSE) — §8
        settings.js                 # GET /api/settings/llm-provider (masked) — §9.2. Read-only: no PUT.
      lib/
        translate.js                # stateless Gemini streaming call, fixed system instruction (§8.1)
        credential-store.js         # reads the Translation/LLM credential from process.env.GEMINI_API_KEY only — no file storage (§9.2)
      package.json                  # own deps: express, dotenv, cors, @google/genai — nothing else (§4.5)
      .env.example                  # VOICE_COPILOT_SERVER_PORT=4100, VOICE_COPILOT_SERVER_HOST=127.0.0.1, VOICE_COPILOT_ALLOWED_ORIGIN=http://localhost:3000 (§4.6), GEMINI_API_KEY (the Translation Provider credential's only configuration point, §9.2)
    .gitignore                      # NEW — subtree-local ignore rules (§6.1), travels with the directory into the future independent repo
```

### 6.1 A dedicated `.gitignore` inside `public/voice-copilot/`, not just root-level entries

**Decision: `public/voice-copilot/.gitignore` is a new file, in addition to (not instead of) the existing root `.gitignore` entries.** The root `.gitignore` only protects the current co-located phase — when the directory is later lifted into its own repository (§15), root-level ignore rules do not travel with it; a plain copy of `public/voice-copilot/` into a new repo root would need its own `.gitignore` from day one, or credentials/`node_modules` could be accidentally committed in the very first commit of the new repository. Adding it now, before that migration happens, costs nothing and removes that risk entirely rather than relying on someone remembering to recreate it later.

`public/voice-copilot/.gitignore` contents:

```text
config/voice-config.local.js
server/.env
server/node_modules/
node_modules/
```

The root `.gitignore` additions below are kept too, as defense-in-depth for the current co-located phase (git honors both a nested and a root `.gitignore` simultaneously — no conflict):

```text
public/voice-copilot/server/.env
public/voice-copilot/server/node_modules/
```

(Neither set is applied this round — plan-only, per instructions.)

---

## 7. Speak Orchestration — Two Paths, One State Machine

`app.js`'s `handleSpeak()` becomes a **pure, side-effect-free branch** — it reads one flag and delegates entirely; it does *not* itself call `teardownCurrentRound()` or perform any of the existing guard checks (`configurationFailed`, empty text, missing profile/`ttsClient`):

```text
handleSpeak():
  if state.translationEnabled:
    return handleTranslatedSpeak()
  else:
    return handleDirectSpeak()          # = today's handleSpeak() body, renamed, otherwise 100% untouched
```

**Why the dispatcher must not call `teardownCurrentRound()` itself (double-teardown / guard-ordering correction):** `handleDirectSpeak` (the renamed, byte-for-byte-unchanged original `handleSpeak`) already performs its own guard checks (`configurationFailed` / empty Speech Text / missing profile or `ttsClient`) **before** calling `teardownCurrentRound()` internally, and returns early without tearing anything down if any guard fails — this preserves whatever round is currently playing when a Speak click turns out to be a no-op. If the dispatcher tore down the current round *before* delegating, two things would go wrong: (1) a redundant second `teardownCurrentRound()` call from inside `handleDirectSpeak`/`handleTranslatedSpeak` — harmless in practice (the second call finds `currentPlayer` already `null` and `generationStatus` already `'idle'`, so it's a true no-op) but confusing and easy to regress later; (2) a **real behavior regression**: if `handleDirectSpeak`'s own guards then failed for some reason (e.g. `ttsClient` not yet initialized), today's code returns immediately with the current round untouched, but a dispatcher-owned teardown-first order would have already destroyed a playing round for nothing. Each handler therefore owns exactly one `teardownCurrentRound()` call, gated behind its own guards, exactly mirroring the structure `handleDirectSpeak` already has — the dispatcher adds a branch, not a side effect.

### 7.1 Direct Speak

Unchanged from Phase 1-8: guards (`configurationFailed`/empty text/missing profile or `ttsClient`) → `teardownCurrentRound()` → `beginSession()` → one `pushText(text)` → `endSession()`. Not re-described here — this is `T11.4`'s "pure rename, zero logic change."

### 7.2 Translated Speak

```text
handleTranslatedSpeak():
  state = getState()
  if configurationFailed: return                        # same guard sequence as handleDirectSpeak, independently applied
  text = state.speechText.trim()
  if (!text) return
  profile = findSelectedProfile(state)
  if (!profile || !ttsClient) return

  await teardownCurrentRound()          # this handler's own single teardown call — see §7 above for why the
                                         # dispatcher itself never calls this

  translatedText = ''; setTranslatedText('')          # NEW state field (§11), cleared per round
  speakClickedAt = performance.now()
  setGenerationStatus('generating'); setPlaybackStatus('buffering')

  player = new StreamingAudioPlayer({ ...same callbacks as today... })
  currentPlayer = player

  let ttsSessionOpen = false
  translationAbort = new AbortController()
  currentTranslationAbort = translationAbort            # NEW module state, for teardown (§7.3)

  try:
    await ttsClient.beginSession({ speaker, speed, volume, useTTS2: true }, { onChunk: player.appendChunk })
    ttsSessionOpen = true

    sentenceBuffer = ''
    for await ({ content } of translationClient.streamTranslation(text, { signal: translationAbort.signal })):
      if currentPlayer !== player: return               # staleness guard, same pattern as today's endSession() check
      translatedText += content
      setTranslatedText(translatedText)                  # live update of the read-only Translated Text area (§12)
      sentenceBuffer += content
      for (sentence of extractCompletedSentences(sentenceBuffer)):   # §8.3 — mutates/drains sentenceBuffer
        await ttsClient.pushText(sentence)

    if sentenceBuffer.trim()) await ttsClient.pushText(sentenceBuffer.trim())   # flush trailing partial sentence

    await ttsClient.endSession()                          # same completion semantics as Direct Speak (review ⑦, unchanged)
    ttsSessionOpen = false                                 # endSession()'s own finally already cleared _activeSession (tts-client.js, unchanged)
    if (currentPlayer !== player) return
    replayAvailable = true
    setGenerationStatus('completed')
    player.end()

  catch (err):
    if (currentPlayer !== player) return
    # Correctness-critical, not optional cleanup (mirrors the exact chain-release class of bug found and
    # fixed in Phase 6): a translation-stream failure happens *after* beginSession() has already opened a
    # TTS session with zero or only partial text pushed. Nothing else in this path calls endSession() or
    # cancelSession() for that session if we stop here — leaving tts-client.js's _synthChain permanently
    # unreleased, which would silently hang every subsequent Speak click with no visible error. This must
    # be torn down explicitly, right here, regardless of which branch (translation or TTS) failed:
    if (ttsSessionOpen): await ttsClient.cancelSession()
    player.dispose()
    currentPlayer = null
    setPlaybackStatus('stopped')
    if (err came from translationClient — see §8.4's typed-error contract):
      setGenerationStatus('error', { type: 'translation-failed', message: err.message })
    else:
      setGenerationStatus('error', { type: 'tts-generation-failed', message: err.message })
```

The only genuinely new orchestration ideas here are (a) the `for await` loop calling `pushText()` per completed sentence instead of once, and (b) the explicit `cancelSession()`/`dispose()` cleanup in the `catch` block, made necessary by Translated Speak's failure window spanning an already-open TTS session in a way Direct Speak's simpler single-`pushText()` sequence does not need to reason about as carefully. Everything else (player construction, callback wiring, staleness guards, completion handling shape) is copy-identical to Direct Speak's existing, already-verified pattern.

**Note, explicitly out of scope for this correction:** Direct Speak's own existing `catch` block (unchanged, per `T11.4`) does not perform this same `cancelSession()`/`dispose()` cleanup — it relies on the *next* `teardownCurrentRound()` (the next Speak/Stop) to clean up a session left open by a `pushText()`/`endSession()` failure. This is pre-existing, already-shipped Phase 1-8 behavior, not something this revision is asked to touch (`不扩大范围`); it is flagged in §14's Risks as a known, symmetrical gap worth a future hardening pass, not fixed here.

### 7.3 Teardown extension

`teardownCurrentRound()` (T6.4/T6.5, unchanged in every other respect) gains one line: if `currentTranslationAbort` is set, call `.abort()` on it before proceeding — this stops the in-flight `fetch()` to the translation server immediately, which is what lets Stop and Speak-while-active interrupt a Translated Speak round exactly as cleanly as they already interrupt a Direct Speak round's TTS session (spec §7.3, §9.2's "Stop 需要同时终止仍在进行的 LLM Streaming Translation"). Aborting the fetch is also what allows the server to stop consuming/forwarding the upstream LLM stream promptly (§8.3's server-side abort handling) — the client-side abort is the trigger, the server-side reaction is described where the relay logic lives.

### 7.4 Why no new status enum

Per spec §9.4's explicit instruction, `generationStatus`/`playbackStatus` keep their existing four/four values. Translation-vs-synthesis failure is disambiguated purely via `generationError.type` (`'translation-failed'` is new; `'tts-generation-failed'` already exists from T5.5) — the UI's error banner (§13's Settings aside, this is the existing `#generation-error` element) reads `type` to choose slightly different copy/recovery hints ("检查 Translation Provider 凭证" vs "检查 TTS Provider 连接"), but it's the same element, same field, same rendering function (`render()` in `app.js`), extended with one more `if` branch. `playbackStatus: 'buffering'` already covers "nothing audible yet" regardless of *why* — whether that's waiting on the first TTS chunk directly (Direct Speak) or waiting on translation-then-first-TTS-chunk (Translated Speak) is not a distinction the playback state machine needs to make (spec §7.2's own text already says this explicitly). The Status line's *text label* may optionally say "Translating…" instead of "Buffering" while `translatedText` is still empty and `generationStatus === 'generating'` under Translated Speak — this is a pure `statusLabel()` display refinement (three-line change in `app.js`), not a new state value.

---

## 8. LLM Streaming Translation — Server Side

### 8.1 Provider: Gemini, one-shot, stateless

**Decision: Gemini, via `@google/genai`**, the same SDK family `app.js` already uses (lowest-friction choice — already proven reliable in this codebase's streaming path, already has a `GEMINI_API_KEY`-shaped credential the user likely already has if they've used the Live2D project). `server/lib/translate.js` exports:

```text
async function* streamTranslate(chineseText, { apiKey }):
  const client = new GoogleGenAI({ apiKey })          # fresh instance per call — NOT app.js's shared client (§5)
  const stream = await client.models.generateContentStream({
    model: 'gemini-3.1-flash-lite',                    # same default model app.js already uses; not user-configurable in Settings (spec §13.2)
    contents: [{ role: 'user', parts: [{ text: chineseText }] }],
    config: { systemInstruction: FIXED_TRANSLATION_INSTRUCTION },
  })
  for await (chunk of stream):
    if (chunk.text) yield { content: chunk.text }
```

`FIXED_TRANSLATION_INSTRUCTION` (not exposed to the client, not configurable via Settings, per spec §13.2's "不需要提供复杂的 Prompt / Model 参数配置界面"):

> "You are a translation engine. Translate the given Chinese text into natural, spoken English suitable for a business meeting or status update. Output only the English translation — no commentary, no quotation marks, no explanation. Use standard sentence-ending punctuation so the output can be split into sentences."

No `history`, no `sessionId`, no `chatSessions`-style caching — every call is a fresh, independent, stateless request, matching spec §9.1/§9.5's "一次性、单向、无上下文记忆." If the input is already English or mixed, the instruction's own wording ("translate... into natural, spoken English") naturally passes through already-English content close to as-is; no special-case detection logic is built for this in the server (keeps it simple; verified during manual testing, §16).

### 8.2 Error handling — smaller than `geminiChatStream`'s, deliberately

`app.js`'s `geminiChatStream` has a 4-attempt retry/backoff/error-classification system built for a much harder problem (multi-turn chat sessions where losing partial output mid-stream is costly). Translation is one-shot with no conversation to protect, so `server/lib/translate.js` implements a **much smaller** version: at most 1 silent retry on a transient (503/429) error *before any content has been yielded*, otherwise the error propagates immediately. This is intentionally not copied wholesale from `app.js` — spec §14.1's "轻量化" applies to logic complexity, not just file count.

### 8.3 Sentence chunking — where it lives and why

**Decision: chunking happens client-side, in `translation-client.js`, not server-side.** The server route (`routes/translate.js`) is a thin SSE relay: it calls `streamTranslate()` and forwards every yielded `{content}` immediately as `data: {"content":"..."}\n\n` — no buffering, no sentence logic, minimal latency added. This keeps the server maximally simple (§4.5) and keeps the TTFA-critical buffering logic in the same place `tts-client.js`'s `pushText()` calls happen (`app.js`/`translation-client.js`), which is also where the existing Live2D reference implementation puts it (`streaming-response-handler.js`'s `_sentenceBuf`) — same architectural position, ported logic, not re-invented.

**The relay must stop consuming the upstream Gemini stream promptly once the client disconnects.** When the browser calls `translationAbort.abort()` (§7.3), the resulting `fetch()` cancellation closes the underlying HTTP connection, which Express surfaces as a `close` event on the request object. `routes/translate.js` registers `req.on('close', () => { aborted = true })` and checks `aborted` at the top of each loop iteration while relaying `streamTranslate()`'s chunks, `break`ing out of the `for await...of` loop the moment it's set — a `for await...of` break calls the async generator's `.return()`, which for `@google/genai`'s streaming iterator propagates as a best-effort cancellation of the underlying Gemini request (the same "best-effort, not a guaranteed server-side abort" posture `tts-client.js`'s `cancelSession()` already documents for the TTS side — consistent, not a new risk class). `res.write()` is never called after `aborted` is set (guarded by the same check), avoiding a write-after-close error. This bounds how long an abandoned round keeps consuming (and, if the SDK's cancellation is honored, keeps *paying for*) tokens from a stream nobody is listening to anymore.

`translation-client.js`:

```text
const SENTENCE_RE = /[^。！？.!?\n]*[。！？.!?\n]+/g;      // identical regex to the reference implementation
const MAX_BUFFER_BEFORE_FORCED_FLUSH = 100;                  // chars; safety valve if no terminator arrives (reference uses 80 for Chinese; English runs slightly longer per idea unit — tunable during implementation, not a spec-mandated number)

export function extractCompletedSentences(buffer):
  # returns { sentences: string[], remainder: string }
  # 1. match SENTENCE_RE against buffer, collect full matches as sentences
  # 2. remainder = buffer.slice(lastMatchEnd)
  # 3. if remainder.length > MAX_BUFFER_BEFORE_FORCED_FLUSH: treat remainder itself as one more "sentence"
  #    (forced flush — bounds worst-case TTFA/buffer growth when the model produces a long
  #    unpunctuated run; a documented, accepted quality tradeoff, not a correctness issue — §14)

export async function* streamTranslation(chineseText, { signal }):
  const res = await fetch(`${SERVER_BASE_URL}/api/translate-stream`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ text: chineseText }), signal,
  })
  if (!res.ok) throw new TranslationError(...)             # §8.4
  # standard SSE-over-fetch reader loop: res.body.getReader(), TextDecoder,
  # split on '\n\n', parse 'data: {...}' lines — same mechanics streaming-response-handler.js
  # already uses for /api/chat-stream, reimplemented here independent of that file
  for await (frame of sseFrames(res.body)):
    if (frame === '[DONE]') return
    yield JSON.parse(frame)                                 # { content } or { error }
```

This gives exactly the behavior spec §9.2 requires: `pushText()` fires as soon as *a sentence* is complete, not after the whole translation finishes, and the forced-flush safety valve guarantees this remains true even for LLM output that's slow to produce terminal punctuation.

**`SERVER_BASE_URL` defaults to same-origin (`''`, relative paths), not a hardcoded `localhost` port.** This matches how the app actually runs once independent (§4.3 — the dedicated server serves its own frontend, so `/api/translate-stream` is always a same-origin relative fetch in that mode, with zero configuration needed). A `localhost:4100`-pointing value is only ever needed as a **development override**, for the co-located phase where the page happens to be served via `app.js` on a different port than the dedicated server — this is exactly the cross-origin case §4.6's CORS allowlist exists for, not the default/primary case. Concretely:

```text
const SERVER_BASE_URL = DEV_SERVER_BASE_URL_OVERRIDE || '';
```

`DEV_SERVER_BASE_URL_OVERRIDE` is an optional exported constant in `config/voice-config.local.js` (unset/`''` by default in `voice-config.example.js`), set to `http://localhost:4100` only in a developer's own local config while iterating on the co-located phase — not something a standalone/independent deployment needs to touch at all.

### 8.4 Typed errors, for §7.4's disambiguation

`translation-client.js` throws a distinguishable `TranslationError` (a thin `Error` subclass, or an `{ isTranslationError: true }` tag on a plain `Error`) for any failure originating from the fetch/SSE/server-reported-error path, so `handleTranslatedSpeak`'s `catch` block (§7.2) can route it to `generationError.type: 'translation-failed'` without needing to inspect message strings.

---

## 9. Credential Architecture (spec §13)

Two independent stores, matching spec §5.1/§9.3/§13.1's explicit concept split — never merged, never sharing a file or a UI section beyond both living in the same Settings panel.

### 9.1 Voice / TTS Provider Credential + Voice Profile — client-side, localStorage-first

**Decision: `loadConfiguration()` (in `voice-profiles.js`) becomes localStorage-first with the existing static file as a first-run fallback**, not a replacement of one by the other:

```text
loadConfiguration():
  1. read `voiceCopilot.providerConfiguration` + `voiceCopilot.voiceProfiles` from localStorage
  2. if both present and valid → use them (this is the path once the user has ever saved Settings)
  3. else → fall back to importing config/voice-config.local.js exactly as today (T2.1-T2.7, unchanged
     code path) — this preserves the already-verified zero-Settings-UI dev bootstrap and doesn't
     regress Phase 1-8's own test setup
  4. if neither source is valid → the existing configuration-error banner (T2.7), copy updated to
     point at Settings (§10) as the primary fix, with "or configure config/voice-config.local.js for
     local development" as a secondary mention
```

The Settings form (§10) writes directly to `voiceCopilot.providerConfiguration`/`voiceCopilot.voiceProfiles` in localStorage — no server round-trip for TTS credentials, because the browser needs this value directly anyway (it opens the WebSocket itself, unchanged from Phase 1-8's architecture) and this is the same client-exposed-credential posture already accepted for this provider (§4.4).

This is a **shape-compatible, additive change** to `voice-profiles.js` — `ProviderConfiguration`/`VoiceProfile` types are unchanged (spec §5.1/§13.1 didn't change their fields), only the *source resolution order* changes.

### 9.2 Translation / LLM Provider Credential — server-side, environment-only, read-only from the browser

**Decision (revised — supersedes this section's original design): configured exclusively via `process.env.GEMINI_API_KEY` on the dedicated server, never written or stored anywhere by the app itself. There is no `PUT` endpoint and no credential file.**

This corrects the original decision below spec §13's own exception (added in the same revision, spec §13/§13.1/§13.2): Voice/TTS Provider Configuration is a per-browser-user value the client needs directly to open the TTS WebSocket, so a user-fillable Settings form for it makes sense (§9.1). The Translation/LLM credential is different — it's used only by the server (§4.4's asymmetry: it must never reach the browser at all), and in the independent-deployment model (spec §14) it's a deployment-time secret that belongs to whoever operates the server instance, not a value an end user fills into a web form. A `PUT`-and-persist-to-a-file design (the original decision here) added a second, redundant, browser-writable path for something that's really a `.env`-shaped operator setting — this revision removes that path entirely rather than keeping it as an unused/confusing option alongside the environment variable.

```text
GET  /api/settings/llm-provider
  → { configured: boolean, provider: 'gemini', maskedAccessToken: 'AIza••••X3f9' | null }
  # never returns the real key; configured reflects process.env.GEMINI_API_KEY presence only
```

`credential-store.js`'s `readCredential()` is a single check: `process.env.GEMINI_API_KEY` set → return it; unset → `null` (`configured: false`). Restarting the server after changing `.env` is required to pick up a change — there's no live-reload, matching how any other env-var-configured server process works.

Field mapping for the concrete Gemini decision (§8.1) is now trivial as a result: Gemini needs exactly one value (the API key), so there's no App ID/Secret Key field to map at all — spec §13.1's original "generic 3-field UI, not all fields used by every provider" framing no longer applies to this credential, since it isn't collected through a UI field in the first place.

### 9.3 What Settings never does

No credential of either kind is ever logged, ever included in a client-side error message's `message` string verbatim (errors surfaced to `generationError`/`playbackError` are provider-generated failure text, e.g. "resource ID is mismatched," not credential values), and no credential is written anywhere outside the two stores named above (no third copy in `voice-config.example.js`, no credential ever committed).

---

## 10. Settings UI (spec §13.2)

**Decision (revised — supersedes this section's original "inline panel" design): a standalone page, `settings.html`, not an inline `<section>` in `index.html`.** The existing `#settings-btn` is a plain `<a href="settings.html">`, not a button toggling panel visibility. This project has no client-side router and no build step, so "new page" is the natural, lowest-complexity way to give Settings its own space without introducing modal/overlay machinery or a router where none exists — and it keeps the main Workspace focused on Speak/Voice/Player, closer to spec §11's intent than an inline panel that expands the main page every time Settings is opened. (Spec §11/§13.2's underlying goal — not requiring "frequent page hops" for *core* Speak operations — is unaffected: Settings is not a core, per-Speak operation.)

```text
Settings (settings.html)
├── ← Back to Workspace
├── Voice / TTS Provider
│   ├── status: "Configured" | "Not Configured"   ← only true if saved via this page before (§9.1)
│   ├── App ID          [_______]
│   ├── Access Token     [_______]
│   └── Secret Key       [_______]   (optional, unused by Volcengine today — present per spec §13.1)
├── Voice Profile (single-profile MVP form, not a list/CRUD — spec §13.2)
│   ├── Name             [_______]
│   ├── Speaker ID        [_______]
│   ├── Language          [ ] en [ ] zh
│   ├── Speed              [___]
│   └── Volume              [___]
├── Chinese → English (only shown if the translation server is reachable, §10.1)
│   ├── Default state on load    [ ] on  [x] off
│   └── Translation Provider (Gemini) — read-only (spec §13.1's exception, §9.2)
│       status: "Configured (AIza••••X3f9)" | "Not Configured"
│       note: "Set GEMINI_API_KEY in server/.env and restart the server to configure this."
└── [Save]  [Cancel]
```

`Save`: writes TTS Provider Credential + Voice Profile to localStorage (§9.1, immediate, synchronous) and navigates back to `index.html`, which re-runs its normal startup path and picks up the new values. There is nothing to save for the Translation section — it has no editable fields. Reopening Settings re-reads current values strictly from localStorage via `getSavedConfiguration()` (§9.1 — never a file fallback, so Settings never shows a value the user didn't explicitly save through this page) for TTS/Voice, and `GET /api/settings/llm-provider`'s masked response for the read-only Translation status.

### 10.1 Graceful absence of the translation server

Because the dedicated server (§4) is a separate process, it may simply not be running (e.g., a user who only wants Direct Speak and never starts `server/index.js`). Settings' Translation section, and the main workspace's "中文转英文" toggle itself, both do a lightweight reachability check (a `GET /api/settings/llm-provider` on Settings-open, and — separately — the toggle control is disabled with a tooltip if that check has never succeeded) rather than assuming the server is always present. This keeps Direct-Speak-only usage exactly as zero-dependency as it is today (spec's own default-off framing for the whole feature, §9.1) — nothing about Translated Speak being unavailable should degrade or block Direct Speak.

---

## 11. State Model Additions (extends plan's own prior §8, unchanged fields not repeated)

```text
state = {
  ...(all existing fields, unchanged)...

  translationEnabled: boolean,        // NEW — default false, persisted (§persistence below)
  translatedText: string,             // NEW — cleared at the start of every Speak round; only
                                       // meaningful when translationEnabled was true for that round;
                                       // read-only display data, never fed back into speechText (spec §9.4)
}
```

`generationError.type` gains one new value: `'translation-failed'` (alongside the existing `'tts-generation-failed'`). No other field changes. `playbackStatus` and its four values are untouched (§7.4).

`persistence.js` gains one key: `voiceCopilot.translationEnabled` — persisted the same way `speed`/`volume` already are (plain user preference, no "confirmed" semantics, spec §13.2's "开关的默认状态"). `translatedText` is explicitly **not** persisted (transient per-round display data, same reasoning as why no audio data is persisted today).

---

## 12. UI Structure Additions (spec §12)

```text
┌─────────────────────────────────────────────────────────────┐
│  Voice Copilot                                    [Settings] │
├─────────────────────────────────────────────────────────────┤
│  Speech Text                                                   │
│  ┌───────────────────────────────────────────────────────┐   │
│  │ [textarea]                                                │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                                 │
│  Voice:  [ My Voice ▾ ]   (EN · 中)                            │
│  Speed:  [ 1.0 ]     Volume: [ 1.0 ]                           │
│  Chinese → English:  [ ○ Off ]                                │
│                                                                 │
│                    [      Speak      ]                         │
│                                                                 │
│  ┌─ Translated Text (only shown when Chinese → English is on   │
│  │  and this round has produced translation output) ─────┐    │
│  │  [read-only, streams in live, cleared each Speak]        │    │
│  └───────────────────────────────────────────────────────┘   │
│                                                                 │
│  ⏸ Pause   ▶ Resume   ↻ Replay   ■ Stop      status: Buffering │
└─────────────────────────────────────────────────────────────┘
```

The Translated Text panel is DOM-present but `hidden` unless `state.translationEnabled && state.translatedText.length > 0` — no layout shift for the common Direct-Speak case, per spec §11's "不应为了这项可选能力增加额外的页面跳转或复杂交互."

---

## 13. Independence Checklist (spec §14 — verifiable, not just asserted)

The following must all be true before this revision's work is considered to satisfy §14.1, mirroring how Phase 8's tasks.md verified each spec.md acceptance bullet against real evidence rather than code review alone:

1. Stop `app.js` entirely (or work in an environment where it was never started). Run only `node public/voice-copilot/server/index.js`. Load `http://localhost:4100/`. Direct Speak works end-to-end (unaffected by anything in this plan). Translated Speak works end-to-end (new).
2. `grep`-style check: nothing in `public/voice-copilot/js/**` or `public/voice-copilot/server/**` imports from, fetches, or references any path under `app.js`'s route table (`/api/chat`, `/api/chat-stream`, `/api/volcengine-tts`, `/api/voice-clone/*`, `/api/volcengine-asr`).
3. `public/voice-copilot/server/package.json`'s dependency list has zero overlap-by-necessity with the root `package.json` (both may happen to list `express`/`dotenv` — that's fine, they're separate installs, not a shared `node_modules`).
4. Copying `public/voice-copilot/` alone (server included) into a brand-new empty directory, running `npm install` inside `server/`, and starting `node server/index.js` there reproduces a fully working app with no edits — the actual migration rehearsal for §15.
5. In that same scratch copy, `git init` and `git status` — confirm `config/voice-config.local.js`, `server/.env`, and `server/node_modules/` are all reported as ignored, proving `public/voice-copilot/.gitignore` (§6.1) travels with the directory and does its job with zero root-`.gitignore` support present.

---

## 14. Risks and Known Limitations

1. **Sentence-boundary chunking quality is a heuristic, not a guarantee** (§8.3) — abbreviations, decimals, or unusual punctuation in LLM output could cause a premature or delayed split (e.g. "the U.S. market" splitting after "U."). This is a pre-existing, already-accepted risk in the reference implementation's identical regex (used in production for Live2D dialogue today) — inherited, not newly introduced. Not mitigated with NLP-grade sentence segmentation in MVP (out of proportion to the product's scope); the forced-flush safety valve bounds the *worst case* latency/buffer-growth impact even when splitting is imperfect.
2. **Translation server availability is now a second point of failure** for Translated Speak specifically (not for Direct Speak, which has zero dependency on it, §10.1). A user who wants Translated Speak must remember to run two processes during the co-located phase (`app.js` for static hosting, or the dedicated server directly per §4.3's single-process option) — this is called out explicitly in Settings' reachability check (§10.1) rather than failing silently.
3. **CORS between the static host and the dedicated server during co-located dev.** If the page is served via `app.js` (port 3000, existing behavior) but calls the dedicated server (port 4100 via `DEV_SERVER_BASE_URL_OVERRIDE`, §8.3), this is a cross-origin request. Mitigation: the dedicated server allowlists exactly `VOICE_COPILOT_ALLOWED_ORIGIN` (default `http://localhost:3000`, §4.6) rather than `origin: '*'`, and binds to `127.0.0.1` rather than `0.0.0.0` by default — narrower than "permissive," acceptable because this is still a local, personal-use, credential-per-request (not cookie/session-based) tool, not a multi-tenant service; explicitly documented as an MVP simplification, revisited if/when this ever needs to be a hosted multi-user product (same caveat spec §13.3 already states generally). This narrowing is a correction from an earlier draft of this plan, which described the CORS policy as unconditionally permissive/allow-all — tightened here before any implementation began.
4. **Production/Vercel deployment of the new server is not addressed by this plan.** Today's `vercel.json` maps everything to `app.js` + static `public/**`; the new dedicated server has no deployment target defined yet. This is intentionally left as a non-blocking open item (§18) — MVP verification for Phase 1-8 was already done via local `node app.js` + headless Chromium, not a live Vercel deployment, so this isn't a regression in verification rigor, just an explicitly-deferred piece of infrastructure work that matters more once the independent-repo migration (§15) actually happens.
5. **Gemini quota/latency variance** for the translation call is a real-world variable outside this plan's control (same category of risk `geminiChatStream` already handles in `app.js` today, just with a smaller retry budget here, §8.2, appropriate to the smaller blast radius of a one-shot stateless call).
6. **Two credential stores means two places a user can get "it's not working" wrong** (e.g., TTS configured, LLM not, or vice versa) — mitigated by Settings' status indicators (§10) and by §7.4's error-type disambiguation surfacing which one is actually broken, rather than a single generic failure message.
7. **A translation failure after a TTS session is already open must actively clean up that session** (§7.2) — if `handleTranslatedSpeak`'s `catch` block only set `generationStatus: 'error'` without calling `cancelSession()`, `tts-client.js`'s `_synthChain` would stay held (never released) until some later, unrelated Speak/Stop happened to tear it down, silently hanging the very next Speak click with no visible error — the same failure shape Phase 6 already found and fixed once for a different trigger (Stop mid-generation). §7.2's `catch` block now does this explicitly. Direct Speak's own existing `catch` block has a narrower version of this same latent gap (a `pushText()`/`endSession()` failure there also doesn't proactively `cancelSession()`) — left alone in this revision as pre-existing, already-shipped behavior out of this correction's scope, but noted here as a candidate for a future symmetrical hardening pass.

---

## 15. Migration Checklist — Cutting `public/voice-copilot/` Into Its Own Repository

Not performed in this plan (spec §14.1 keeps this future work), but concretely rehearsable using §13's checklist:

1. `git subtree split` (or a plain copy, since there is no cross-directory history dependency to preserve carefully) of `public/voice-copilot/` into a new repository root.
2. Root-level `index.html`/`css/`/`js/`/`config/`/`server/` land at the new repo's root, unchanged in structure (no path-remapping needed — nothing in this plan hardcodes a `public/voice-copilot/` prefix inside the app's own code, only in this repo's *external* references to it, e.g. `app.js`'s static mount and `vercel.json`).
3. New repo's `.gitignore` already exists — `public/voice-copilot/.gitignore` (§6.1) travels with the directory automatically, no lifting/recreating required; this is exactly why it was added ahead of the migration rather than left as a migration-day task.
4. New repo's own deployment target (Vercel or otherwise) is configured fresh — this plan does not presume Vercel, given §14's open item (§18-3).
5. The co-located copy inside the Live2D repo is deleted only after the new repository is confirmed working end-to-end per §13's checklist, run against the *new* repo's clone — not before.

---

## 16. Testing Strategy (extends tasks.md Phase 1-8's manual-verification approach; no test framework in either project, unchanged)

New checks this revision requires, on top of Phase 1-8's existing (still-valid, unaffected) checklist:

1. **Translated Speak happy path (Scenario C):** the exact spec §15 Scenario C text, toggle on, confirm `translatedText` streams into the Translated Text panel roughly in step with audible playback starting, and confirm (via devtools) `pushText()` is called more than once for a multi-sentence input (proves incremental delivery, not a single post-hoc push).
2. **TTFA comparison, Translated Speak vs Direct Speak:** confirm Translated Speak's TTFA is higher than Direct Speak's (translation adds unavoidable latency) but still well under "wait for the full translation, then wait for the full synthesis" — i.e., confirm the *first* `pushText()` call happens well before the translation SSE stream's final `[DONE]`.
3. **Toggle-off parity:** with the toggle off, confirm byte-for-byte identical behavior to today's Direct Speak (no new network requests to the translation server at all) — the regression check that §9.1's "关闭时系统行为与不存在该功能时完全一致" actually holds.
4. **Stop/regenerate mid-translation:** click Speak with translation on, click Stop (or edit Speech Text and click Speak again) before the translation stream finishes — confirm the `fetch()` to `/api/translate-stream` is aborted (no further `pushText()` calls logged from the stale round), confirm `tts-client.cancelSession()` still runs correctly for whatever partial TTS session was already open (T6.6's existing chain-release regression check, now also exercised via this second entry path), and confirm — via the dedicated server's own console logging — that `routes/translate.js` observes the `req.on('close', ...)` event and stops relaying further chunks from the upstream Gemini stream shortly after the client-side abort (§8.3), not indefinitely.
5. **Translation-server-down handling:** stop the dedicated server, toggle "Chinese → English" — confirm the toggle/Settings correctly report unreachable (§10.1) rather than silently failing on the next Speak click; separately, confirm Direct Speak is entirely unaffected while the dedicated server is down.
6. **Two-error-type disambiguation:** force a translation failure (invalid/missing LLM credential) and separately force a TTS failure (as Phase 8's `T8.9` already does) — confirm `generationError.type` and the rendered message differ appropriately between the two.
7. **Settings round-trip:** save TTS Provider Credential + Voice Profile via Settings, reload the page, confirm `voice-profiles.js` picks them up from localStorage (not the static config file) on the next load. Separately, set `GEMINI_API_KEY` in `server/.env` and restart the server; confirm Settings' read-only Translation status flips to "Configured" with a masked value, and confirm the real key never appears in any Network tab response body — there is no Settings action that writes this credential.
8. **Independence checklist (§13), run for real** — not just asserted in this document.
9. **Translation-failure cleanup:** force a translation-stream failure (e.g. an invalid LLM credential, or a killed network mid-stream) *after* a TTS session has already been opened (i.e., after at least one `pushText()` has fired) — confirm `cancelSession()` and `player.dispose()` both run (§7.2), confirm `currentPlayer` is `null` and `playbackStatus` reads `'stopped'` afterward, and — the actual regression this guards against — confirm the *next* Speak click proceeds normally rather than hanging on a still-held `_synthChain` (the same class of check T6.6 already does for Stop, exercised here via the translation-failure path instead).
10. **No double teardown:** with devtools console open, click Speak (Direct or Translated) from a clean idle state and confirm `teardownCurrentRound()`'s own logging (or an added temporary counter, removed before considering this check done) fires exactly once per Speak click — not twice — verifying §7's dispatcher-does-not-teardown correction actually holds in the running code, not just in this plan's pseudocode.
11. **CORS/binding boundary sanity check:** confirm a request to the dedicated server's API from a page origin *not* in the `VOICE_COPILOT_ALLOWED_ORIGIN` allowlist is rejected by CORS (browser console shows a CORS error, not a successful response), and confirm the server is not reachable at `0.0.0.0`/the machine's LAN-facing address unless `VOICE_COPILOT_SERVER_HOST` was explicitly overridden (§4.6).

---

## 17. Implementation Phases (new phases only — Phase 1-8 in tasks.md stay `✅ Done`, unmodified this round)

Sequencing only, per this repo's existing convention (`tasks.md`'s job to break these into numbered tasks in a future pass — not done this round, per instructions).

**Phase 9 — Dedicated Node Server Skeleton**
`server/index.js` (with `express.json()`, the `127.0.0.1`-default host binding, and the origin-allowlisted `cors()` middleware from §4.6 — not a permissive/allow-all default), `server/package.json`, `public/voice-copilot/.gitignore` (§6.1), static hosting of the existing frontend, `GET /api/settings/llm-provider` returning `{configured:false}` when `GEMINI_API_KEY` is unset. Closes: §13's independence checklist items 1 (static half only), 3, and 5 (the new `.gitignore` rehearsal).

**Phase 10 — Translation Server + Client**
`server/lib/translate.js`, `server/routes/translate.js` (including the `req.on('close', ...)`-driven upstream-abort handling from §8.3 — not just the happy-path relay), `js/translation-client.js`, the `SERVER_BASE_URL`/`DEV_SERVER_BASE_URL_OVERRIDE` same-origin-by-default config (§8.3). Closes: a real Chinese input produces a real streaming English SSE response, verified via a manual/console trigger, no UI wiring yet — mirroring how tasks.md's original Phase 3 verified `tts-client.js` in isolation before wiring the UI.

**Phase 11 — Translated Speak Wiring**
`app.js`'s pure-branch dispatcher + `handleTranslatedSpeak()` with its own independent guard sequence and the explicit `cancelSession()`/`dispose()` failure cleanup (§7.2 — not a single shared `teardownCurrentRound()` call in the dispatcher, per §7's double-teardown/guard-ordering correction), `state.js` additions (§11), Translated Text UI panel (§12). Closes: Scenario C end-to-end, toggle-off parity check (§16.3), and a verified single-teardown-per-Speak-click invariant (no redundant `teardownCurrentRound()` calls, no case where a failed guard check leaves a previously-playing round destroyed for nothing).

**Phase 12 — Settings Panel + Credential Architecture**
`settings-client.js`, Settings UI markup (§10), `voice-profiles.js`'s localStorage-first `loadConfiguration()` (§9.1), `server/routes/settings.js` + `credential-store.js` (§9.2). Closes: §16.7's Settings round-trip check, Voice/TTS credential no longer requires editing a file to change.

**Phase 13 — Independence Verification + Manual Acceptance Pass**
Run §13's checklist for real; run §16's full new-check list; re-run tasks.md's existing Phase 8 checklist once more to confirm zero regression to Direct Speak. Closes: spec §16 (MVP Acceptance Criteria)'s new bullets (Scenario C, independent startup, Settings-configurable Credential, translation-vs-synthesis error disambiguation).

---

## 18. Open Questions

1. **Non-blocking.** Production/hosting target for the dedicated server (Vercel function vs. long-running process vs. something else) — deferred per §14.5/§4's own reasoning; doesn't block local MVP-first implementation or manual verification, which is how Phase 1-8 was verified too.
2. **Non-blocking.** Exact forced-flush character threshold (§8.3's `MAX_BUFFER_BEFORE_FORCED_FLUSH = 100`) is a starting estimate, tunable during Phase 10/11 implementation against real Gemini output — not a spec-mandated number, safe to adjust without revisiting this plan.
3. **Non-blocking.** Whether `server/index.js`'s static-hosting half should be **on** by default when running co-located with `app.js` (i.e., is it acceptable for the same static files to be reachable at two different local ports simultaneously during dev) — assumed yes (no conflict, no shared state), flagged here in case there's a reason to disable it that isn't obvious from the code alone.

**No blocking open questions.** All three are safe defaults in the MVP-first direction; proceeding to a `tasks.md` breakdown of Phase 9-13 under these assumptions unless redirected.
