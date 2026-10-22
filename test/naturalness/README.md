# Naturalness evaluation kit

The tooling behind `specs/voice-copilot-natural-delivery/research.md`. All of it runs
against the **real** Volcengine and Gemini endpoints using your local credentials
(`config/voice-config.local.js`, `server/.env`'s `GEMINI_API_KEY`). It isn't part of the
automated test suite, because it needs credentials, makes paid API calls, and takes
minutes per run.

| File | What it does |
|---|---|
| `run-ab.mjs` | End-to-end A/B through the **shipped** `js/tts-client.js`, `js/delivery.js` and `server/lib/translate.js`, using legacy vs. new push logic. Writes MP3s, `manifest.json` and `timing.json` (TTFA). |
| `param-harness.mjs` | Raw V3 bidirectional client that sends arbitrary `req_params`/`additions`/`audio_params`. Used for the parameter experiments E1–E5. |
| `texts.mjs` | Evaluation corpus of meeting utterances (EN + ZH Direct Speak, ZH → EN). |
| `judge.mjs` | Blind pairwise "which sounds more like a real person in a meeting" judge using Gemini audio understanding. Every pair is judged in **both** A/B orders to cancel position bias. Score +1 means the condition won in both orders. |
| `abs.mjs` | Absolute 1–10 human-likeness rating with anchors, used for cross-voice upper-bound comparisons. |
| `evaluate.py` | UTMOS22-strong MOS, ECAPA speaker similarity (vs. the reference condition's centroid), Whisper-small WER/CER (Chinese normalized to Simplified, fillers ignored), plus prosody stats. |
| `prosody.py` | Praat F0 SD/range (semitones), intensity SD, internal pause count and length. |
| `shape.py` | Offline pause shaper (experiment E5b, rejected). |

## Setup (CPU only, ~2 GB on disk)

```bash
python3 -m venv ~/.cache/saywise-eval/venv
~/.cache/saywise-eval/venv/bin/pip install --no-cache-dir torch torchaudio --index-url https://download.pytorch.org/whl/cpu
~/.cache/saywise-eval/venv/bin/pip install --no-cache-dir -r test/naturalness/requirements.txt
```

Keep the venv on disk, not in `/tmp`: `/tmp` is a small tmpfs on some machines.

## Reproduce the headline A/B (research.md §5)

```bash
node --env-file=server/.env test/naturalness/run-ab.mjs /path/to/out 2
node --env-file=server/.env test/naturalness/judge.mjs /path/to/out direct_legacy direct_natural,direct_humanize gemini-3.7-flash
node --env-file=server/.env test/naturalness/judge.mjs /path/to/out trans_legacy trans_natural,trans_light gemini-3.7-flash
~/.cache/saywise-eval/venv/bin/python test/naturalness/evaluate.py /path/to/out/manifest.json /path/to/out/eval.json
```

Free-tier Gemini keys allow about 250 requests per model per day. One pairwise comparison
costs 2 requests, so spread runs across `gemini-3.8-flash` / `gemini-3.7-flash` /
`gemini-3.5-flash` if needed. Judges agreed with each other (research.md §2.3).
