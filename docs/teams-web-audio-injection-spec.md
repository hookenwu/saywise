# SayWise → Teams Web 实时音频注入技术规格说明书 (SPEC)

## 1. 背景与核心目标

### 1.1 核心目标
在不修改 SayWise 既有单人语音工作台核心行为的前提下，实现：
在同一台机器（VPS 或用户工作电脑）的 Chrome/Chromium 浏览器中，同时打开 SayWise 工作台与 Microsoft Teams Web（`teams.microsoft.com`）；当用户在 SayWise 点击 **Speak** 时，流式克隆 TTS 语音在超低首包延迟（TTFA）下实时注入到 Teams Web 的会议麦克风音轨中，会议远端可清晰收听，且支持真人麦克风与 TTS 的平滑混音与静音控制。

### 1.2 现有资产与证据（Evidence Baseline）
1. **SayWise 音频输出端**：
   - 证据（已实测确认）：`js/tts-client.js`（`StreamingTTSClient`）通过双向 WebSocket 接收火山引擎二进制帧，通过 `onChunk(bytes)` 实时回调 MP3 音频分片；
   - 证据（已实测确认）：`js/streaming-audio-player.js`（`StreamingAudioPlayer`）利用浏览器原生的 `MediaSource` / `SourceBuffer` (audio/mpeg) 追加分片并在 `<audio>` 播放。
2. **Teams Web 音频采集端**：
   - 证据（WebRTC 规范事实）：所有基于浏览器的 VoIP/会议客户端（包括 Teams Web、Google Meet、Zoom Web）最终均通过 `navigator.mediaDevices.getUserMedia({ audio: ... })` 获取本地音频 `MediaStreamTrack`，并调用 `RTCPeerConnection.prototype.addTrack` 或 `replaceTrack` 灌入 WebRTC 管道；
   - 设计假设（待自动化验证）：Teams Web 内部采用标准的 WebRTC 音频流水线与约束集（可能包含 echoCancellation, noiseSuppression, autoGainControl），注入的 Track 需能抗住这些预处理，或在约束劫持时适度调整。

---

## 2. 方案对比与技术权衡 (Trade-Offs)

| 评估维度 | 方案 A：纯浏览器端 Web Audio + WebRTC 劫持（优先主线） | 方案 B：Linux PulseAudio 虚拟声卡 Source/Sink（备选保底） |
|---|---|---|
| **核心机制** | 浏览器扩展 / 脚本劫持 `getUserMedia`，在 Web Audio 混音后输出 `MediaStreamDestination` 作为麦克风 Track | PulseAudio 加载 `module-null-sink` 和 `module-virtual-source`，Chrome 麦克风选择该虚拟设备 |
| **系统依赖** | **零系统依赖**。跨平台（Linux/macOS/Windows 均可跑，甚至适用于手机端支持扩展的浏览器） | 强依赖 Linux 系统音频守护进程（PulseAudio/PipeWire 配置、权限） |
| **音频延迟** | 极低（浏览器内存直连，零二次内核/驱动缓冲） | 存在内核缓冲与混音时钟开销（通常增加 20~50ms 延迟） |
| **音质保真** | 48kHz 全频带浮点数字音频无损传递 | 经由 PulseAudio 重采样与虚拟管道中转，可能产生微小失真 |
| **真人混音** | Web Audio API 动态 GainNode 控制，支持 TTS 发言时真人自动闪避（Ducking）或共存 | 需配置 PulseAudio 复杂的 loopback 路由，配置复杂度高 |
| **主要技术风险** | Teams Web 的 CSP 策略、Origin 隔离、页面刷新后重新协商机制 | VPS 无头/轻量图形环境与音频守护进程的持续生命周期维护 |

**结论**：坚决以 **方案 A（纯浏览器 Web Audio 劫持）** 为主攻路线，方案 B 作为系统级兜底基准。

---

## 3. 详细架构设计 (Architecture: 方案 A)

### 3.1 总体拓扑
```
┌─────────────────────────────────┐       ┌─────────────────────────────────┐
│     SayWise Tab (Tab A)         │       │     Teams Web Tab (Tab B)       │
│                                 │       │                                 │
│  [Speech Text] -> [Speak]       │       │   Teams Meeting Call Engine     │
│         │                       │       │               ▲                 │
│         ▼                       │       │               │ (MediaStream)   │
│  StreamingTTSClient             │       │   ┌──────────────────────────┐  │
│         │ (MP3 chunks)          │       │   │ Injected Audio Bridge    │  │
│         ▼                       │       │   │                          │  │
│  Audio Bridge Client            │       │   │ - Real Mic Input         │  │
│         │                       │       │   │ - Web Audio Mixer Node   │  │
│         │ (BroadcastChannel /   │       │   │ - Destination Stream     │  │
│         │  Local WebSocket)     │       │   └───────────▲──────────────┘  │
└─────────┼───────────────────────┘       └───────────────┼─────────────────┘
          │                                               │
          └───────────── Audio Chunks Stream ─────────────┘
```

### 3.2 关键子系统分解

#### 1. 跨页面音频传递（Cross-Origin Audio Bridge）
- **边界事实**：SayWise 运行在 `http://localhost:4100`（或自定义域名），而 Teams 运行在 `https://teams.microsoft.com`。由于浏览器的同源策略（Same-Origin Policy），常规的 `BroadcastChannel`、`localStorage` 和 `SharedWorker` 无法直接跨源通信。
- **技术选型**：
  - **模式 1（本地 WebSocket Bridge，推荐）**：利用 SayWise 自带的轻量 Node.js 后端（`server/index.js`），开启一个轻量 WebSocket 广播通道（`ws://localhost:4100/audio-bridge`）。SayWise 前端连接作为 Producer 发送分片；Teams Web 页面连接作为 Consumer 接收分片。零跨域阻碍，延迟在 1ms 以内。
  - **模式 2（Chrome Extension 消息总线）**：通过 MV3 Chrome Extension 的 Background Service Worker 作为消息中继。

#### 2. Teams Web 音轨劫持与混音引擎
- **载体**：轻量注入脚本（通过 Chrome Extension 或 Tampermonkey / 启动注入）。
- **拦截核心**：
  在 Teams 页面加载最早时（`document_start` 或页面上下文），代理 `navigator.mediaDevices.getUserMedia`：
  1. 调用原生 `getUserMedia` 获取真实的物理麦克风 `realMicStream`；
  2. 创建 `AudioContext`（采样率 48000Hz）；
  3. 创建 `MediaStreamSourceNode(realMicStream)` 接入真人麦克风，挂载 `realMicGainNode`；
  4. 创建 `SayWiseAudioNode`（流式解码播放节点），挂载 `ttsGainNode`；
  5. 混音汇入 `MediaStreamAudioDestinationNode`；
  6. 将混合后的 `destination.stream.getAudioTracks()[0]` 组装为合成的 `MediaStream` 返回给 Teams。
- **真人与 TTS 混音状态控制**：
  - 支持快捷键或指令设置：
    - `MODE_MIX`：真人麦克风与 TTS 同时保留；
    - `MODE_TTS_ONLY`：TTS 播放期间自动静音真人麦克风（防止敲键盘/环境杂音进入）；
    - `MODE_PASSTHROUGH`：SayWise 未发声时完全透明透传真人麦克风。

#### 3. 流式解码与防爆音（Streaming Web Audio Decoder）
- SayWise 接收到的是连续的 MP3 二进制分片。
- 在混音侧：维护一个流式 PCM 解码缓冲队列，首包解码完成后立即通过 Web Audio API 以 scheduled buffer 方式连续播放，保持无缝拼接，避免断帧导致的咔嗒爆音（Clicks/Pops）。

---

## 4. 领域模型与互斥状态机 (Domain Model & States)

系统状态严格互斥，杜绝模糊状态：

### 4.1 注入连接状态 (`BridgeConnectionState`)
- `DISCONNECTED`：未连接到 SayWise Audio Bridge 服务端。
- `CONNECTING`：正在建立跨页面连接。
- `STANDBY`：连接已建立，音频通道就绪，无音频输入传输。
- `STREAMING`：正在实时接收并向麦克风注水分片。
- `ERROR`：连接异常或鉴权失败，等待重试。

### 4.2 音频输入与混音模式 (`AudioMixMode`)
- `REAL_MIC_ONLY`：完全透传真人麦克风，TTS 通道静音。
- `TTS_ONLY`：TTS 独占，真人麦克风完全静音。
- `DUCKING`：当 TTS 发声时自动将真人麦克风降低 -18dB，TTS 结束后平滑回弹。
- `SIMULTANEOUS`：两者同时等权重混音。

---

## 5. 分阶段实施计划 (Phased Plan)

### Phase 1：跨源音频传输与独立 Web Audio 验证 (VPS 端)
- 在 SayWise 后端增加 `/audio-bridge` 轻量 WebSocket 通道；
- SayWise 前端增加 Bridge 发送逻辑，用户点击 Speak 时同步发送音频 chunks；
- 编写独立的接收端测试页（`test-receiver.html`），实测验证流式分片接收、Web Audio 动态解码与混音的延迟与连续性。

### Phase 2：Teams Web 麦克风劫持注入器 (Injector Script / Extension)
- 开发注入脚本，安全劫持 `navigator.mediaDevices.getUserMedia` 与 `RTCPeerConnection`；
- 在标准 WebRTC 测试环境（如 `appr.tc` 或标准 WebRTC 远端收音探针）中验证虚拟 Track 能被正常采集、编码并传输到远端。

### Phase 3：Teams Web 端到端实测验证
- 在 VPS 真实 Chrome 浏览器中加载注入器并打开 Teams Web；
- 自动化或人工配合进入 Teams 会议测试间；
- 触发 SayWise Speak，在远端会议接收端（如手机端 Teams 或另一个接收端）录音取证，确认声音清晰度与克隆音色完整度。

### Phase 4：PulseAudio 虚拟声卡兜底备选验证与对比评估
- 在 VPS 上配置 PulseAudio `module-null-sink` 作为对照组；
- 从延迟、CPU 占用、断流恢复和部署复杂度输出客观对比报告。

---

## 6. 风险自检与边界声明 (Self-Review & Non-Goals)

### 6.1 边界与非目标 (Non-Goals)
1. **不做屏幕录制共享依赖**：保持后台纯音频注入；
2. **不篡改 SayWise 既有单人 Web 流程**：原有 `<audio>` 播放、配置与翻译流保持 100% 独立向后兼容；
3. **不触碰 Teams 登录凭据**：Teams 账号登录、MFA 验证完全由用户在 VPS 浏览器中自行完成。

### 6.2 假设与证据标注 (Assumptions vs Facts)
- **事实 1**：SayWise 前端完全掌握流式 TTS 的二进制分片（`js/tts-client.js:146`），可以复制给桥接管道；
- **事实 2**：WebRTC 依赖 `getUserMedia` 返回的 `MediaStreamTrack`，替换该 Track 即可替换远端音频源；
- **设计假设 1**：Teams Web 的降噪/回声消除算法不会把克隆语音误当做环境噪声滤除（需在 Phase 3 真机实测）。
