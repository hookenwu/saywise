# Voice Copilot — Humanize via local model gateway — Spec

**Status:** Implemented. Deployed with the gateway **off**: the new model regressed on fidelity (`research.md` §3) \
**Relationship:** Incremental on top of `voice-copilot-natural-delivery`. It changes only
the inference backend of Humanize (`mode: "rewrite"`). Prompts, the Delivery levels, the
TTS payload and the Chinese → English path are unchanged.

## 1. Goal

Humanize (the same-language spoken rewrite for Direct Speak, in Chinese and English) runs on
the local Antigravity Manager gateway's `gemini-3.8-flash` instead of the Gemini API's
`gemini-3.1-flash-lite`. Chinese → English translation keeps its existing backend.

## 2. Requirements

- R1. Rewrite requests use the gateway's OpenAI-compatible `POST /v1/chat/completions`
  with `stream: true`. Content deltas are relayed to the existing SSE route with no added
  buffering. `reasoning_content` deltas are never forwarded.
- R2. The backend is selected by server environment only:
  - `HUMANIZE_LLM_BASE_URL` (for example `http://127.0.0.1:8045/v1`)
  - `HUMANIZE_LLM_API_KEY`
  - `HUMANIZE_LLM_MODEL` (default `gemini-3.8-flash`)
  - `HUMANIZE_LLM_REASONING_EFFORT` (default `none`)

  When `HUMANIZE_LLM_BASE_URL` is unset, rewrite uses the previous Gemini path unchanged.
  That is the rollback.
- R3. The gateway key exists only in the server process environment. It is never sent to
  the browser, never logged and never committed. The request/response contract of
  `/api/translate-stream` is unchanged, so the browser needs no change.
- R4. When the gateway is configured, a rewrite request does not require the Gemini
  credential. Translate requests still do.
- R5. Abort/stop semantics are unchanged. The browser abort cancels the gateway HTTP
  request. A transient error (429/503/network) is retried once, and only before any
  content was emitted.
- R6. Semantic accuracy first (`natural-delivery/research.md` §7.5). The new model must not
  increase added certainty/attitude words, dropped hedges, or altered numbers, money,
  times, terms or commitments, compared with the old model on the same corpus. If it does,
  the deployment keeps the rollback configuration.
- R7. No regression in Direct Speak with Humanize off, Chinese → English, the Audio Bridge
  or the Teams Web injector.

## 3. Out of scope

- Prompt changes, and any change to the TTS payload.
- Moving translation to the gateway.
- Paid TTS validation. It needs the owner's explicit approval.
