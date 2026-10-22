// Evaluation corpus: realistic meeting utterances. Direct Speak texts are spoken verbatim
// (or humanized); Chinese inputs go through Chinese -> English translation.
export const DIRECT_TEXTS = [
  { id: 'en1', lang: 'en', text: "Thanks, everyone. So, quick update on the payment migration: we finished the API changes last Friday, and we're now testing with two merchants. Honestly, it's going better than I expected." },
  { id: 'en2', lang: 'en', text: "I see your point. But I'm a bit worried about the timeline. If we add this feature now, QA won't have enough time, and we might have to push the release." },
  { id: 'en3', lang: 'en', text: 'Sorry, could you repeat that? I think I missed the last part. Did you say the deadline is the twentieth or the twenty-seventh?' },
  { id: 'en4', lang: 'en', text: 'Okay, that makes sense. Let me check with the backend team and get back to you by tomorrow afternoon. Does that work for you?' },
  { id: 'zh1', lang: 'zh', text: '好的，那我简单说一下。这周我们主要在做支付迁移，接口已经改完了，现在在跟两家商户联调，整体比预期顺利。' },
  { id: 'zh2', lang: 'zh', text: '我理解你的意思。不过我有点担心时间，如果现在加这个功能，测试可能来不及，发布就得往后推了。' },
];

export const CHINESE_INPUTS = [
  { id: 'c1', text: '谢谢大家。简单同步一下支付迁移的进展：上周五我们已经完成了接口改造，现在正在和两家商户联调。说实话，比我预期的要顺利。' },
  { id: 'c2', text: '这个方案我看了一下，整体没问题，但是成本那块我觉得还需要再算一下，尤其是第三季度的服务器费用。' },
  { id: 'c3', text: '不好意思，能再说一遍吗？我好像没听到最后一部分。你说截止日期是20号还是27号？' },
  { id: 'c4', text: '好的，明白了。我跟后端团队确认一下，明天下午之前回复你。这样可以吗？' },
  { id: 'c5', text: '我觉得我们可以先上线一个简化版本，收集一下用户反馈，再决定要不要做完整的功能。' },
  { id: 'c6', text: '关于上次提到的性能问题，我们排查了一下，主要是数据库查询没有加索引，现在已经修复了，响应时间从两秒降到了两百毫秒。' },
];
