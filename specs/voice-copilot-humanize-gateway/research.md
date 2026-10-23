# Humanize via local gateway — Evidence (2026-10-23)

Both backends ran through the shipped `streamTranslate()` with the same rewrite prompt,
`delivery: natural`. Old is `gemini-3.1-flash-lite` (Gemini API, free tier). New is the
gateway's `gemini-3.8-flash` with `reasoning_effort: none`; the gateway reports it as
`gemini-3.8-flash-tiered`. No TTS was called. Raw data is in
`test/naturalness/results/humanize-gateway/`.

## 1. Gateway checks

- `GET /v1/models` returned HTTP 200, and a real completion returned a correct answer.
- Default reasoning puts the first content token at 5.4–7.7 s. `reasoning_effort: none`
  removes the reasoning (0 reasoning chars) and keeps the same model.
- `minimal` and `low` reroute to `gemini-3.8-flash-low`, a different model, so they are not used.
- `thinking: {type: disabled}` and Google `thinking_budget: 0` are ignored by the gateway.

## 2. Text A/B

The corpus is the existing 6 Chinese texts plus 6 fidelity texts (money 1,280.50 元, a
10 月 31 日 commitment, P99/QPS with 左右, 48 万 / 30 %, PENDING/FAILED, a 10 点 release),
at 2 reps each, so n = 24 Chinese. It also includes the 4 English texts, 1 rep each.

| Metric | old flash-lite | new 3.8-flash |
|---|---|---|
| Language preserved (zh→zh, en→en) | 28/28 | 28/28 |
| Numbers, money, times, codes (1,280.50 / 10 月 31 日 / P99 350 / 48 万 30 % / PENDING / 10 点) | all kept | all kept |
| Meaning changes flagged in **both** orders by the blind judge (`claude-sonnet-4-6`) | **5/24** | **8/24** |
| Added certainty or commitment words (肯定/保证/真/估计…) | 2 | 5 |
| Added 其实 (judge: implies a correction or hidden contrast) | 7/24 | 15/24 |
| Dropped source hedge | 左右 in "2 万左右" (2/2), which turns an estimate into an exact figure | none of substance (我觉得 → 我感觉 once) |
| 嗯/呃 count / outputs with ≥ 2 hesitations | 16 / 5 | 5 / 0 |
| Text naturalness, new vs. old (blind, both orders) | — | 5 W / 12 L / 7 T (mean −0.29) |
| TTFT median / p90, Chinese | **805 / 1004 ms** | **2433 / 3338 ms** |
| TTFT median, English | 596 ms | 1748 ms |

Meaning changes worth naming. New model:

- f2: 承诺 → 保证 in both reps, plus "其实我肯定会".
- f4: 验收后 → 验收**合格**后, which adds a payment condition.
- f5: "其实是 PENDING", which turns a neutral status into a correction.

Old model:

- f3 drops 左右 (2/2).
- zh2 adds 估计.
- f6 adds 打算 / 准时.

## 3. Decision

The new model is a clear regression on certainty and business commitments, the categories
the owner singled out. It is also less natural to the text judge, and it triples
time-to-first-token. Per the owner's rule (`natural-delivery/research.md` §7.5), **it is not
enabled**. The code ships with the gateway off, which is the rollback configuration and is
identical to the previous behaviour. Enabling it is one environment variable
(`HUMANIZE_LLM_BASE_URL`).

The old model's own drift (dropping 左右, adding 估计) is a known issue and stays open.
