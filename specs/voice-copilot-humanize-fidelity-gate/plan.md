# Voice Copilot — Humanize Fidelity Gate — Plan

## 1. Where it sits

```text
Speech Text ─▶ /api/translate-stream (mode: rewrite)
                └─ streamTranslate()
                     ├─ streamModel(): Gemini flash-lite or the gateway, unchanged
                     ├─ buffer the full rewrite (tail after first token ≈ 100 ms)
                     ├─ gateRewrite(source, rewrite, lang)   ← server/lib/fidelity-gate.js, ~1 ms
                     └─ one SSE {content} frame: rewrite | repaired rewrite | original verbatim
```

Translate mode, and rewrite with `HUMANIZE_FIDELITY_GATE=off`, take the old streaming path
unchanged. The browser contract is unchanged, so `js/` needs no change.

## 2. `server/lib/fidelity-gate.js`

`findMismatches(source, output, lang)` returns reason codes. `gateRewrite()` returns
`{ verdict, text, reasons }`.

| Check | Chinese | English | Comparison |
|---|---|---|---|
| fact | ASCII and Chinese numerals → value + canonical unit (两秒 = 2 秒, 块 = 元, 号 = 日), percentages, weekdays, relative-date words | digits and spelled-out numbers → value | set equal |
| term | Latin tokens (API, P99, PENDING) except OK/okay | acronyms and identifiers | set equal |
| negation | count of 不/没/别/未/勿, after removing lexicalised words (不过, 不好意思…) and A-not-A questions | not/n't/no/never… | count equal |
| order | 前/后 counts, after normalising 之前/之后 and removing 然后/最后/往后… | — | equal |
| subject | pronouns, 咱们 ≡ 我们 | pronouns, minus "you know"/"I mean" | no added pronoun (pro-drop allowed) |
| committer | pronoun before 会/承诺/保证/负责… | pronoun before will/'ll/promise… | unchanged when the source names one; otherwise only an existing participant |
| classes | hedge, approx, opinion, certain, must, commit, intent, timing, condition, qualifier, aspect (with the deictic 刚才 exemption), attitude, degree | hedge, approx, certain, must, commit, intent, timing, condition, date, aspect, attitude | canonical member sets equal |

**Repair:** only an added word from the deletable list (其实 确实 真 肯定 绝对 估计 恐怕 怕是 准时
当然 / definitely certainly surely absolutely actually really) is deleted. It is never deleted
when negated (Chinese) or when part of a compound (估计值, 肯定的). The repaired text must then
pass every check, or the result is a fallback.

## 3. Verification

- `test/test-fidelity-gate.js` (19 tests):
  - 110 hand-labelled real rewrites from 3 prompt/model variants plus 12 held-out inputs;
  - targeted cases for every check and every known false-positive trap;
  - streamTranslate wiring: one gated frame, fallback, switch off, abort while buffering.
- Regression: `test-humanize-gateway`, `test-natural-delivery`, `test-audio-bridge`,
  `test-chromium-deep`, `test-e2e-teams-webrtc`.
- Live: time-to-first-content with the gate on vs. off on the running service.
