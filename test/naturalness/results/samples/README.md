# Listening samples

Real audio from the user's cloned voice. Listen to them in pairs (legacy vs. new). Each row shows the exact text that was sent to TTS.

## End-to-end through the shipped code (research.md §5)

| File | Condition | Text spoken |
|---|---|---|
| [direct_humanize__en2_0.mp3](direct_humanize__en2_0.mp3) | Direct Speak, Natural + Humanize | I see your point, yeah. But, um, I’m a bit worried about the timeline. If we add this feature now, QA won't really have enough time—and, you know, we might have to push the release. |
| [direct_humanize__zh2_0.mp3](direct_humanize__zh2_0.mp3) | Direct Speak, Natural + Humanize | 我挺理解你的意思的，不过呢，我其实有点担心时间。要是现在非得加这个功能，那测试可能就来不及了，发布估计得往后推。 |
| [direct_legacy__en2_0.mp3](direct_legacy__en2_0.mp3) | Direct Speak, legacy (Off) | I see your point. But I'm a bit worried about the timeline. If we add this feature now, QA won't have enough time, and we might have to push the release. |
| [direct_legacy__zh2_0.mp3](direct_legacy__zh2_0.mp3) | Direct Speak, legacy (Off) | 我理解你的意思。不过我有点担心时间，如果现在加这个功能，测试可能来不及，发布就得往后推了。 |
| [direct_natural__en2_0.mp3](direct_natural__en2_0.mp3) | Direct Speak, Natural, Humanize off (default) | I see your point. But I'm a bit worried about the timeline. If we add this feature now, QA won't have enough time, and we might have to push the release. |
| [trans_legacy__c2_0.mp3](trans_legacy__c2_0.mp3) | Chinese → English, legacy (Off) | I've looked over the proposal, and overall it looks fine. However, I think we need to re-examine the costs, especially the server expenses for the third quarter. |
| [trans_legacy__c3_0.mp3](trans_legacy__c3_0.mp3) | Chinese → English, legacy (Off) | Sorry, could you say that again? I think I missed the last part. Did you say the deadline is the 20th or the 27th? |
| [trans_legacy__c6_0.mp3](trans_legacy__c6_0.mp3) | Chinese → English, legacy (Off) | Regarding the performance issue we mentioned last time, we've looked into it and found that the database query was missing an index. We've fixed that, and the response time has dropped from two seconds down to two hundred milliseconds. |
| [trans_natural__c2_0.mp3](trans_natural__c2_0.mp3) | Chinese → English, Natural (default) | I've had a look at the proposal, and, honestly, the overall plan is fine. But, um, I think we still need to run the numbers on the costs again—especially the server fees for the third quarter. |
| [trans_natural__c3_0.mp3](trans_natural__c3_0.mp3) | Chinese → English, Natural (default) | Sorry, could you run that by me again? I think I missed the last part. Did you say the deadline is the 20th or the 27th? |
| [trans_natural__c6_0.mp3](trans_natural__c6_0.mp3) | Chinese → English, Natural (default) | So, about that performance issue we talked about, we looked into it and, um, it turned out the database query was missing an index. We've fixed that now, and the response time is actually down to 200 milliseconds from 2 seconds. |

## Text-register screening (research.md E3, same EN content)

| File | Condition |
|---|---|
| [e3_none__en2_0.mp3](e3_none__en2_0.mp3) | written text, no instruction |
| [e3_punct_ctx__en2_0.mp3](e3_punct_ctx__en2_0.mp3) | spoken punctuation + `context_texts` |
| [e3_fill_ctx__en2_0.mp3](e3_fill_ctx__en2_0.mp3) | light fillers + `context_texts` |
| [e3_official__en2_0.mp3](e3_official__en2_0.mp3) | official 2.0 voice, reference only (a different voice) |
