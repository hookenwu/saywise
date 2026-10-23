# Humanize Fidelity Gate — Evidence (2026-10-23)

No paid API was called. Text came from recorded rewrites plus 12 + 12 free-tier
flash-lite calls (held-out set and latency check).

## 1. Recorded rewrites (110, hand-labelled; `test/fixtures/humanize-fidelity-cases.json`)

Label `unsafe` = the rewrite, as-is, changes meaning: facts, certainty, commitment, condition,
subject, attitude or degree.

| | n | spoken as-is (pass) | repaired | fallback to original |
|---|---|---|---|---|
| unsafe | 61 | **0** (2 before the decision class, see §5) | 32 | 29 |
| safe | 49 | 47 | 0 | **2** (false positives) |

- **Misses:** the only 2 were 决定 → 看看 (a weakened decision). The decision class (§5) catches them.
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
  (以银行到账为准 → 看银行处理速度), unless another check catches them.
- **Conservative structure checks.** Negation counts and 前/后 counts can reject a correct
  paraphrase (漏听 for 没听到, 一…就 for …后就). Such cases are spoken verbatim, which costs
  naturalness, not accuracy.
- **Fallback rate.** To lower it, a prompt-level "don't add 其实/估计/…" hint would cut the
  drift at the source. That changes the prompt and needs an audio check (paid), so it is not
  done here.

## 5. Decision-state fix and fallback analysis (2026-10-23, round 2)

### 5.1 决定 → 看看

New `decision` class (zh: 决定/敲定/拍板/定下来, 同意/批准, 确认, 拒绝; en: decide, confirm, approve,
agree, reject…). It tracks only **decisive** verbs, so dropping or adding one is a mismatch, while a
tentative 看看/考虑 on its own (very common spoken filler: 先看看反馈，再决定) is not.

- Effect on the 110 recorded rewrites: the 2 known misses now fall back. That leaves **0 unsafe rewrites
  spoken as-is**, with no new false positive (still 2 of 49).
- New targeted cases: 决定 → 考虑 / 看看, 同意 → 考虑, 确认 → 看一下, 敲定 → 定 all fall back.
  看看 + 决定, 确认 → 去确认, 敲定 → 定下来 all pass.

I also scanned every passing rewrite for other changes in state verbs: 会/可以/能/需要/打算/计划/
上线/修复/完成…. The only real one was 决定 → 看看. The rest are synonyms (修复 = 修好, 需要 → 得,
上线 → 上) or neutral additions (就能到账).

Gate cost: 0.18 ms per check (median over 2,200 runs). Live: gate_ms 0–3 per request, unchanged.

### 5.2 Why the fallback rate is high (31 fallbacks among the 110 recorded rewrites)

| Cause | n | Examples |
|---|---|---|
| **Rule false positive** | 2 (6 %) | 漏听了 for 没听到 (negation count); 有问题随时找我 → 如果有问题的话 (implicit condition made explicit) |
| **Real semantic risk** (certainty, commitment, decision, subject, approximation) | 20 | drops 左右 (2); adds 我们打算 / 我们…准时 (2); 承诺 → 保证 (2); adds 合格 (1); 决定 → 看看 (2); 可能 → 估计 / 恐怕 / 只能 (3); drops 我觉得 / 好像 (8, all from the restrained-prompt experiment) |
| **Rewrite quality** (embellishment or invented detail that shifts nuance) | 9 | adds 咱们 + 其实, 不太稳定, 正式发版, 刚才看了, 看过了; 没有加 → 忘了加; 以银行到账为准 → 看银行处理速度; a garbled "要是那个……万一" |

By configuration:

| Config | n | pass | repaired | fallback (on safe) |
|---|---|---|---|---|
| **Shipped** (flash-lite, current prompt): old + z1old + holdout | 52 | 19 | 19 | 14 (1) = 27 % |
| Gateway 3.8-flash (not deployed) | 28 | 8 | 13 | 7 (1) |
| Restrained-prompt experiment (not deployed) | 30 | 20 | 0 | 10 (0) |

**Main reasons, in order:**

1. **The model's own drift.** 29 of 31 fallbacks are rewrites that really change meaning, not
   over-strict rules (2 false positives of 49 safe rewrites, 4 %).
2. **The shipped Chinese delivery prompt invites it.** Its vocabulary lists 其实 as both a
   discourse marker and a filler (`server/lib/translate.js` DELIVERY_VOCAB.zh), and 32 of 102
   Chinese rewrites add 其实. Most are repaired by deletion. In 5 fallbacks, 其实 travels with
   another change (咱们, 不太). When a rewrite "colloquialises", flash-lite also tends to add a
   subject or intent (我们打算, 咱们) and to swap hedges (可能 → 估计).
3. **The corpus is fact-dense.** The 6 fidelity texts (money, commitments, conditions) are 5/12 of
   the shipped fallbacks among old outputs. Ordinary meeting chatter falls back less.

**Lever not taken here.** Removing 其实 from the Chinese vocabulary and adding "don't add a subject /
intent / hedge" to the rewrite prompt would cut drift at the source. It is a prompt change, and the
last prompt change lost the audio judge (`natural-delivery/research.md` §7), so it needs a paid TTS A/B
first.
