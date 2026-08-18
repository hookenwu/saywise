# Voice Copilot MVP Specification

## 1. Overview

Voice Copilot 是一个基于 Web 的个人音色语音生成工具。

MVP 第一阶段验证的核心产品假设保持不变：

> 用户已经知道自己想说什么，并准备好最终文本后，能否通过 Web 页面快速使用自己已经克隆好的音色生成自然的中文或英文语音，并在会议、日会、周会等场景中播放。

用户在 Voice Copilot 中输入（或粘贴、修改）自己已经想好的中文或英文文本，选择自己预先创建或配置的个人音色，点击 Speak，系统生成语音并在浏览器中自动播放。

MVP 阶段仅实现纯 Web 使用模式，不实现虚拟麦克风、系统音频注入、Desktop Audio Bridge、桌面客户端或移动端 Native App。

**默认核心链路仍然不包含通用 AI 文本处理能力**（改写、润色、汇报整理、多轮对话等）：用户提交给 TTS 的文本，默认就是用户自己在页面上输入的文本，不经过任何转换。这个默认核心链路是 Voice Copilot 的第一性产品假设，不因下述可选能力而改变。

在此基础上，MVP 新增一项范围严格受限的**可选**能力：用户可以主动开启"中文转英文"，让 Voice Copilot 在生成语音前，用一次性的、非对话式的 LLM 流式翻译把用户输入的中文转换为英文，再送入 Streaming TTS（详见 §9）。这不是聊天机器人，不引入多轮对话、角色人格或通用 AI 写作能力——它是 TTS 输入文本的一种可选预处理方式，用户可以随时关闭；关闭后系统行为与不存在该功能时完全一致。

Voice Copilot 主要用于真实会议、日会、周会等现场发言场景，用户点击 Speak 后到第一段可听语音开始播放之间的延迟（**Time to First Audio，TTFA**）是核心体验指标之一，无论 Speak 走的是直接 TTS 链路还是"中文转英文"链路。因此 MVP 采用 **Streaming TTS**：用户点击 Speak 后，系统建立流式 TTS Session，一边持续接收音频分片一边尽快开始播放，不等待整段 Speech Text（或其英文翻译）对应的完整音频全部生成完成。

Voice Copilot 计划独立成为自己的 GitHub Repository，不再依赖现有 Live2D Assistant 项目的运行环境（详见 §14）。独立化允许项目引入轻量 Node.js 运行层，"完全静态 Web、零 Node.js Runtime"不再是本 Spec 的强制边界；但项目仍应保持轻量化，避免为了独立运行引入不必要的复杂后端架构。现有 Live2D 项目此后只作为参考实现，不是 Voice Copilot 的 Runtime Dependency。

---

## 2. Primary Use Cases

以下场景是 Voice Copilot 的主要使用场景说明，用于帮助理解产品定位，**不对应程序中的任何 Mode 或状态**。无论哪种场景，用户在产品中实际执行的都是同一套操作：输入 Speech Text → 选择 Voice → 点击 Speak（可选先开启"中文转英文"，详见 §9）。

### 2.1 English Business Meeting

用户参加 Microsoft Teams、Google Meet、Zoom 等英文商务会议时，提前准备好自己想表达的英文内容，例如：

```text
We have completed the API integration in the sandbox environment.
Our next step is to proceed with the production environment configuration.
```

将英文直接输入 Voice Copilot，选择自己的克隆音色，点击 Speak。系统使用该音色生成英文语音并自动播放。

默认情况下（"中文转英文"关闭），Voice Copilot 不会把中文翻译成英文，也不会润色或改写英文表达——用户需要自己提前准备好最终要说的英文文本。如果用户习惯用中文起草、但希望说出英文，可以主动开启"中文转英文"（详见 §9）；开启后仍然只做直译式的语言转换，不做润色、改写或表达优化。

典型场景包括：

* API 对接会议
* 产品方案沟通
* 技术问题解释
* 项目进度同步
* 商务合作沟通
* 合规及运营问题讨论

### 2.2 Internal Project Update

用户提前准备好自己想汇报的中文内容，例如：

```text
人民币汇出项目这边，
新渠道的产品和接口文档已经基本完成。
本周重点是和渠道技术团队进一步确认后续对接安排。
```

直接输入 Voice Copilot，选择个人音色，点击 Speak。系统生成并自动播放中文语音。

**Voice Copilot 当前不负责：**

* 自动整理项目内容；
* 自动生成日报 / 周报；
* 自动读取项目数据或第三方系统内容。

典型场景包括：

* Daily Stand-up
* Weekly Meeting
* 项目进展汇报
* 管理层同步
* 内部项目说明

---

## 3. Core User Flow

MVP 的核心流程为：

```text
输入 Speech Text
    ↓
选择 Voice Profile
    ↓
可选调整 Speed / Volume
    ↓
点击 Speak
    ↓
建立 Streaming TTS Session
    ↓
持续接收 Audio Chunks
    ↓
首批可播放音频到达
    ↓
尽快开始播放
    ↓
后续音频持续生成并追加播放
    ↓
TTS Generation Complete
    ↓
Playback Complete
```

以上流程是"中文转英文"关闭时（默认）的链路。开启后的链路见 §3.1。

### 3.1 两条 Speak 链路

Voice Copilot 存在两条可选的 Speak 链路，由用户在主界面上通过"中文转英文"开关决定使用哪一条（§9）。两条链路共享同一个 Speak 按钮、同一套 Streaming TTS 与 Audio Player 行为（§6、§7），差异仅在于 TTS 实际接收到的文本从何而来。

**关闭时（默认）—— Direct Speak：**

```text
Speech Text
    ↓
Streaming TTS
    ↓
Personal Voice
    ↓
Low-latency Playback
```

用户输入什么文本，就按照原文本直接合成语音，不经过任何转换，与 MVP 第一阶段完全一致。

**开启时 —— Translated Speak：**

```text
Chinese Speech Text
    ↓
LLM Streaming Translation
    ↓
English Text Stream
    ↓
Streaming TTS
    ↓
Personal Voice English Speech
```

用户输入中文 Speech Text，点击 Speak 后，系统先以流式方式调用 LLM 将其翻译为英文，并将 LLM 产生的英文文本流实时喂给 Streaming TTS，而不是等待完整英文翻译结束后才开始合成。详细行为定义见 §9。

无论哪条链路，下文的 Speak = Generate + Play 语义都成立：用户点击 Speak 即完成了对"生成 + 自动播放"的一次性授权。

`Speech Text` 是用户直接在 textarea 中输入、粘贴、修改的文本。关闭"中文转英文"时，它也是实际提交给 TTS Provider 的文本，两者始终是同一份文本，不存在原始输入与最终文本的区分。开启时，Speech Text 仍然是唯一的用户输入来源，但会先经过 §9 定义的 LLM Streaming Translation，再把翻译产生的英文文本流交给 TTS。

TTS 必须始终使用当前链路下应提交的最新内容——如果用户在生成语音前修改了 Speech Text，本次 Speak 必须使用修改后的当前文本（关闭时直接使用它，开启时以它作为翻译输入）。

**Speak = Generate + Play。**

点击 Speak 本身就是用户对本次生成音频的播放授权：

```text
User clicks Speak
        ↓
（若"中文转英文"已开启：先建立 LLM Streaming Translation）
        ↓
Start Streaming TTS
        ↓
First Playable Audio Available
        ↓
Automatic Playback Starts
        ↓
Remaining Audio Continues Streaming
```

系统允许在用户点击 Speak 后，在**首批可播放音频到达的时刻**自动播放，不必等待整段语音全部生成完成——这不属于未经授权的自动播放，播放授权已经在用户点击 Speak 的那一刻明确给出。

如果播放结束（Playback Finished），用户仍然可以点击 Replay 重新播放同一段已经完整生成完成的音频，无需重新生成（详见 §7）。

如果用户修改了 Speech Text 后再次点击 Speak：

```text
终止上一轮仍在进行的 Streaming TTS Session（如果存在，且开启时同时终止仍在进行的 LLM Streaming Translation）
    ↓
重新建立本次应使用的链路（Direct 或 Translated），生成最新文本对应的语音
    ↓
自动播放最新一轮的音频
```

新生成的音频会替换掉之前的音频。

---

## 4. Input

### 4.1 Speech Text

提供一个主要文本输入区域（textarea）。

用户可以在同一个 textarea 中：

* 输入；
* 粘贴；
* 修改；
* 删除；
* 替换。

用户可以输入：

* 中文
* 英文
* 中英文混合内容

输入内容可以是：

* 一句话
* 一段说明
* 项目进展
* 简单要点

默认情况下（"中文转英文"关闭），系统不对 Speech Text 做任何 AI 转换、翻译或改写——最终提交给 TTS 的内容，始终就是当前 textarea 中的最新文本。用户主动开启"中文转英文"后，Speech Text 仍然是唯一的用户输入来源、唯一可编辑的字段，但提交给 TTS 的内容会先经过 §9 定义的 LLM Streaming Translation。这是 Speech Text 到 TTS 之间目前唯一允许存在的转换步骤，必须由用户显式开启，不会默认发生，也不支持除"中文→英文"以外的转换方向。

MVP 暂不要求支持长篇文档上传。

---

## 5. Voice Profile

MVP 需要存在 Voice Profile 的概念，且是 MVP 的核心能力之一。

MVP 至少支持一个 Voice Profile。

一个 Voice Profile 至少包含：

* id
* name
* provider
* speakerId / voiceId
* languageCapability（语言能力，例如 zh / en）
* speed
* volume
* optional description

例如：

```text
Name: My Voice
Speaker ID: S_xxx
Language: zh / en
Speed: 1.0
Volume: 1.0
```

### 5.1 Voice Profile 与 Provider Configuration 的概念区分

请明确区分以下两个概念：

**Provider Configuration**（连接 TTS 服务本身所需的凭证）：

```text
Provider: Volcengine
App ID
Access Token
```

**Voice Profile**（一个具体可用的音色配置）：

```text
Name: My Voice
Speaker ID: S_xxx
Language: zh / en
Speed: 1.0
Volume: 1.0
```

Provider Credential（App ID / Access Token 等）不属于某一个具体 Voice Profile 的产品概念，而是所有 Voice Profile 共享的连接凭证。即使当前实现阶段可能暂时把两者放在同一个配置文件中，Spec 层面也要保持概念区分：Voice Profile 描述"用哪个声音、语言能力、语速音量"，Provider Configuration 描述"如何连接到 TTS 服务本身"。

当"中文转英文"开启时（§9），还存在第二类独立的 Provider Configuration：Translation / LLM Provider（详见 §9.3、§13）。它与 Voice / TTS Provider 的凭证是两套完全独立的凭证，不共享、不合并存储在同一个"Provider"概念下——即使实现上可能被安排在同一个 Settings 页面里。

### 5.2 Voice Profile 来源

Voice Profile 可以来源于：

* 前端配置；
* hardcoded configuration；
* localStorage；
* 用户在 Voice Provider 中已经创建好的 Voice / Speaker。

MVP 阶段不要求一定在本系统内完成声音克隆。用户需要先在第三方 Voice Provider 中自行创建 / 克隆自己的声音，将对应 Voice ID 或必要配置添加到 Voice Copilot，再在 Voice Copilot 中调用该声音进行 TTS。

Voice Copilot 当前只负责：

```text
使用已有 Voice ID / Speaker ID
    ↓
生成语音
```

系统设计需要保留未来支持内置 Voice Clone 流程的扩展能力，但 MVP 本身不实现该流程。

### 5.3 Language Capability

用于 MVP 验收的 Voice Profile 应能够满足：

* English Business Meeting 场景生成英文语音；
* Internal Project Update 场景生成中文语音。

如果同一个 Voice / Provider 可以同时支持中英文，MVP 优先使用同一个 Voice Profile。如果 Provider 或 Voice 存在语言限制，系统至少需要明确该 Voice Profile 的 Language Capability。

MVP 不要求复杂的多 Voice 自动切换系统。

---

## 6. Text-to-Speech

用户输入 Speech Text、选择 Voice Profile 后，可以点击 Speak。

点击 Speak 后提交给 TTS 的文本，可能是用户原始 Speech Text（"中文转英文"关闭时），也可能是 §9 定义的 LLM Streaming Translation 产生的英文文本流（开启时）——TTS 层本身不区分这两种来源，只负责把收到的文本流转换为音频分片。

MVP 阶段允许 Web 前端直接调用 Voice / TTS Provider，并采用 **Streaming TTS**：文本一次性提交（或按 §9.2 的方式持续推送）给 TTS Provider 后，音频以分片（Audio Chunks）形式持续返回，浏览器边接收边播放，无需等待整段音频全部生成完成。

当前 MVP 目标链路为：

```text
Voice Copilot Web
    ↓
Browser Frontend
    ↓
Voice / TTS Provider（Streaming Session）
    ↓
Audio Chunks（持续到达）
    ↓
MediaSource / SourceBuffer
    ↓
Browser <audio>（首批可播放音频到达后尽快开始播放）
```

MVP 当前主要目标 TTS Provider 为 Volcengine Voice / TTS。Spec 不需要决定底层 WebSocket 的具体实现细节，但要求底层链路支持分片流式返回音频，而不仅仅是一次性返回完整音频文件。

后端代理、安全凭证托管等能力可以作为未来生产化阶段的技术优化，具体是否引入、经由怎样的 Node.js 层实现，由 `plan.md` 决定（详见 §13.3、§14）；本 Spec 不预先要求某个特定的 `/api/volcengine-tts` 式后端代理形态。

系统需要：

1. 点击 Speak 后，将当前应提交给 TTS 的文本（关闭"中文转英文"时为原始 Speech Text，开启时为 §9 定义的英文翻译文本流）提交给配置的 TTS Provider，建立 Streaming TTS Session；
2. 持续接收 Audio Chunks；
3. 首批足够播放的音频数据到达后，尽快开始播放，不等待整段语音生成完成；
4. 后续 Audio Chunks 持续到达时，持续追加到当前播放缓冲区；
5. 显示生成状态与播放状态；
6. 处理生成失败、连接失败等情况。

只有用户主动点击 Speak，才允许开始该次 Streaming TTS（以及"中文转英文"开启时的 LLM Streaming Translation）与后续的自动播放流程。系统不得在用户未点击 Speak 的情况下自行发起生成或播放。

### 6.1 TTS Generation Status

TTS 生成状态至少包括：

```text
Idle
Generating
Completed
Error
```

`Generating` 表示 Streaming TTS Session 仍在进行中（此时音频可能已经在播放，也可能还在等待首批数据到达）；`Completed` 表示本轮提交给 TTS 的全部内容对应的 Audio Chunks 已经生成完成（Streaming Session 已正常结束），与播放本身是否已经播放完毕无关。

TTS Generation Status 只描述"本轮音频是否已经全部生成完成"，不描述播放行为。播放行为由 §7 的 Audio Playback Status 独立描述——生成状态与播放状态是两个独立概念，不应合并。`generationStatus = Generating` 且 `playbackStatus = Playing` 同时成立，是 Streaming TTS 下的正常状态：音频一边生成一边播放。

### 6.2 Time to First Audio (TTFA)

用户点击 Speak 后到第一段可听语音开始播放之间的延迟——**Time to First Audio（TTFA）**——是 Voice Copilot 的核心体验指标，无论走的是 Direct Speak 还是 Translated Speak（§3.1）。

系统不应为了等待整段内容（原始 Speech Text，或其英文翻译）对应的完整音频全部生成完毕才开始播放，这是 MVP 采用 Streaming TTS 而不是"完整生成后再播放"的根本原因。

MVP 不要求写死一个毫秒级 SLA，但系统设计必须始终以降低 TTFA 为优化目标，不得为了实现简便而引入不必要的首字延迟（例如人为等待整段音频生成完毕、或缓冲超出播放实际所需的数据量才开始播放；开启"中文转英文"时，同样不得等待整段翻译全部完成后才开始建立或推送 TTS 内容，详见 §9.2）。

### 6.3 Streaming TTS 范围澄清

为避免与"实时语音对话"类能力混淆，明确 Streaming 在本 MVP 中的确切含义：

**In Scope（本 MVP 范围内的 Streaming 能力）：**

* Static Speech Text（用户点击 Speak 前已经写好的、完整的、静态的一段文本）
* Streaming TTS（该静态文本，或其英文翻译文本流，对应音频的分片流式生成与传输）
* Streaming Audio Chunks
* MediaSource / SourceBuffer
* Low-latency Audio Playback（首批音频到达后尽快开始播放）
* LLM Streaming Translation（§9 定义的、仅用于把用户已经开启"中文转英文"时的静态中文 Speech Text 转换为英文文本流、并尽快喂给 Streaming TTS 的一次性单向流程——不是对话，不维护上下文，不生成回复）

**Out of Scope（不属于本 MVP 的"实时"能力，详见 §10）：**

* Realtime Speech-to-Speech
* Meeting Audio Capture
* ASR
* Realtime Translation（面向持续语音流/会议音频的实时翻译，区别于 §9 面向静态 Speech Text 的一次性文本翻译）
* Realtime Conversation
* LLM Streaming Reply Generation / Automatic Reply（LLM 根据对话上下文生成回应内容，区别于 §9 的单向静态文本翻译）
* Chat History / 多轮对话

Streaming TTS 只是"把已经确定的内容（Speech Text 或其英文翻译）尽快转换为可听音频"的传输与播放方式。§9 的 LLM Streaming Translation 同理，只是"把已经确定的静态中文文本尽快转换为英文文本流"的一次性转换方式——两者都不涉及实时监听、实时语音识别、维护对话历史，或根据用户意图生成回复内容。

---

## 7. Audio Player

无论 Speak 走的是 §3.1 的哪一条链路，播放控制的行为定义完全相同——Audio Player 只感知"当前 Speech Text 对应的最终音频"，不区分该音频是否经过 §9 的翻译。

Speak 点击后（首批音频到达即自动播放）提供基础播放控制。

MVP 至少支持：

* Speak
* Pause
* Resume / Play
* Replay
* Stop

### 7.1 各操作行为定义

**Speak**

```text
建立 Streaming TTS Session（若"中文转英文"已开启，先建立 LLM Streaming Translation）
    ↓
持续接收 Audio Chunks
    ↓
首批可播放音频到达
    ↓
自动开始播放
    ↓
后续音频持续追加播放，直至生成完成（Completed）与播放完成
```

**Pause**

暂停当前播放，播放位置保留在暂停时刻。Pause 默认不终止 Streaming TTS Session（以及开启时仍在进行的 LLM Streaming Translation）——如果本轮生成尚未完成，系统在后台继续接收并缓冲后续 Audio Chunks；用户 Resume 时可以直接继续播放，无需等待。

**Resume / Play**

从暂停时刻的位置继续播放，并继续消费此后到达的音频流（如果生成仍在进行中）。

**Replay**

从 0 秒重新播放当前已经**完整生成完成**（`generationStatus = Completed`）的本轮音频，无需重新建立 TTS Session（也无需重新调用翻译）。

如果本轮 Streaming Generation 尚未完成（`generationStatus = Generating`），或本轮已经执行过 Stop，则 Replay 不可用；用户需要点击 Speak 重新生成。

**Stop**

停止当前播放，并终止当前 TTS Streaming Session（以及"中文转英文"开启时仍在进行的 LLM Streaming Translation）。同时清理：

* 当前 MediaSource；
* 当前 SourceBuffer；
* 当前 streaming buffer；
* 当前 session 状态（底层 WebSocket 连接本身可以保留供下一次 Speak 复用，但当前这一轮的会话必须结束）。

Stop 后不要求保留本轮音频，无论该轮生成当时是否已经完成——如果用户希望再次收听，需要重新点击 Speak 触发新一轮生成。这与 Replay（仅适用于尚未 Stop、且已经完整生成完成的音频）是两个不同的操作。

### 7.2 Audio Playback Status

播放状态至少包括：

```text
Stopped
Buffering
Playing
Paused
```

`Buffering` 表示 Speak 已点击、Streaming TTS Session 已建立（若"中文转英文"已开启，也包含正在等待翻译产生足够片段的阶段），但首批可播放音频尚未到达，播放尚未真正开始。

播放器应明确显示当前处于哪个播放状态。

### 7.3 重新生成音频

如果用户重新点击 Speak（无论 Speech Text 是否修改），系统必须终止上一轮仍在进行的 Streaming Session（以及仍在进行的 LLM Streaming Translation，如果存在）并重新建立新一轮该走的链路（Direct 或 Translated），自动播放新一轮的音频。

如果用户在播放前或播放中修改了 Speech Text 并再次点击 Speak，新一轮生成的音频必须替换旧音频——播放器只播放最新一轮的音频，旧的 MediaSource / SourceBuffer / streaming buffer 需要被清理。

---

## 8. Meeting Usage

MVP 为纯 Web 模式。

Voice Copilot 只负责：

```text
建立 Streaming TTS（若"中文转英文"已开启，含 LLM Streaming Translation）
+
用户点击 Speak 后，首批音频到达即尽快自动在网页中播放，后续音频持续播放
```

MVP 不负责将网页音频直接作为系统麦克风输入发送至 Microsoft Teams、Google Meet 或 Zoom。

用户可以根据实际情况：

* 通过设备扬声器播放；
* 使用另一设备播放；
* 使用会议软件已有的系统音频共享能力。

这些属于使用方式，而不是 MVP 需要实现的会议集成功能。

系统不得在用户未点击 Speak 的情况下自动代表用户在会议中发言。

---

## 9. Optional Chinese → English Translation

Voice Copilot 支持一个用户可以主动开启或关闭的可选能力：**中文转英文（Chinese → English）**。默认关闭。这是一个独立、简单的文本转换能力，服务对象仅限于"为英文语音合成提供输入文本"，不是聊天机器人，不是多轮对话产品，也不是通用 AI 写作 / 改写 / 润色能力。

### 9.1 开关与作用范围

主界面提供一个"中文转英文"开关（On/Off），作用于下一次点击 Speak 时使用哪条链路（§3.1）：

* **关闭（默认）：** Direct Speak——Speech Text 原样提交给 Streaming TTS，与 MVP 第一阶段完全一致，不涉及任何 LLM 调用。
* **开启：** Translated Speak——点击 Speak 时，先以流式方式将当前 Speech Text 交给 LLM 做中文→英文翻译，翻译产生的英文文本流被持续送入 Streaming TTS。

开关本身不修改 Speech Text 的内容，也不会自动检测输入语言并强制翻译——是否翻译完全由用户通过开关决定。用户在 English Business Meeting 场景（§2.1）中，如果已经准备好最终英文文本，应当保持开关关闭，直接使用 Direct Speak；开关主要服务于用户习惯用中文起草、但希望说出英文的场景。

MVP 只支持中文 → 英文这一个翻译方向，不支持英文 → 中文或其他语言对，也不支持在同一次 Speak 中混合翻译与非翻译内容。

### 9.2 Translated Speak 详细流程

```text
用户开启"中文转英文"
    ↓
输入 / 编辑中文 Speech Text
    ↓
点击 Speak
    ↓
以当前 Speech Text 为输入，建立 LLM Streaming Translation
    ↓
LLM 持续产生英文文本片段
    ↓
每当积累出足够可用于语音合成的英文片段，立即提交给 Streaming TTS
    ↓
Streaming TTS 持续返回 Audio Chunks（与 §6 相同的分片流式机制）
    ↓
首批可播放音频到达后尽快自动播放（与 §7 相同的 Speak = Generate + Play 语义）
    ↓
LLM 翻译流结束 且 对应 TTS 音频全部生成完成
    ↓
Playback Complete
```

核心体验要求（§1 已提出，此处为 Translated Speak 链路的具体化）：

> LLM 一旦产生足够可用于语音合成的英文结果，就应尽快向 Streaming TTS 提供内容，使英文语音尽可能早开始播放，降低用户点击 Speak 后的等待时间。系统不得为了简化实现，等待整段英文翻译全部生成完毕后才开始建立或推送 TTS 内容。

"足够可用于语音合成的片段"具体以什么粒度切分（例如按句子、按标点、按固定长度），是实现细节，留给 `plan.md` 决定；本 Spec 只要求：切分粒度不得以牺牲 TTFA 为代价人为拉长等待时间，且不得把整段翻译等待完成后再一次性提交给 TTS。可以参考现有 `public/js/streaming-response-handler.js` 中"LLM 单向流式输出 → 按句子边界切分 → 依次推流给 Streaming TTS"的调用链与思路（详见 §14.2），但不得带入其配套的角色对话业务逻辑。

Translated Speak 复用 Direct Speak 完全相同的 Streaming TTS 建立方式、Audio Chunk 接收方式、MediaSource / SourceBuffer 播放方式，以及 §7 定义的 Pause / Resume / Replay / Stop 行为——区别只在于 TTS 收到的文本来自 LLM 翻译输出，而不是原始 Speech Text。Pause 对 LLM 翻译流的影响与对 TTS 的影响一致：Pause 只暂停播放，不终止后台仍在进行的翻译与合成（§7.1 原则的自然延伸）。Stop 需要同时终止仍在进行的 LLM Streaming Translation（如果尚未完成）和 Streaming TTS Session。

### 9.3 Translation Provider

与 §5.1 的概念区分一致：Translation / LLM Provider 是独立于 Voice / TTS Provider 的另一套 Provider Configuration，二者的凭证互不共享（详见 §13）。MVP 阶段只需要支持一个 Translation Provider。

Translation Provider 的具体选型（沿用现有 Live2D 项目已在使用的 Gemini / DeepSeek / OpenAI 中的某一个，或引入新的 Provider）由 `plan.md` 决定，本 Spec 不预设。

### 9.4 Status 与失败处理

Translated Speak 下，"生成"阶段实际包含翻译与语音合成两个子阶段，但对用户呈现的仍然是 §6.1 / §7.2 定义的同一套 Generation / Playback Status 词汇表——不新增独立于翻译的第三套状态机。系统需要能够区分并向用户展示"当前是翻译失败，还是语音合成失败"，因为两者的失败原因和用户可采取的动作不同（例如翻译失败通常需要检查 LLM Provider 凭证或网络，语音合成失败通常需要检查 TTS Provider）；具体状态字段与 UI 呈现方式留给 `plan.md`。

翻译产生的英文文本流应当在生成过程中对用户可见（只读展示，随每次 Speak 重新填充，不是可编辑字段，也不是持久化的聊天记录）——用户在会议现场应当能够在语音播放的同时确认系统实际生成的英文表达是否符合预期。这个展示区域不是 Speech Text 的替代品，用户后续仍然只编辑 Speech Text（中文）。

### 9.5 明确排除的旧业务逻辑

中文转英文复用现有 Live2D 项目中"LLM 单向流式输出 → 火山引擎双向流式 TTS"的**调用链、流式数据衔接和低延迟处理方式**作为参考，但不得引入以下旧业务逻辑（与 §14.2 的排除列表一致，此处针对本功能重复强调）：

* Live2D
* ConversationEngine
* Chat History / 多轮对话
* Character Prompt / System Prompt 人设
* Emoji / Emotion 解析
* 内心活动
* Motion / Expression
* ASR
* 实时对话（Realtime Conversation）

中文转英文是一次性、单向、无上下文记忆的文本转换：每次 Speak 只使用当前这一轮的 Speech Text 作为翻译输入，不携带历史对话，不维护会话状态，不基于之前轮次调整翻译结果。

---

## 10. Out of Scope

以下能力明确不属于 Voice Copilot MVP：

### Text AI（超出 §9 范围的通用能力）

以下通用 AI 文本能力明确不属于 Voice Copilot MVP，无论"中文转英文"是否开启：

* AI Rewrite / 改写
* AI Translation（除 §9 定义的、用户主动开启的"中文→英文"单向静态文本翻译外的任何翻译能力，例如英文→中文、多语言互译、面向持续语音流的实时翻译）
* 通用 Chat / 多轮对话
* Prompt Engineering 作为面向用户暴露的可配置能力
* AI Writing / AI Summary
* AI Project Update Generation
* Expression Mode（English Meeting / Internal Update / Direct Speech 作为程序 Mode）
* Raw Input → AI → Final Text 的通用流程（§9 的中文转英文是唯一例外，且范围严格限定为中文→英文）
* 依赖现有 Live2D 项目的 `/api/chat`
* 依赖现有 Live2D 项目的 `/api/chat-stream`

**§9 定义的 LLM Streaming Translation 是本列表的唯一例外**，且仅限于：用户主动开启"中文转英文"后，为英文语音合成提供流式英文文本。它不使用、不依赖、不复用现有 Live2D 项目的 `/api/chat` 或 `/api/chat-stream` 路由（详见 §14）——即使底层同样调用某个 LLM Provider 的流式接口，也必须是 Voice Copilot 自己独立实现或独立配置的调用路径。除 §9 明确定义的范围外，不得以本条例外为由扩大出通用 AI Writing / Rewrite / Chat 产品能力。

### Meeting Intelligence

* Meeting Audio Capture
* ASR
* Realtime Subtitle
* Realtime Translation（面向持续语音流 / 会议音频的实时翻译，区别于 §9 面向静态 Speech Text 的一次性文本翻译）
* Automatic Reply
* Meeting Listening
* Speech-to-Speech
* Realtime Conversation
* LLM Streaming Reply Generation（LLM 根据对话上下文生成回复内容；不包括 §9 定义的单向静态文本翻译）

### Meeting Integration

* Virtual Microphone
* Desktop Audio Bridge
* Microsoft Teams SDK integration
* Google Meet integration
* Zoom integration
* System Audio Injection
* 系统音频设备驱动
* Microphone Mixing / 麦克风与 AI Voice 混音
* 浏览器音频注入 Teams / Meet / Zoom

### Voice Clone

* Voice Clone Workflow
* Voice Training
* Voice Enrollment
* 上传训练音频
* 声音审核
* Voice Clone 状态管理

### Live2D

MVP 暂不实现：

* Live2D Character
* Motion
* Expression
* Lip Sync
* Live2D Avatar Interaction

### Knowledge / Automation

* API 文档知识库
* RAG
* 企业知识库
* 自动读取项目文档
* 自动回答业务问题
* API Documentation QA
* 自动生成日报 / 周报
* GitHub
* Jira
* Notion
* Slack
* 飞书
* Email
* Calendar

Internal Project Update 当前 MVP 仅指用户主动输入、自己已经想好的项目进展文本，直接生成语音。MVP 不从项目管理、知识库、邮件或日历系统自动收集或整理项目进展。

### Advanced Voice Features

MVP 暂不要求：

* Voice emotion editor
* Voice timeline editor
* 多角色语音

**Streaming TTS**（为一段静态 Speech Text 提供低延迟分片生成与播放）明确属于本 MVP **In Scope**（详见 §6.2 / §6.3），不在此 Out of Scope 列表中。同理，**§9 定义的 LLM Streaming Translation**（为一段静态中文 Speech Text 提供低延迟流式英文翻译，并尽快喂给 Streaming TTS）也明确属于本 MVP In Scope，不在此 Out of Scope 列表中。本节所排除的是 Realtime Speech-to-Speech、Meeting Audio Capture、Realtime Conversation 等面向"实时对话 / 实时会议监听"的能力，与"为已写好的静态文本提供低延迟 TTS 播放（或低延迟流式翻译）"是不同的概念，不要混淆。

---

## 11. UI Principles

产品整体应保持：

* 简洁
* 克制
* 专业
* 高信息密度但不复杂
* 面向工作场景，而不是娱乐型 AI 产品

核心页面应让用户快速完成：

```text
输入 Speech Text
→ 选择 Voice
→（可选）开启中文转英文
→ Speak
→ 首批音频尽快自动播放
```

当"中文转英文"开启时，核心操作链路不变，只是在 Speak 与首批音频之间多了一段用户不需要手动干预的流式翻译过程（§9）——不应为了这项可选能力增加额外的页面跳转或复杂交互。

避免为了展示 AI 能力增加不必要的功能或页面。核心操作应该非常适合会议现场快速使用。

---

## 12. Main Workspace

MVP 核心页面围绕以下区域构成：

### Speech Text

一个主要 textarea，用户输入 / 粘贴 / 修改的文本。

### Voice

Voice Profile selector。

### Voice Controls

可选：

* Speed
* Volume

### Chinese → English（可选开关）

一个开关控件（On / Off），控制下一次 Speak 使用 §3.1 的哪条链路。默认关闭。

### Translated Text（仅"中文转英文"开启时展示）

只读、只在"中文转英文"开启且当前这一轮 Speak 产生了翻译结果时显示的展示区域，随每次 Speak 重新填充（§9.4）。不是可编辑字段，也不是独立于 Speech Text 持久化的内容。

### Speak

最主要的操作按钮。

### Player

* Pause
* Resume / Play
* Replay
* Stop

### Status

显示：

* Generating（"中文转英文"开启时可能包含翻译子阶段，见 §9.4）
* Buffering
* Playing
* Paused
* Error

核心操作应尽可能集中在同一个 Workspace 中完成，不要求频繁页面跳转。

---

## 13. Settings / Configuration

MVP 需要提供 Settings 页面、设置区域，或等价的前端配置方式，并且 Settings 是**用户可配置能力**——用户应当能够在不修改代码、不依赖开发者预先写好的 hardcoded 配置的情况下，自行完成必要的 Voice / TTS Provider Credential 与 Voice Profile 配置。这是相对于"允许 hardcoded / localStorage 配置"这一临时技术边界的一次产品定义收紧：配置方式（存储在哪里、是否经过 Node.js 层）仍然是实现细节，但"用户能够自己完成配置"本身是本 Spec 明确要求的产品能力，不是可选项。

**例外：Translation / LLM Provider Credential 不属于上述"用户在 Settings 中自行填入"的范围**——它是随独立部署实例存在的服务器侧密钥（详见 §13.1），由部署/运维该服务器的人通过环境变量配置，不通过 Settings 表单收集或写入。Settings 对它只做只读展示（是否已配置），具体原因与边界见 §13.1、§13.2。

### 13.1 Provider / Credential 概念梳理

结合当前实际使用的 Voice / TTS Provider（Volcengine）与 §9 新增的 Translation / LLM Provider 能力，Settings 中存在两类相互独立的 Provider Configuration（概念区分详见 §5.1、§9.3）：

**Voice / TTS Provider Configuration** —— 连接 TTS 服务本身所需的凭证。至少需要支持配置：

* App ID
* Access Token
* Secret Key

三者是本 Spec 要求 Settings 至少支持的凭证字段集合。并非所有 Provider 或所有调用方式都会用满这三个字段（例如当前 Volcengine 双向流式 TTS 只使用 App ID / Access Token）；具体某个 Provider 实际使用哪些字段、字段如何命名、是否需要额外字段，由 `plan.md` 结合选定的 Provider 接口定义。Settings 的产品要求是：用户能够找到对应字段并填入自己的凭证，而不是被要求去改配置文件或源码。

**Translation / LLM Provider Configuration**（仅当"中文转英文"功能存在时相关）—— 连接 §9 所选定 LLM Provider 所需的凭证。这套凭证与 Voice / TTS Provider Configuration 完全独立，不合并、不共享，且**配置方式也不同**：Voice / TTS Provider Configuration 是浏览器直接需要用来建立 TTS 连接的值，天然是"每个使用者自己的凭证"，适合由用户在 Settings 中自行填入；Translation / LLM Provider Credential 则是服务器侧才会用到的密钥（§9 的 LLM Streaming Translation 由服务器发起调用，凭证不下发到浏览器），在"§14 独立部署"的产品形态下，它更接近一个随该服务器实例存在的部署配置，而不是每个终端用户各自持有的凭证。因此本 Spec 要求：Translation / LLM Provider Credential 通过该服务器的运行环境（例如环境变量）配置，由部署/运维该实例的人一次性设置；Settings 中不提供可写入该凭证的表单字段，只允许查看"是否已配置"这一状态（详见 §13.2）。

### 13.2 Settings 覆盖范围

Settings 中至少用于声明或配置：

* Voice / TTS Provider
* Voice / TTS Provider Credential（App ID / Access Token / Secret Key，详见 13.1，用户可自行填入）
* Voice Profile（Voice ID / Speaker ID、Default Voice、Speed、Volume、Language Capability）
* "中文转英文"开关的默认状态（可选，例如用户希望默认开启）
* Translation / LLM Provider 的**只读状态展示**（仅当"中文转英文"功能存在时出现；是否已配置、由哪个 Provider 提供，详见 §9.3、§13.1）——这是展示，不是配置入口

不需要提供复杂的 Voice Profile CRUD 界面，也不需要提供复杂的 Prompt / Model 参数配置界面——§9 的 LLM 能力范围极窄（单向、一次性、中文→英文），Settings 不应因为引入了这一能力而膨胀成通用 AI Provider 配置中心。

Settings 中不需要包含：

* 通用 AI Provider 的 Model 选择、Prompt、Temperature 等生成参数配置（§9 不面向用户暴露这类参数）
* Default Expression Mode
* Translation / LLM Provider Credential 的可写入表单字段（App ID / Access Token / Secret Key 等）——按 §13.1 的决定，该凭证通过服务器运行环境配置，不通过 Settings 表单收集

### 13.3 存储与安全边界（留给 plan.md）

Credential 具体如何保存（前端配置文件、localStorage、经由 Node.js 层的某种存储或代理）、是否需要引入轻量 Node.js 层来避免把某些凭证暴露到浏览器、哪些凭证可以安全留在浏览器端、哪些不应该暴露，由后续 `plan.md` 结合安全性和轻量化目标决定，本 Spec 不预先设计存储方案或后端结构。

MVP / personal-use 阶段允许存在相对宽松的技术边界（例如前端配置、localStorage，只要用户本人能够自行填入，而不是被要求改代码）。如果未来对外公开部署、提供多人使用、商业化或成为正式生产系统，需要重新设计 Credential Management，例如迁移到后端安全存储和代理调用——这一原则与之前保持一致，只是现在明确要求"用户自行填入"这一层产品能力必须在 MVP 阶段就存在，而不是留到生产化阶段才补上。

---

## 14. Independent Runtime & Repository Relationship

Voice Copilot 目前与现有 Live2D Assistant 项目位于同一个 GitHub Repository 中开发，但产品目标是让 `public/voice-copilot/`（或其独立后的等价目录）后续成为一个**独立的 GitHub Repository**，不再依赖现有 Live2D 项目的运行环境。

### 14.1 独立运行要求

* Voice Copilot 应当能够独立启动和运行，不要求 Live2D 项目的 `app.js`、Express 路由或任何 Live2D 特有资源在场。
* 允许、并且在支持 §9 的 LLM Streaming Translation、§13 的用户可配置 Credential 等能力时很可能需要引入**轻量 Node.js 运行层**——例如用于承载某些不适合暴露在浏览器端的凭证或 API 调用。"完全静态 Web、零 Node.js Runtime"不再是本 Spec 的强制边界。
* 即使引入 Node.js 运行层，项目仍应保持轻量化——不为了独立运行引入不必要的复杂后端架构（例如通用后端框架、数据库、多服务编排等超出"承载 TTS / Provider 连接与凭证"这一实际需要的东西）。具体 Node.js 技术结构、目录组织、API 设计属于 `plan.md` 的范围，本 Spec 不预先设计。
* 现有 Live2D 项目此后只作为**参考实现**（TTS/Voice 相关调用链、流式处理方式等，详见 14.2），不应成为 Voice Copilot 的 Runtime Dependency——无论是当前的同仓库阶段，还是未来独立成 Repo 之后。

### 14.2 可参考与不可带入的内容

与之前的原则一致，Codex / 开发者可以阅读并参考现有 Live2D 项目中的以下内容：

* TTS Provider 连接方式；
* WebSocket；
* Volcengine protocol；
* Streaming Session 的建立、推送文本、结束方式；
* 音频 chunk 接收与流式追加；
* MediaSource / SourceBuffer 流式播放实现（剥离 Live2D 相关部分后）；
* MP3 / Audio 数据处理；
* Blob / Object URL；
* 音频播放；
* 音频资源释放；
* speaker / voice 配置；
* speed / volume 等 Voice 参数；
* TTS 错误处理；
* localStorage 和简单配置持久化；
* Provider / Voice 配置的数据组织方式；
* §9 新增能力可额外参考：LLM 单向流式输出（`/api/chat-stream`、`geminiChatStream` 等 async generator 模式）与"按句子边界切分、尽快推流给 Streaming TTS"的调用链和低延迟衔接思路——**只参考调用链、流式数据衔接和低延迟处理方式本身**，不复用其路由，也不复用其携带的角色 / 对话业务逻辑。

以下内容不应被参考或复用，不应进入 Voice Copilot（§9 之后仍然成立，范围不因新增翻译能力而放宽）：

* `/api/chat`；
* `/api/chat-stream`；
* 现有 LLM Provider 调用中携带角色人设、对话历史的部分；
* ConversationEngine；
* 聊天历史 / chat history；
* Conversation Mode；
* Live2D system prompt；
* emoji / 内心活动 / emotion parser；
* topic suggestion；
* ASR；
* PTT；
* Speech-to-Speech；
* barge-in；
* realtime conversation；
* Live2D 页面 / 模型 / rendering；
* lip sync（含 AnalyserNode / DelayNode 嘴型同步链路）；
* motion；
* expression；
* Live2D filter；
* NERD 控件。

Voice Copilot 是一个独立子项目：

1. 新代码应优先位于独立的 `voice-copilot/` 目录（当前阶段为 `public/voice-copilot/`）；
2. 不应为了 Voice Copilot 主动重构现有 Live2D 项目；
3. 不应将 Voice Copilot 代码散落至现有 Live2D 页面和实验文件中；
4. 除非确有必要，不修改现有 Live2D 功能；
5. 目录结构、依赖方式应持续保持"迁移为独立 GitHub Repository 时改动最小"——不引入任何指向 Live2D 项目内部文件、路由或运行时状态的硬编码依赖。

§9 的 LLM / Translation 能力范围严格限定为"中文转英文，服务于 TTS 输入"；除此之外的 LLM / Text AI 能力（翻译方向扩展、通用改写、通用聊天等）仍然属于未来独立 Phase，本 Spec 不涉及，也不预设其技术方案。

---

## 15. MVP Success Criteria

Voice Copilot MVP 完成后，用户应能够完成以下完整流程：

### Scenario A — English Business Meeting

```text
Speech Text:

We have completed the API integration in the sandbox environment.
Our next step is to proceed with the production environment configuration.

↓

Voice:
My Voice

↓

Speak

↓

Streaming TTS 建立，持续接收 Audio Chunks

↓

首批音频尽快自动播放

↓

后续音频持续播放，直至生成与播放完成
```

成功标准：用户能够听到使用指定个人音色生成的英文语音，且播放在首批音频到达后即已尽快开始，无需等待整段语音生成完成。

### Scenario B — Internal Project Update

```text
Speech Text:

人民币汇出项目这边，
新渠道的产品和接口文档已经基本完成。
本周重点是和渠道技术团队进一步确认后续对接安排。

↓

Voice:
My Voice

↓

Speak

↓

Streaming TTS 建立，持续接收 Audio Chunks

↓

首批音频尽快自动播放

↓

后续音频持续播放，直至生成与播放完成
```

成功标准：用户能够听到使用指定个人音色生成的中文语音，且播放在首批音频到达后即已尽快开始，无需等待整段语音生成完成。

### Scenario C — Chinese Draft, Spoken in English（可选，"中文转英文"开启）

```text
用户开启"中文转英文"

Speech Text（中文）:

人民币汇出项目这边，
新渠道的产品和接口文档已经基本完成。
本周重点是和渠道技术团队进一步确认后续对接安排。

↓

Voice:
My Voice

↓

Speak

↓

LLM Streaming Translation 建立，持续产生英文文本片段

↓

足够可用的英文片段尽快提交给 Streaming TTS，持续接收 Audio Chunks

↓

首批英文音频尽快自动播放

↓

后续音频持续播放，直至翻译流结束、生成与播放完成
```

成功标准：用户能够听到使用指定个人音色生成的英文语音，该英文是系统对用户中文 Speech Text 的翻译结果；播放在首批英文音频到达后即已尽快开始，不需要等待整段中文翻译完全生成完成；关闭"中文转英文"后，同一段 Speech Text 改为按 Scenario A/B 的方式直接合成，不经过翻译。

---

## 16. MVP Acceptance Criteria

MVP 至少满足：

* 用户可以输入 / 粘贴 / 修改 Speech Text；
* TTS 始终使用当前链路应提交的最新内容（关闭"中文转英文"时为最新 Speech Text，开启时为以最新 Speech Text 为输入的翻译结果）；
* 可以配置至少一个 Voice Profile；
* 可以调用至少一个真实 TTS Provider，并以 Streaming 方式返回 Audio Chunks；
* 可以使用已有 Voice ID / Speaker ID；
* 可以生成真实音频；
* 用户点击 Speak 后开始建立 Streaming TTS Session（以及"中文转英文"开启时的 LLM Streaming Translation）；
* 只有用户主动点击 Speak 才允许开始该次 Streaming TTS（及可能的翻译）与后续自动播放流程；
* 首批可播放音频到达后应尽快自动播放，无需等待整段语音生成完成（Time to First Audio 是核心体验指标，两条 Speak 链路均适用）；
* 后续 Audio Chunks 到达后持续追加播放，直至生成完成；
* 可以 Pause，Pause 后台仍然继续接收并缓冲后续 Audio Chunks（如果生成尚未完成）；
* 可以 Resume / Play；
* 可以 Replay，Replay 仅在本轮音频已经完整生成完成、且尚未执行 Stop 时可用；
* 可以 Stop，Stop 会终止当前 Streaming TTS Session（及仍在进行的 LLM Streaming Translation）并清理 MediaSource / SourceBuffer / streaming buffer；
* Stop 后不要求保留本轮音频；如需再次收听需要重新点击 Speak；
* 修改 Speech Text 后再次 Speak 必须终止上一轮 Session（及翻译流）并重新生成最新文本对应的音频；
* 新音频应替换旧音频；
* 支持至少中文和英文目标验证（Scenario A/B），并可选验证 Scenario C（中文起草、英文播放）；
* 有基础 TTS 错误提示，并能区分翻译失败与语音合成失败（§9.4）；
* 用户可以主动开启或关闭"中文转英文"；关闭时系统行为与不存在该功能时完全一致（§9.1）；
* "中文转英文"开启时，LLM 产生足够可用的英文片段后应尽快提交给 Streaming TTS，不等待整段翻译完成（§9.2）；
* Voice Copilot 不依赖现有 Live2D 项目的 `/api/chat`、`/api/chat-stream`，或其携带的角色 / 对话业务逻辑；§9 的中文转英文使用 Voice Copilot 自己独立配置的 LLM 调用路径，与 Live2D 项目的 LLM 集成无关；
* Voice Copilot 不依赖 Live2D；
* Voice Copilot 不依赖 Live2D 页面、模型、状态或 UI；
* Voice Copilot 应能够独立启动运行，不要求现有 Live2D 项目的运行环境在场（§14）；
* 允许引入轻量 Node.js 运行层以支持独立运行、Credential 处理等需要，但不引入不必要的复杂后端架构（§14）；
* Settings 支持用户自行配置 Voice / TTS Provider Credential（至少 App ID / Access Token / Secret Key），无需修改代码（§13）；"中文转英文"开启时的 Translation / LLM Provider Credential 则通过服务器运行环境配置，Settings 仅展示其只读状态，不提供可写表单（§13.1、§13.2）；
* MVP / personal-use 阶段允许 Credential 存在于前端配置、localStorage 或经由轻量 Node.js 层的存储中，只要用户本人能够自行完成配置；
* Credential Management 在未来公开部署、多人使用、商业化或生产化前需要重新设计；
* 不实现 §9 范围之外的 Text AI（改写、润色、通用 Chat、多语言互译等）；
* 不实现 Voice Clone Workflow；
* 不实现 Desktop Audio Bridge；
* 不实现 Virtual Microphone；
* 不实现 ASR；
* 不实现 Speech-to-Speech；
* 不实现 Meeting Listening / 实时会议监听 / Realtime Conversation；
* 不实现 §9 范围之外的自动文本翻译或润色（例如英文→中文翻译、表达润色改写）；
* 不实现 Live2D Character / Motion / Expression / Lip Sync。

达到以上条件即可认为 Voice Copilot MVP 第一阶段完成。
