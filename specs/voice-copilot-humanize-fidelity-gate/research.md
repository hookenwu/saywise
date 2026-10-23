# Humanize Fidelity Gate — Evidence (2026-10-23)

No paid API was called. Text came from recorded rewrites plus 12 + 12 free-tier
flash-lite calls (held-out set and latency check).

## 1. Recorded rewrites (110, hand-labelled; `test/fixtures/humanize-fidelity-cases.json`)

Label `unsafe` = the rewrite, as-is, changes meaning: facts, certainty, commitment, condition,
subject, attitude or degree.

| | n | spoken as-is (pass) | repaired | fallback to original |
|---|---|---|---|---|
| unsafe | 61 | **2** (known misses) | 32 | 27 |
| safe | 49 | 47 | 0 | **2** (false positives) |

- **Misses:** both are 决定 → 看看 (a weakened decision), a meaning change no word list covers.
  The fixture records them as known misses.
- **False positives:** 漏听了 vs. 没听到 (a negation count difference), and 有问题随时找我 →
  如果有问题的话 (an implicit condition made explicit). Both fall back to the original, which is
  safe.
- **Repairs:** all 32 repaired texts re-pass every check. They keep 嗯/呃/那个, 呢/吧/啊 and the
  spoken clause shape. Typical repair: delete an added 其实.

**Held-out** (12 new inputs, never used for tuning; flash-lite with the shipped prompt):

- 8 unsafe: 0 passed, 3 repaired, 5 fell back.
- 4 safe: 3 passed, 1 fell back (the 如果 case).

The spoken fallback rate, about 50 % here, is high because flash-lite's own drift is high. In
8 of 12 rewrites it added 其实, 估计, 大概, 咱们, or a new fact.

## 2. Fallback rate by source (recorded set)

| Source | n | repaired | fallback |
|---|---|---|---|
| flash-lite, shipped prompt (old + z1old + holdout) | 52 | 19 | 12 (23 %) |
| gateway 3.8-flash | 28 | 13 | 7 |

## 3. Latency (live service, same 6 Chinese inputs, Gemini flash-lite)

| | median first content | median total |
|---|---|---|
| gate off (4199) | 842 ms | 919 ms |
| gate on (4100) | 891 ms | 891 ms |

The gate check itself takes 0–4 ms. The cost is waiting for the model's last token: about
+50 ms on the median here, within LLM jitter, and an upper bound of ~150 ms from the earlier
tail measurement. TTS is unchanged, so this is also the time-to-first-audio impact.

## 4. Known limits

- **Lexicon-based.** It cannot see paraphrased meaning changes without a marker word
  (决定 → 看看, 以银行到账为准 → 看银行处理速度), unless another check catches them.
- **Conservative structure checks.** Negation counts and 前/后 counts can reject a correct
  paraphrase (漏听 for 没听到, 一…就 for …后就). Such cases are spoken verbatim, which costs
  naturalness, not accuracy.
- **Fallback rate.** To lower it, a prompt-level "don't add 其实/估计/…" hint would cut the
  drift at the source. That changes the prompt and needs an audio check (paid), so it is not
  done here.
