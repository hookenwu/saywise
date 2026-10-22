# Voice Copilot — Natural Delivery — Spec

**Status:** Implemented (see `tasks.md`) \
**Relationship:** Incremental feature spec on top of `voice-copilot-mvp` and
`voice-copilot-speaking-style`. It supersedes exactly one earlier decision —
speaking-style spec §9's blanket ban on `context_texts` — on the strength of the
measurements in `research.md`. Everything else in those specs stands.

## 1. Problem

Users report that the cloned voice "sounds like an AI": flat, mechanical,
read-aloud. Meeting listeners notice it, which defeats the point of a personal
voice copilot.

`research.md` measured the cause on the real Volcengine endpoint with the
user's real clone (`S_*`, `seed-icl-2.0`). The main driver is **not** a
missing acoustic parameter. The voice receives **written-register text**
(email-style sentences with no hesitation or spoken markers), and the clone
renders it the way a person reads a document aloud. Two secondary causes:

- the request is configured in a way that disables the provider's voice
  instruction channel (`model` was set on a clone voice);
- the translation path feeds TTS one finished sentence at a time, which
  breaks cross-sentence prosody planning.

## 2. Goal

Make the cloned voice sound as close as possible to the user speaking
spontaneously in a meeting, without:

- increasing Direct Speak time-to-first-audio (TTFA);
- changing the audio format, the Audio Bridge, or the Teams Web injector
  contract (MP3 chunks over `/audio-bridge`);
- silently rewriting Direct Speak text (MVP / speaking-style spec §2.2 still
  holds — rewriting is opt-in only).

Success metric (pre-registered in `research.md` §2): blind pairwise
preference judged by an audio LLM, plus UTMOS, speaker similarity, ASR error
and TTFA. The new default must win the pairwise test, with no regression in
speaker similarity or intelligibility, and no Direct Speak TTFA regression
beyond noise.

## 3. Concepts

### 3.1 Delivery (new user setting)

One setting, three levels, persisted per browser, default **Natural**:

| Level | TTS request (both Speak paths) | LLM text (Translated / Humanized Speak) |
|---|---|---|
| **Off** | Legacy payload, byte-for-byte: `model: seed-tts-2.0-expressive`, `use_tag_parser`, no `context_texts` | Legacy prompt (translation only) |
| **Light** | No `model`; `context_texts` = conversational delivery instruction | Spoken script: contractions, spoken clause structure, punctuation as a pause script (`, — …`), discourse markers. **No** hesitation fillers. |
| **Natural** | Same as Light | Light, plus sparse hesitation fillers ("uh", "um" / "嗯", "呃", "那个") where a speaker would naturally pause, never inside or before numbers, names or key facts |

Off exists for rollback and A/B comparison. It must reproduce the
pre-feature behavior exactly.

### 3.2 Humanize (new opt-in, Direct Speak only)

A checkbox, **off by default**, visible only when Chinese → English is off.
When it is on and Delivery is Light or Natural, the Speech Text first goes
through the same LLM endpoint in **rewrite** mode (same language as the
input, meaning preserved) and the rewrite is spoken. This is the only way
Direct Speak text is ever changed, and only when the user explicitly opts in.
The rewritten text is shown in the existing read-only panel, labelled
"Spoken Text". With Humanize off, Direct Speak sends the user's text verbatim,
exactly as before.

### 3.3 Streaming push granularity (behavioral fix, no setting)

On the LLM paths, text is pushed to the TTS session as soon as a
word-boundary-safe chunk is available. It is no longer held back until a full
sentence is complete. The provider does its own sentence segmentation with
lookahead (`research.md` E4b), so app-side sentence batching only added
latency and broke cross-sentence prosody.

## 4. Requirements

- R1. Delivery level is applied to every Speak round on both paths; Off
  reproduces the legacy wire payload.
- R2. For Light/Natural, the TTS request carries no `model` field and carries
  `additions.context_texts` with exactly one element (the provider honors
  only the first one).
- R3. Translated Speak prompt composition = base translation + Speaking Style
  (unchanged) + Delivery block + meaning guardrail (last, so it wins).
- R4. Humanize uses `POST /api/translate-stream` with `mode: "rewrite"`; the
  server allowlists `mode` (`translate` | `rewrite`) and `delivery`
  (`off` | `light` | `natural`), and defaults unknown values to `translate` /
  `natural`. Both adapters (Express, Vercel) share the normalization.
- R5. LLM-path pushes never split a word (English) and never hold back more
  than one partial word. Stop/abort/staleness semantics are unchanged.
- R6. No change to the audio format, `StreamingAudioPlayer`, the Audio Bridge,
  or the Teams injector.
- R7. Settings persist via `persistence.js` with allowlist validation, as
  every other preference does.

## 5. Out of scope (measured, rejected — see `research.md`)

- `seed-tts-2.0-expressive` / `seed-tts-1.1` / `seed-tts-2.0-standard` on the
  clone: no measurable naturalness gain over the default model, and `model`
  disables `context_texts`.
- Inline `<cot>` emotion tags and `audio_params.emotion`: no measurable effect
  on this clone.
- `mute_cut_*` silence trimming: ignored by the endpoint.
- Client-side pause shortening: judged neutral to slightly worse.
- Higher MP3 bitrate / 48 kHz: no meaningful naturalness gain, and more
  bytes over the bridge.
- `section_id`: accepted, but no verified benefit for single-turn rounds;
  left out until it can be measured.
- `tone_fidelity`: not supported on the bidirectional endpoint.
- Re-cloning the voice from better source audio: out of scope for code. It is
  the remaining big lever (`research.md` §6) and needs the user's recordings.
