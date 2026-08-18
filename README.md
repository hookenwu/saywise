# Voice Copilot

A personal-voice Text-to-Speech workspace for real meetings: type or paste what you want
to say, pick your cloned voice, click **Speak**, and low-latency Streaming TTS starts
playing as soon as the first audio chunk is ready — no waiting for the whole utterance to
finish generating.

Optionally, you can turn on **Chinese → English**: type in Chinese, and the app translates
it with a streaming LLM call and feeds the English text into Streaming TTS as it arrives,
so English speech starts playing without waiting for the full translation either.

This app is self-contained and runs independently — it does not depend on the Live2D
Assistant project it currently happens to live alongside in this repository
(`public/voice-copilot/`). See `spec/voice-copilot-mvp/` in the parent repo for the full
product spec, technical plan, and task history if you have access to it; none of that is
required to run the app.

---

## Requirements

- Node.js 18+ (tested on Node 24). No build step, no bundler, no TypeScript — the browser
  code is plain ES modules loaded directly by `<script type="module">`.
- A modern browser (Chrome/Edge/Firefox) — the app uses `MediaSource`/`SourceBuffer` for
  streaming audio playback.
- A [Volcengine](https://www.volcengine.com/) Voice/TTS account with a cloned speaker
  (App ID + Access Token), for actual speech synthesis.
- Optionally, a [Gemini API key](https://ai.google.dev/) if you want Chinese → English
  translation. Not required for the core Direct Speak flow.

## Quick Start

```bash
cd server
npm install
cp .env.example .env        # fill in at least the port/host defaults; GEMINI_API_KEY is optional
node index.js
```

Open **http://localhost:4100/** (or whatever `VOICE_COPILOT_SERVER_PORT` you set). That's
it — `server/index.js` is both the API server and the static file host for this entire
app, so this one command is the whole "compile and run" step. There's nothing to build;
"starting" and "compiling" are the same command here.

On first load, if no Voice Profile is configured yet, the app shows a configuration banner
and you can open **Settings** (top-right) to fill in your Volcengine credentials and voice
directly through the UI — no file editing required. See [Configuration](#configuration)
below for the file-based alternative.

## Configuration

There are two independent credential stores — this is deliberate, not an oversight (see
`spec/voice-copilot-mvp/spec.md` §5.1/§13 if you want the full reasoning):

### Voice / TTS Provider — client-side

Configured either through **Settings** in the UI (saved to the browser's `localStorage`),
or, for local development, via a static config file:

```bash
cd config
cp voice-config.example.js voice-config.local.js
# edit voice-config.local.js: PROVIDER_CONFIGURATION (Volcengine App ID/Access Token)
# and at least one entry in VOICE_PROFILES (your cloned speaker's ID)
```

`voice-config.local.js` is gitignored and only used as a first-run fallback — once you've
saved anything through Settings, the browser's `localStorage` takes over as the source of
truth for that browser.

### Translation / LLM Provider — server-side (only needed for Chinese → English)

Configured either through **Settings** → *Chinese → English* → *Translation Provider*
(saved server-side, never exposed to the browser), or via the server's own `.env`:

```bash
cd server
cp .env.example .env
# uncomment and fill in GEMINI_API_KEY
```

`server/.env` and `server/llm-credential.local.json` (written by Settings) are both
gitignored. `llm-credential.local.json` — once it exists — takes precedence over the
`GEMINI_API_KEY` env var.

### Server environment variables (`server/.env`)

| Variable | Default | Purpose |
|---|---|---|
| `VOICE_COPILOT_SERVER_PORT` | `4100` | Port the server listens on. |
| `VOICE_COPILOT_SERVER_HOST` | `127.0.0.1` | Bind address — localhost-only by default; this server holds credential material, so don't widen this without knowing why. |
| `VOICE_COPILOT_ALLOWED_ORIGIN` | `http://localhost:3000` | CORS allowlist for cross-origin API calls. Not relevant when the server serves its own frontend (the default, same-origin setup) — only matters if you point a *different* origin's frontend at this server's API. |
| `GEMINI_API_KEY` | — | Optional bootstrap for the Translation Provider; superseded once you save a credential through Settings. |

## Deploying to Vercel

`server/index.js` (a long-running Express app, `app.listen()`) is **not** what runs on
Vercel — Vercel doesn't execute persistent servers. Instead, `api/translate-stream.js` and
`api/settings/llm-provider.js` are Vercel Serverless Functions that import the exact same
business logic from `server/lib/translate.js`/`server/lib/credential-store.js` — nothing is
duplicated or forked between the two adapters, they just have different request/response
plumbing (Express `Router` vs. a plain `(req, res) => {}` handler).

Deployment is otherwise zero-config: Vercel auto-detects the static files at the repo root
(`index.html`, `css/`, `js/`, `config/`) as the public site and the `api/` directory as
serverless functions, from the existence of `api/*.js` files alone. `vercel.json` only sets
an extended `maxDuration` for `api/translate-stream.js`, since a full translation stream can
run longer than a default serverless timeout — adjust or remove this if your plan doesn't
support it. `package.json` at the repo root declares `@google/genai`, the one dependency
those two functions need; it isn't used for local development, which runs entirely out of
`server/` (see Quick Start above).

**Only one thing needs configuring for Chinese → English to work in production:** set
`GEMINI_API_KEY` in your Vercel project's **Settings → Environment Variables** (for
Production, and Preview if you want translation to work on preview deployments too) — not
`server/.env`, which Vercel never reads. Leave it unset (or empty) to run with Direct Speak
only, same fallback behavior as local dev.

No `VOICE_COPILOT_ALLOWED_ORIGIN`/CORS configuration is needed on Vercel at all: the static
frontend and the `/api/*` functions are served from the same Vercel domain, so
`js/translation-client.js`'s default same-origin fetch (`SERVER_BASE_URL = ''`) reaches them
directly. CORS only becomes relevant for the local dedicated server (`server/index.js`),
which is commonly accessed from a different origin during local dev — see the environment
variable table above.

Voice/TTS Provider credentials and your Voice Profile are unaffected by any of this — they
already go through **Settings → localStorage**, per browser, independent of which backend
(local `server/`, or Vercel) happens to be running.

## Usage

- **Speak** — click after typing/pasting your text. Audio starts playing as soon as the
  first chunk is ready (Time to First Audio is the core metric this app optimizes for).
- **Pause / Resume** — pausing doesn't stop generation; audio keeps buffering in the
  background so Resume never has to wait.
- **Replay** — replays the current round's already-generated audio from the start. Only
  available once generation has fully finished and you haven't clicked Stop since.
- **Stop** — tears down the current session and clears the buffered audio. Click Speak
  again to regenerate.
- **Chinese → English** — toggle in the main workspace. Off by default. When on, Speech
  Text is treated as Chinese input and translated on the fly before being spoken in
  English; when off, behavior is identical to the toggle not existing at all.
- **Settings** — top-right button. Configure Provider credentials and your Voice Profile
  without touching any file. Saving reloads the page to apply the new configuration.

## Project structure

```text
voice-copilot/
  index.html              Main page
  guide.html               User Guide page
  settings.html             Settings page
  package.json               Vercel-only: declares @google/genai for api/. Not used locally.
  vercel.json                 Vercel-only: extended maxDuration for api/translate-stream.js
  api/                      Vercel Serverless Functions — see "Deploying to Vercel" above
    translate-stream.js       Adapter for server/lib/translate.js's streamTranslate()
    settings/llm-provider.js  Adapter for server/lib/credential-store.js's readMaskedStatus()
  css/workspace.css        Styling
  js/                       Browser code (ES modules, no bundler)
    app.js                   Entry point / DOM wiring / Speak orchestration
    state.js                 Application state (two independent state machines: generation + playback)
    tts-client.js             Volcengine bidirectional streaming TTS WebSocket client
    volcengine-protocol.js    Binary protocol framing for the above
    streaming-audio-player.js MediaSource/SourceBuffer-backed low-latency audio playback
    translation-client.js     SSE client for the optional Chinese -> English path
    voice-profiles.js         Provider Configuration + Voice Profile loading (localStorage-first)
    settings-client.js        Settings panel wiring
    persistence.js            localStorage persistence for user preferences
  config/
    voice-config.example.js   Template — copy to voice-config.local.js
    voice-config.local.js     Your real credentials (gitignored)
  server/                   Independent Node.js runtime layer — see Quick Start
    index.js                  Express app: static hosting + API routes
    routes/                   translate-stream (SSE relay), settings (credential API)
    lib/                      translate.js (Gemini call), credential-store.js
    package.json               Own dependencies: express, dotenv, cors, @google/genai
```

## Notes

- **No build step.** Both the browser code and the server are plain, unbundled JavaScript.
  `npm install` inside `server/` is the only install step there is.
- **Streaming is the point.** TTS audio plays from the first chunk, not after full
  generation; the same applies to Chinese → English translation feeding TTS. If you're
  modifying this code, don't introduce buffering that waits for a complete response before
  acting on it — that defeats the app's core design goal.
- **This app makes zero calls back into the Live2D project's Express server (`app.js`)** in
  the parent repository, and depends on none of its routes, models, or runtime state. It's
  safe to copy `public/voice-copilot/` out into a brand-new repository at any time —
  `npm install` inside its `server/` and `node server/index.js` is the entire setup, with
  no path or import changes required.
# saywise
