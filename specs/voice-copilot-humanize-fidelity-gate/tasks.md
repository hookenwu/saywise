# Voice Copilot — Humanize Fidelity Gate — Tasks

- [x] T1. Spec (R1–R8).
- [x] T2. `server/lib/fidelity-gate.js`: checks, conservative repair, fallback.
- [x] T3. `streamTranslate()`: rewrite mode buffers, gates and emits one frame; `HUMANIZE_FIDELITY_GATE=off` restores streaming; a log line carries the verdict and reason codes only.
- [x] T4. Labelled fixtures `test/fixtures/humanize-fidelity-cases.json` (110) plus `test/test-fidelity-gate.js` (19/19).
- [x] T5. Held-out free text test: 12 new inputs, 12 free-tier flash-lite calls.
- [x] T6. Regression:
  - gateway 7/7, natural-delivery 11/11, audio-bridge 12/12, chromium-deep passes;
  - Teams e2e a–e pass; f fails only with the owner's uncommitted injector WIP (clean `main` passes);
  - the browser smoke test was not run, because it makes paid TTS calls.
- [x] T7. Deployed on the VPS (`~/saywise-start.sh`, gate on, Humanize on flash-lite). Live latency measured (research.md §3).
