# Voice Copilot — Humanize Fidelity Gate — Spec

**Relationship:** Incremental on top of `voice-copilot-natural-delivery` (Humanize) and
`voice-copilot-humanize-gateway`. It changes only what the server sends back for
`mode: "rewrite"`.

## 1. Problem

Humanize rewrites sometimes change meaning. Measured on the shipped model
(`gemini-3.1-flash-lite`, humanize-gateway `research.md` §2):

- it adds certainty or commitment (估计, 肯定, 打算, 准时);
- it drops an approximation (2 万左右 → 2 万);
- it adds an attitude (其实, 15–30 % of rewrites).

Other models showed further failure classes: commitment swaps (承诺 → 保证), added payment
conditions (验收 → 验收合格) and added facts (刚才看了). The owner's rule is
accuracy before naturalness (`natural-delivery/research.md` §7.5).

## 2. Goal

Before any Humanize text reaches the TTS voice, check it against the user's original
text deterministically, with **no extra LLM call**. Then:

- **pass** if it is meaning-equivalent;
- **repair** it if the only problem is an added word whose deletion provably restores the
  source meaning;
- otherwise **fall back** to the original text, verbatim.

Natural spoken features (particles, 嗯/呃, clause shape, colloquial synonyms) must survive
whenever the meaning does.

## 3. Requirements

- R1. **Scope.** Only `mode: "rewrite"` is affected. Translation, Direct Speak with Humanize
  off, the TTS payload, the Audio Bridge and the Teams injector are untouched. The gate works
  for both backends (Gemini, gateway).
- R2. **Checks.** The output must preserve the source's:
  1. numbers with their units (digits and Chinese numerals are equivalent: 两秒 = 2 秒);
     amounts, percentages, dates, times, weekdays and relative-date words;
  2. ASCII technical terms and identifiers (API, P99, PENDING);
  3. negation count, with lexicalised forms excluded (不过, 不好意思, A-not-A questions such
     as 能不能);
  4. subject pronouns, so that who commits stays the same (我/我们/你…, with 咱们 ≡ 我们);
  5. certainty and hedging (可能, 估计, 好像, approximations like 左右), strong certainty
     (肯定, 一定), obligation (必须, 只能), commitment (承诺, 保证), intent (打算, 计划),
     timing promises (准时, 第一时间), conditions (如果≡要是, 万一, 只要, 除非), qualifiers
     (合格, 至少, 以内), before/after relations (前/后) and aspect (已经, 还没, 刚才).

  These are compared as sets of canonical members, where colloquial synonyms count as one
  member.

  English gets the same structure with its own lexicon (number words, n't/not/never,
  maybe/probably, definitely, promise/guarantee, if/unless…).
- R3. **Repair is conservative.** Only an added word on a short allowlist of pure modal or
  attitude adverbs may be deleted: 其实, 肯定, 绝对, 估计, 恐怕, 怕是, 准时, 当然 /
  definitely, certainly, surely, absolutely. Deletion happens only when the word is not
  negated, not part of a compound (估计值, 肯定的), and not in the source. The repaired text
  must then pass every check. Anything else falls back.
- R4. **Fallback.** Empty output, or any unrepairable mismatch, sends the source text
  verbatim. The browser contract is unchanged (SSE `{content}` frames).
- R5. **Latency.** The rewrite is buffered to completion before it is checked. The cost is
  the model's generation tail (measured median ≈ 100 ms on flash-lite) plus a check of
  about 1 ms. The added time-to-first-content is measured and reported.
- R6. **Switch.** `HUMANIZE_FIDELITY_GATE=off` restores pre-gate streaming exactly. It is on
  by default.
- R7. **Observability.** One log line per rewrite carries the verdict and reason codes. It
  never contains the user's text.
- R8. **Regression tests.** They use the recorded real rewrites with ground-truth labels and
  report missed unsafe outputs (target 0), false fallbacks on safe outputs, and the fallback
  rate. They also include targeted adversarial cases for each check and each false-positive
  trap.
