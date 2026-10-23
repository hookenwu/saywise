# Chinese Humanize listening pairs (research.md §7)

The same cloned voice and the same Natural TTS payload. Only the Humanize script differs.

| Text | shipped prompt | restrained prompt |
|---|---|---|
| zh2 | `shipped__zh2.mp3`: 嗯，我理解你的意思。不过呢，我有点担心时间，要是现在加这个功能，那个测试可能就来不及了，发布估计得往后推了。 | `restrained__zh2.mp3`: 嗯，你的意思我明白。不过我有点担心时间，要是现在加这个功能的话，测试可能就来不及了，那发布得往后推。 |
| c2 | `shipped__c2.mp3`: 这个方案我看过了，其实整体没啥大问题，不过呢，成本那块我觉得还得再核对一下，尤其是第三季度的服务器费用。 | `restrained__c2.mp3`: 这个方案我看了，整体没啥问题。不过成本那块，我觉得还得再算算，尤其是第三季度的服务器费用。 |
| c6 | `shipped__c6.mp3`: 关于上次提到的那个性能问题，我们排查了一下，主要是因为数据库查询没加索引。现在已经修复了，响应时间也从两秒降到了两百毫秒。 | `restrained__c6.mp3`: 关于上次说的那个性能问题，我们排查过了，主要是数据库查询没加索引。现在已经修复了，响应时间从两秒降到了两百毫秒。 |

Gemini judge: shipped preferred in 6/6 (Z3). Fidelity: the shipped prompt added 估计 (zh2) and 其实 (c2).
