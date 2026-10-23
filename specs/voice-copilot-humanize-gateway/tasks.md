# Voice Copilot — Humanize via local gateway — Tasks

- [x] T1. Gateway self-check: `/v1/models` 200 and a real completion; measure TTFT with each reasoning setting (research.md §1).
- [x] T2. `server/lib/humanize-backend.js`: environment config plus an OpenAI-compatible SSE generator, no new dependency.
- [x] T3. `streamTranslate()` routes rewrite requests to the gateway when it is configured; `needsGeminiCredential()` is used in both adapters.
- [x] T4. `test/test-humanize-gateway.js`: 7 tests against a local mock gateway.
- [x] T5. Text A/B old vs. new, on fidelity, language, naturalness and TTFT (research.md §2).
- [x] T6. Regression:
  - `test-natural-delivery.js` 11/11.
  - `test-audio-bridge.js` 12/12.
  - `test-chromium-deep.js` passes.
  - `test-e2e-teams-webrtc.js`: a–e pass. Assertion f fails only with the owner's uncommitted injector WIP; a clean `main` checkout passes all of Gate 3.
  - `test-natural-delivery-browser.js` was not run: it makes paid TTS calls, which need approval.
- [x] T7. Decision: gateway **off** in deployment (research.md §3). The service is restarted from `server/`, so translation and Humanize find `server/.env`.
