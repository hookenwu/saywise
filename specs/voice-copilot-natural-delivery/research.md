# Voice Copilot — Natural Delivery — Research & Evidence

Every number below was measured on the **real** Volcengine V3 bidirectional endpoint
(`wss://openspeech.bytedance.com/api/v3/tts/bidirection`). It used the user's real cloned
voice (`S_*`, resource `seed-icl-2.0`) and the production translation model
(`gemini-3.1-flash-lite`), between 2026-10-22 and 2026-10-23. The tooling is in
`test/naturalness/`.

## 1. Baseline (before this feature)

- Payload for every Speak: `model: "seed-tts-2.0-expressive"`, `additions.use_tag_parser: true`,
  no voice instruction, MP3 24 kHz / 64 kbps.
- Direct Speak pushes the whole text in one `TaskRequest`. Translated Speak pushes one
  `TaskRequest` per completed sentence (`extractCompletedSentences`).
- The LLM prompt asks for "natural spoken English" but in practice produces written
  register: no hesitations, few spoken markers, email punctuation.

What the official docs say (text scraped from `docs.volcengine.com`; most of the doc
pages are JS-rendered and only partly readable):

- `model` is only for cloned voices, and once it's specified, `context_texts` voice
  instructions are not supported.
- `context_texts` is billed as zero characters. A field-tested third-party runbook
  ([blog.ax0x.ai](https://blog.ax0x.ai/doubao-tts-runbook-zh)) reports that only the first
  element is honored and that it does work on ICL 2.0 clones.
- `section_id` keeps cross-request context. `tone_fidelity` is not supported on the
  bidirectional interface. `audio_params.emotion` applies to `_emo_` 1.0 voices only.

## 2. Method

### 2.1 Metrics (pre-registered)

| Metric | Tool | Notes |
|---|---|---|
| **Blind pairwise preference** (primary) | Gemini audio understanding, `judge.mjs` | The judge hears clip A and clip B: "which sounds more like a real person naturally talking in a meeting (not reading aloud)", with a rubric covering intonation, timing, stress, sincerity and artifacts. **Each pair is judged in both orders**, so position bias cancels. Score +1 means the condition won both orders, −1 means the baseline won both. |
| Absolute human-likeness 1–10 | `abs.mjs` | Anchored scale. Used to compare against an official voice. |
| UTMOS22-strong | SpeechMOS | Naturalness MOS predictor. Trained on read speech, so it doesn't reward conversational delivery and serves only as a "no damage" check. |
| Speaker similarity | ECAPA-TDNN (SpeechBrain) | Cosine against the centroid of the baseline condition. Guards clone fidelity. |
| Intelligibility | Whisper-small | WER (EN) / CER (ZH, normalized to Simplified, fillers ignored). |
| Prosody | Praat (parselmouth) | F0 SD and 5–95 % range in semitones, intensity SD, internal pauses ≥150 ms. |
| Latency | harness timers | TTFA, from session start or Speak to the first audio chunk. |

### 2.2 Sampling

Generation is non-deterministic (identical requests produce different audio), so every
condition uses N ≥ 2 repetitions per text, across 4–6 meeting utterances (EN and ZH).

### 2.3 Judge reliability

`gemini-3.1-pro-preview` was used until its daily quota ran out, then `gemini-3.8-flash` and
`gemini-3.7-flash`. On the same E3 sample set, pro and 3.8-flash agreed:
fill_ctx +1.00 (8/0/0) vs +0.92 (11/0/1); punct_ctx +0.88 vs +0.54. Within any one
comparison table, a single judge model is used throughout.

## 3. Experiments

### E1 — Do the provider's control channels work on this clone? (detection test)
An extreme instruction ("用非常愤怒、大声吼叫的语气说" vs. "…轻柔、小声耳语…") on English text,
3 reps per channel. Mean F0: base 124.1 Hz, `context_texts` angry 126.6, whisper 122.9,
`<cot>` angry 125.3, `audio_params.emotion=angry` 125.5, expressive+cot 123.3. **No channel
moves the clone measurably.** Positive control, official 2.0 voice
`zh_female_vv_uranus_bigtts` in Chinese: base 274 Hz / 11.6 st range → angry 295 Hz /
14.2 st, so the harness and the instruction channel do work. The clone simply responds
weakly to instructions.

### E2 — Model selection on the clone (12 samples each; judge: 3.1-pro vs. the production config)

| Condition | Pref | W/L/T | UTMOS | Spk-sim | Err |
|---|---|---|---|---|---|
| prod (`seed-tts-2.0-expressive` + `use_tag_parser`) | — | — | 3.19 | 0.906 | 1.5 % |
| no `model` (default) | 0.00 | 2/2/8 | 3.31 | 0.878 | 1.3 % |
| `seed-tts-2.0-standard` | −0.25 | 3/6/3 | 3.21 | 0.897 | 1.4 % |
| `seed-tts-1.1` | −0.08 | 3/4/5 | 3.35 | 0.889 | 1.4 % |
| no `model` + conversational `context_texts` | **+0.33** | **6/2/4** | 3.33 | 0.890 | 1.4 % |

No model variant beats the default. `context_texts` (which requires dropping `model`)
helps slightly. All configurations scored only ~4.7/10 for human-likeness, with the judge
calling them "flat, robotic, read speech". **Parameter-level tuning is not the lever.**

### E3 — Text register and context (12 samples each; vs. no-model baseline)

| Condition | Pref (pro) | W/L/T | Pref (3.8-flash) | W/L/T | Abs. human | UTMOS | Spk-sim | Err |
|---|---|---|---|---|---|---|---|---|
| baseline (written text) | — | — | — | — | 5.13 | 3.31 | 0.899 | 1.5 % |
| + style `context_texts` | +0.25 | 3/0/9 | | | 5.50 | 3.34 | 0.890 | 1.8 % |
| + spoken punctuation (— … ?) | +0.88 | 7/0/1 | +0.54 | 8/1/3 | 5.50 | 3.30 | 0.893 | 1.6 % |
| + **light fillers / discourse markers** | **+1.00** | **8/0/0** | **+0.92** | **11/0/1** | **5.90** | 3.29 | 0.891 | 2.4 % |
| dialogue context (the other speaker's line) | +0.50 | 5/1/2 | | | 5.50 | 3.22 | 0.893 | 1.3 % |
| *official 2.0 voice (upper-bound reference)* | | | | | 6.00 | 4.08 | — | 0.6 % |

**Spoken-register text is the dominant lever**, with no cost to speaker similarity or
intelligibility. With fillers, the clone reaches the absolute human-likeness of an official
2.0 voice (5.9 vs. 6.0).

Prosodic signature of "mechanical": compared with the official voice, the clone has a
narrow F0 range (7.2–7.5 st vs. 12.0) and more, longer pauses (≈4.9 × 507 ms vs.
3.3 × 368 ms).

### E4 — Push granularity (EN, 12 samples each; judge 3.8-flash vs. whole text in one request)

| Condition | Pref | W/L/T | TTFA from session start |
|---|---|---|---|
| whole text, one request | — | — | 230 ms |
| one request per sentence, 350 ms apart (≈ legacy translated path) | **−0.75** | **1/10/1** | 873 ms |
| 3-word chunks, 80 ms apart | +0.04 | 5/5/2 | 375 ms |

**E4b — server buffering.** Three sentences, varying the gap between pushes. TTFA:
gap 0 → 196 ms, 200 → 723, 500 → 787, 1000 → 1325, 2000 → 1829. The server holds sentence
N until it sees text after it, as lookahead. App-side sentence batching therefore adds a
wait on top of the server's own wait, and it also stops the model planning prosody across
sentences. Fine-grained, word-safe chunks perform the same as whole text.

### E5 — Rejected ideas

- `additions.mute_cut_threshold`/`mute_cut_remain_ms`: no change in pause statistics
  (ignored by the endpoint).
- `speech_rate: +10`: mean pause 541 → 461 ms. Left to the user's existing Speed control.
- **Offline pause shaping** (compressing internal silences above 250 ms): −0.13 (0/3/9) vs.
  unshaped, so long pauses are not what listeners object to. No audio-pipeline change made.
- **Bitrate**: UTMOS 64 kbps 3.52, 160 kbps 3.61, 48 kHz/160 kbps 3.58 (n = 8 each). Within
  noise, and 2.5× more bytes over the Audio Bridge. Kept at 64 kbps.
- `section_id`: accepted without error at both levels. With no measurable single-turn
  effect, it was left out.
- `thinkingConfig.thinkingBudget: 0` for the LLM: TTFT unchanged (≈0.8–1.5 s), since the
  model doesn't think by default.

### E6a — Prompt adherence (flash-lite)
With a rules-only delivery prompt, flash-lite produced 1 filler in 4 outputs. Adding a
one-shot Written → Spoken example made it apply the rules in most outputs. Each delivery
block therefore carries one example.

### E6c — Bug found by the browser smoke test: Humanize changed language
A delivery block showing both an English and a Chinese example caused 4/8 English Humanize
rewrites to come back in Chinese. Fix: detect the output language on the server
(`detectLanguage`), show only that language's vocabulary and example, and append a
language lock in rewrite mode. Re-test: **21/21 language preserved**, including mixed
"API … log" Chinese text. The affected conditions were regenerated before §5.

### E6d — Fidelity: exact figures
One translated sample turned "两百毫秒" into "*about* two hundred milliseconds". Added the
rule "exact figures stay exact (never add about/around/roughly / 大概/左右/差不多)".
Re-test: 0/12 hedged numbers on the number-heavy inputs.

## 4. Decision

1. Light/Natural drop `model` and send a single conversational `context_texts`
   instruction. Small gain, never harmful (E2/E3).
2. The LLM paths emit a **spoken script**: Light uses punctuation and markers, Natural also
   adds sparse fillers (E3: the largest effect measured). Humanize brings the same to
   Direct Speak (opt-in at first, on by default since 2026-10-23 at the user's request).
3. The LLM paths push word-safe chunks immediately instead of whole sentences (E4/E4b).
4. Default is Natural. Off is byte-for-byte legacy, verified against git `666cec1` for
   both the TTS payload and the LLM prompt.

## 5. End-to-end result through the shipped code

`test/naturalness/run-ab.mjs` drives the shipped `js/tts-client.js`, `js/delivery.js` and
`server/lib/translate.js` against the real endpoints, using the legacy and new push logic
exactly as `app.js` runs them. Corpus: 6 Direct texts (4 EN, 2 ZH) and 6 Chinese inputs,
2 reps each (n = 12 per condition). Judge `gemini-3.7-flash`, both orders.

| Path | Condition | Pref vs. legacy | W/L/T | Human (cond vs. legacy) | UTMOS | Spk-sim | Err | TTFA median / p90 |
|---|---|---|---|---|---|---|---|---|
| Direct | legacy (Off) | — | — | — | 3.31 | 0.895 | 1.5 % | 404 / 584 ms |
| Direct | Natural, Humanize off (default) | +0.04 | 4/3/5 | 5.17 vs. 5.17 | 3.23 | 0.887 | 2.2 % | 417 / 446 ms |
| Direct | **Natural + Humanize** | **+0.67** | **8/0/4** | **6.08 vs. 4.83** | 3.18 | 0.897 | 1.3 % | 1579 / 1880 ms |
| Translated | legacy (Off) | — | — | — | 3.60 | 0.896 | 1.5 % | 1625 / 1751 ms |
| Translated | Light | +0.42 | 7/2/3 | 5.33 vs. 4.67 | 3.64 | 0.905 | 2.9 % | 1492 / 1741 ms |
| Translated | **Natural (default)** | **+0.75** | **9/0/3** | **5.63 vs. 4.42** | 3.60 | 0.897 | 2.8 % | 1632 / 1809 ms |

Earlier iterations of the same comparison, before the E6c/E6d prompt fixes, gave
Translated Natural +0.83 (10/0/2) and Humanize +0.92 / +1.00 (11/0/1, 12/0/0). Humanize's
first iteration was partly invalid (E6c). The table reports only the final, shipped prompt.
**Across all three iterations neither condition lost a single comparison.** Sign test for
the final rows: 9/0 → p ≈ 0.004, 8/0 → p ≈ 0.008.

Translated-path TTFA medians across the three runs were 1501 / 1491 / 1632 ms, against
1625 ms for legacy. LLM time-to-first-token (0.8–1.8 s) dominates and varies from run to
run, so the honest conclusion is **no latency regression**, not a speed-up.

Error rates above 2 % on the translated rows are mostly ASR number formatting: the LLM
spells out "two hundred" (good for TTS) and Whisper writes "200". The one genuine error was
a sound-alike mishearing ("Sorry" → "Laurie").

**Reading the result.**
- Where the text can be spoken-style (Translated Speak, and Direct Speak with Humanize), the
  new default wins decisively, with no latency regression for translation.
- Direct Speak with verbatim text gains little: the TTS instruction channel is weak on this
  clone (E1). Humanize is the strong lever there, at the cost of one LLM round trip
  (≈ +1.2 s TTFA). It was opt-in at first and is on by default since 2026-10-23 at the user's
  request. The trade-off to keep in mind is that it changes the user's words: rewrites can add
  small nuances (e.g. "要是现在**非得**加这个功能"), even with the meaning guardrail in place.

## 6. Remaining levers (outside code)

- **Re-clone from better source audio.** The clone responds weakly to instructions and has
  a narrow intonation range (E1, E3) compared with official 2.0 voices. That is a property
  of the voice's training sample. A 30–60 s recording of the user speaking spontaneously
  and expressively in a quiet room (not reading a script) is the next big improvement.
  Every measurement here can be rerun against a new `S_*` ID with `test/naturalness/`.
- Typing in spoken style ("So, uh, …") already gets the full benefit in Direct Speak
  without Humanize.

## 7. Chinese review (2026-10-23): restrained Chinese Humanize prompt — measured, not shipped

Goal: Chinese delivery without stacked 嗯/呃/那个 and without meaning drift, at least as
natural as what ships. Budget for the round: ≤ 2,000 TTS characters and ≤ 70 Gemini calls.
Spent: **926 TTS characters** (≤ ¥0.93 at a deliberately high ¥10 / 10k-character ceiling)
and **66 Gemini calls** (free-tier key). Raw data: `test/naturalness/results/zh/`.

### 7.1 Re-reading existing data (no API calls)

- Chinese-only slice of E3: the particle/punctuation script with **no fillers** won 4/4, the
  same as the filler script (4/4). Fillers are not what carries Chinese naturalness.
- The clone pauses at almost every Chinese comma for about 500 ms (zh2: 4 internal
  punctuation marks, 4 pauses, mean 462–542 ms). The official 2.0 voice pauses about 370 ms
  and has a wider F0 range (11.5 vs. 7.8 st).
- Offline pause compression on Chinese: −0.25 (n = 4). Rejected again.
- The shipped Humanize rewrites add certainty and attitude words ("估计得往后推", "非得加").

### 7.2 Z1 — text-only check of the shipped prompt (flash-lite, 6 Chinese inputs)

| Prompt | n | 嗯/呃 | Outputs with ≥ 2 hesitation sounds | Added certainty words (估计/非得/其实…) | Dropped source hedges | Length vs. source |
|---|---|---|---|---|---|---|
| shipped (generic block, zh vocab) | 12 | 7 | 5 | 6 | 0 | 1.17× |
| restrained zh block (final, `restrained-prompt.patch`) | 6 | 1 | 0 | 0 | 1 (好像) | 1.03× |

### 7.3 Z2/Z3 — audio, same baseline clips (judge `gemini-3.7-flash`, both orders)

| Condition vs. shipped Humanize | Hypothesis | W/L/T | Human | Pauses | Spk-sim |
|---|---|---|---|---|---|
| Z2: "fewer commas", restrained, near-verbatim | fewer pauses means less recitation | 0/5/1 | 5.42 vs. 6.83 | 3.8 vs. 4.7 | 0.954 vs. 0.960 |
| Z3: particles encouraged, at most one 嗯/呃, no added certainty | keeps naturalness, fixes fidelity | 0/6/0 | 5.58 vs. 6.67 | 4.3 vs. 4.7 | 0.945 vs. 0.960 |

- **Fewer commas does not help.** It removed pauses but was judged stiffer, which agrees with E5.
- Both variants lost to the shipped prompt, even on c6, where the two texts differ by a word or
  two. Two explanations remain open:
  1. The judge rewards fillers. Its prompt names fillers as acceptable, and its reasons cite
     "casual fillers".
  2. The 6 baseline clips were good takes. Both rounds reused the same 6 shipped-prompt
     clips, so take-to-take variance is not controlled.
- Separating the two would need more audio and judge calls. That was not spent.

### 7.4 Decision

- **Kept the shipped prompt.** There is no audio evidence that the restrained version is more
  natural, and two measurements say it is less natural to the judge.
- The restrained prompt is archived as `test/naturalness/results/zh/restrained-prompt.patch`.
  It is the better choice if fidelity (no added 估计/非得, no stacked fillers) matters more
  than judge-rated naturalness. That is a product decision. The listening pairs in
  `test/naturalness/results/samples/zh/` let a human decide it at zero API cost.
- Still the biggest Chinese lever, outside code: **re-clone from spontaneous Chinese speech**
  (§6). The clone's narrow F0 range and its uniform ~500 ms comma pauses are properties of
  the voice, not of the text.
