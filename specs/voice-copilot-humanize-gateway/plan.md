# Voice Copilot — Humanize via local model gateway — Plan

## 1. Files

- `server/lib/humanize-backend.js` (new): `humanizeBackend()` reads R2's environment
  variables. It returns `null` when the gateway is not configured.
  `streamChatCompletions({ baseUrl, apiKey, model, reasoningEffort, systemInstruction, text, signal })`
  is an async generator over the OpenAI-compatible SSE stream that yields `{ content }`.
  It uses Node's built-in `fetch`, with no new dependency.
- `server/lib/translate.js`: `streamTranslate()` delegates to the gateway when
  `mode === 'rewrite'` and `humanizeBackend()` is set. It keeps the same system instruction
  and the same once-before-emit retry rule. `needsGeminiCredential(mode)` is shared by
  both adapters.
- `server/routes/translate.js` and `api/translate-stream.js`: the credential check becomes
  `needsGeminiCredential(mode) && !apiKey`.

## 2. Why `reasoning_effort: "none"`

`gemini-3.8-flash` on this gateway reasons by default, which puts the first content token
at 5.4–7.7 s. With `none`, it doesn't reason and the first token arrives in about 2–3.5 s.
The gateway's response reports the model as `gemini-3.8-flash-tiered`. `minimal` and `low`
make the gateway reroute to `gemini-3.8-flash-low`, a different model, so they are not used.

## 3. Deployment

The service starts from `server/`, so `dotenv` finds `server/.env` (the Gemini key for
translation). The gateway variables are injected at launch by a launcher that reads the key
from the gateway's own `.env`. The key is never written into the repo.

## 4. Verification

1. Unit tests (`test/test-humanize-gateway.js`) with a local mock OpenAI-compatible SSE
   server:
   - delta relay with `reasoning_content` ignored;
   - the request body (model, `stream`, `reasoning_effort`, system and user messages);
   - abort;
   - retry before emit only;
   - fallback when the gateway is unset;
   - the credential rule.
2. Text A/B, old vs. new model, on the existing Chinese corpus plus a fidelity set (numbers,
   money, times, terms, certainty, commitments), measuring automated fidelity counts and
   TTFT. Free: the gateway, plus the free-tier Gemini key.
3. Regression: `test-natural-delivery.js`, `test-audio-bridge.js`, and the browser smoke test.
4. A live check against the running service: a rewrite request goes to the gateway (the
   server log names the model), and translate still goes to Gemini.
