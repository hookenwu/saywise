/**
 * StreamingTTSClient — Volcengine bidirectional streaming TTS WebSocket client.
 *
 * Adapted from public/js/streaming-tts-client.js (tasks.md Phase 3):
 *  - beginSession()/pushText()/endSession() + the background message pump
 *    are the core reuse (T3.3) — this is what streams Audio Chunks back
 *    to the caller via onChunk as they arrive.
 *  - connect()/_disconnect()/_setupHandlers() and the low-level
 *    _sendEvent/_receiveMessage/_waitForEvent/_uuid/_voiceToResourceId
 *    plumbing are reused as-is (T3.2, T3.4), with credentials now sourced
 *    from a Provider Configuration object instead of hardcoded constants.
 *  - synthesize()/_doSynthesize()/_collectAudioUntilSessionFinished (the
 *    complete-audio path) are deliberately NOT adapted this round (T3.7) —
 *    Voice Copilot always streams.
 *  - cancelSession() is new (T3.5) — see its own comment below for the
 *    chain-release correctness requirement.
 *  - T3.5a (session isolation for connection reuse) was tested against
 *    the real Volcengine endpoint before deciding how to implement it —
 *    NOT assumed either way. Two things were found, both confirmed live:
 *      1. AudioOnlyServer frames DO carry a populated sessionId, and a
 *         real (separate) client-side deadlock in _waitForEvent's
 *         mismatch-requeue logic was found and fixed — see that
 *         method's comment.
 *      2. Even after that fix, reusing the WebSocket connection right
 *         after cancelling a session with audio actively in flight
 *         reproducibly caused the *server* to return a MsgType.Error
 *         frame and then silently stop responding to the next session on
 *         that same connection — a server-side behavior no amount of
 *         client-side message routing can work around.
 *    Net result: cancelSession() uses T3.5a's explicitly-provided
 *    fallback — it forces a full disconnect before releasing the chain,
 *    rather than reusing the connection. See Phase 3 completion notes in
 *    tasks.md for the empirical trace that led here.
 */

import {
  EventType,
  MsgType,
  MsgTypeFlagBits,
  createMessage,
  marshalMessage,
  unmarshalMessage,
} from './volcengine-protocol.js';

function _voiceToResourceId(speaker) {
  if (typeof speaker === 'string' && speaker.startsWith('S_')) {
    return 'seed-icl-2.0';
  }
  return 'volc.service_type.10029';
}

export class StreamingTTSClient {
  /** @param {{ appKey: string, accessToken: string }} providerConfiguration */
  constructor(providerConfiguration) {
    if (!providerConfiguration || !providerConfiguration.appKey || !providerConfiguration.accessToken) {
      throw new Error('StreamingTTSClient requires a Provider Configuration with appKey/accessToken');
    }

    this.ws = null;
    this.isConnected = false;
    this.isConnecting = false;

    this.endpoint = 'wss://openspeech.bytedance.com/api/v3/tts/bidirection';
    this.appKey = providerConfiguration.appKey;
    this.accessToken = providerConfiguration.accessToken;
    this.encoding = 'mp3';
    this.sampleRate = 24000;

    // 当前 WebSocket 连接使用的 api_resource_id：
    //   'seed-icl-2.0'            → S_* 复刻音色所在资源
    //   'volc.service_type.10029' → 豆包 2.0 / 通用音色
    this._currentResourceId = null;

    // 每个元素: { resolve, reject }
    this._msgCallbacks = [];
    this._msgQueue = [];

    // 串行化合成：API 只允许 1 个并发 session
    this._synthChain = Promise.resolve();

    // 当前打开中的 session：
    //   { sessionId, userUid, reqParamsBase, finishedPromise, chainRelease, cancelled }
    this._activeSession = null;
  }

  // ─── 连接生命周期 ──────────────────────────────────────────────────────────

  /**
   * 建立 WebSocket 连接。若已连接且资源 ID 不一致，会先断开再重连。
   * @param {string} resourceId  api_resource_id
   */
  async connect(resourceId) {
    if (this.isConnected && this._currentResourceId === resourceId) return;

    if (this.isConnected && this._currentResourceId !== resourceId) {
      console.log(`[TTS WS] resource change: ${this._currentResourceId} -> ${resourceId}, reconnecting`);
      await this._disconnect();
    }

    if (this.isConnecting) {
      await new Promise((resolve, reject) => {
        const check = setInterval(() => {
          if (this.isConnected) { clearInterval(check); resolve(); }
          else if (!this.isConnecting) { clearInterval(check); reject(new Error('Connection failed')); }
        }, 50);
      });
      if (this._currentResourceId !== resourceId) {
        return this.connect(resourceId);
      }
      return;
    }

    this.isConnecting = true;

    const connectId = this._uuid();
    const url = new URL(this.endpoint);
    url.searchParams.set('api_app_key', this.appKey);
    url.searchParams.set('api_access_key', this.accessToken);
    url.searchParams.set('api_resource_id', resourceId);
    url.searchParams.set('api_connect_id', connectId);

    console.log('[TTS WS] Connecting to:', url.toString());
    this.ws = new WebSocket(url.toString());
    this.ws.binaryType = 'arraybuffer';

    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('WebSocket connection timeout (10s)'));
        }, 10000);

        this.ws.onopen = async () => {
          clearTimeout(timeout);
          this._setupHandlers();
          try {
            await this._sendEvent(EventType.StartConnection, null, '{}');
            await this._waitForEvent(MsgType.FullServerResponse, EventType.ConnectionStarted);
            this.isConnected = true;
            this.isConnecting = false;
            this._currentResourceId = resourceId;
            console.log('[TTS WS] Connected and ready, resource:', resourceId);
            resolve();
          } catch (e) {
            this.isConnecting = false;
            reject(e);
          }
        };

        this.ws.onerror = () => {
          clearTimeout(timeout);
          this.isConnecting = false;
          reject(new Error('WebSocket connection error'));
        };
      });
    } catch (err) {
      this.isConnecting = false;
      console.error('[TTS WS] connect failed:', err.message);
      if (this.ws) { try { this.ws.close(); } catch (_) {} this.ws = null; }
      throw err;
    }
  }

  // 主动断开当前连接；按 demo 流程先发 FinishConnection 再 close
  async _disconnect() {
    if (!this.ws) {
      this._hardReset();
      return;
    }
    try {
      if (this.ws.readyState === WebSocket.OPEN) {
        try {
          console.log('[TTS WS] disconnecting: sending FinishConnection, resource:', this._currentResourceId);
          await this._sendEvent(EventType.FinishConnection, null, '{}');
          await Promise.race([
            this._waitForEvent(MsgType.FullServerResponse, EventType.ConnectionFinished),
            new Promise((r) => setTimeout(r, 500)),
          ]);
        } catch (_) { /* 服务端可能已关闭连接 */ }
      }
      try { this.ws.close(); } catch (_) {}
    } finally {
      await new Promise((r) => setTimeout(r, 50));
      this._hardReset();
    }
  }

  // ─── 主接口：Streaming Session ─────────────────────────────────────────────

  /**
   * 打开一个 TTS session 并启动后台消息泵；同一时刻最多 1 个 active session（API 限制）。
   * 多个 beginSession 调用会通过 _synthChain 串行：后来的 beginSession 会等前一个
   * endSession()/cancelSession() 释放 chain 后才继续。
   *
   * @param {object} voiceSettings  { speaker, speed, volume, pitch, useTTS2 } — speaker is
   *   required; pitch is optional, defaults to 0 (neutral), clamped to [-12, 12]
   * @param {object} callbacks      { onChunk(Uint8Array), onSentenceStart(string), onSentenceEnd(string) }
   * @returns {Promise<void>}        在收到 SessionStarted 后 resolve（不是 SessionFinished）
   */
  beginSession(voiceSettings = {}, callbacks = {}) {
    const prev = this._synthChain;
    let chainRelease;
    const held = new Promise((r) => { chainRelease = r; });
    this._synthChain = held;
    held.catch(() => {});

    const task = (async () => {
      await prev.catch(() => {});
      try {
        await this._doBeginSession(voiceSettings, callbacks, chainRelease);
      } catch (err) {
        chainRelease();
        throw err;
      }
    })();
    return task;
  }

  async _doBeginSession(voiceSettings, callbacks, chainRelease) {
    if (this._activeSession) {
      // 链式串行下不应发生；防御性兜底
      throw new Error('beginSession: another session is already active');
    }

    const { onChunk, onSentenceStart, onSentenceEnd } = callbacks;
    const voiceType = voiceSettings.speaker;
    if (!voiceType) throw new Error('beginSession: voiceSettings.speaker is required');
    const resourceId = _voiceToResourceId(voiceType);
    const useTTS2 = voiceSettings.useTTS2 === true;

    console.log(
      '[TTS WS] beginSession →',
      'speaker=', voiceType,
      'resourceId=', resourceId,
      'model=', useTTS2 ? 'seed-tts-2.0-expressive' : 'seed-tts-1.1'
    );

    if (this.isConnected && this._currentResourceId !== resourceId) {
      await this._disconnect();
    }
    if (!this.isConnected) await this.connect(resourceId);

    const sessionId = this._uuid();
    const userUid = this._uuid();
    const speed = Math.max(0.2, Math.min(3.0, voiceSettings.speed || 1.0));
    const volume = Math.max(0.1, Math.min(3.0, voiceSettings.volume || 1.0));
    // Pitch (speaking-style spec.md §7.3, plan.md §5.2): confirmed wire field is
    // req_params.post_process.pitch — a sibling of audio_params/additions on req_params,
    // NOT a *_ratio field inside `additions` alongside speed_ratio/volume_ratio above.
    // Range [-12, 12], neutral/default 0. Sent unconditionally (including at 0), the same
    // way speed_ratio/volume_ratio are already sent unconditionally at their own neutral
    // values, so the payload shape stays uniform regardless of whether the user customized
    // prosody.
    const pitch = Math.max(-12, Math.min(12, voiceSettings.pitch ?? 0));
    const additions = JSON.stringify({
      disable_markdown_filter: true,
      speed_ratio: speed,
      volume_ratio: volume,
      ...(useTTS2 ? { use_tag_parser: true } : {}),
    });
    const reqParamsBase = {
      speaker: voiceType,
      model: useTTS2 ? 'seed-tts-2.0-expressive' : 'seed-tts-1.1',
      audio_params: { format: this.encoding, sample_rate: this.sampleRate, enable_timestamp: false },
      additions,
      post_process: { pitch },
    };

    const sessionPayload = JSON.stringify({
      user: { uid: userUid },
      req_params: reqParamsBase,
      event: EventType.StartSession,
    });
    await this._sendEvent(EventType.StartSession, sessionId, sessionPayload);
    await this._waitForEvent(MsgType.FullServerResponse, EventType.SessionStarted, sessionId);

    // Session record created before the pump starts so both the pump
    // closure and cancelSession() share the same mutable object — this is
    // what makes the `cancelled` flag (T3.6) and chainRelease() (T3.5)
    // work correctly across the two. finishedResolve is also stored on
    // the session itself (not just closed over) so cancelSession() can
    // unblock a concurrently in-flight endSession() call — see both
    // methods' comments for why this matters.
    let finishedResolve, finishedReject;
    const finishedPromise = new Promise((res, rej) => { finishedResolve = res; finishedReject = rej; });
    const session = { sessionId, userUid, reqParamsBase, finishedPromise, finishedResolve, chainRelease, cancelled: false };
    this._activeSession = session;

    const t0 = performance.now();
    let chunkCount = 0;
    let firstChunkLogged = false;

    (async () => {
      try {
        const deadline = Date.now() + 5 * 60 * 1000; // 5min 绝对上限，防止僵死
        while (true) {
          if (session.cancelled) {
            console.log('[TTS WS] pump exiting: session cancelled, sessionId=', sessionId.slice(0, 8));
            return;
          }
          if (Date.now() > deadline) throw new Error('Session pump timed out (5min)');

          const msg = await this._receiveMessage();

          if (session.cancelled) {
            // Cancelled while awaiting the next message — drop it and exit.
            return;
          }

          // T3.5a: session isolation. A message with a populated sessionId
          // that doesn't match this session belongs to a different round
          // (e.g. a straggler from a just-cancelled session on a reused
          // connection) — discard rather than deliver to any callback.
          if (msg.sessionId && msg.sessionId !== sessionId) {
            console.warn(
              '[TTS WS] discarding stray message for sessionId=', msg.sessionId.slice(0, 8),
              'expected=', sessionId.slice(0, 8)
            );
            continue;
          }

          if (msg.type === MsgType.AudioOnlyServer && msg.payload.length > 0) {
            chunkCount++;
            if (!firstChunkLogged) {
              firstChunkLogged = true;
              console.log('[TTS WS] first audio chunk in', Math.round(performance.now() - t0), 'ms');
            }
            if (typeof onChunk === 'function') {
              try { onChunk(msg.payload.slice()); } catch (e) { console.error('[TTS WS] onChunk threw:', e); }
            }
            continue;
          }
          if (msg.type === MsgType.Error) {
            throw new Error(`TTS server error: ${new TextDecoder().decode(msg.payload)}`);
          }
          if (msg.type === MsgType.FullServerResponse) {
            if (msg.event === EventType.TTSSentenceStart) {
              if (typeof onSentenceStart === 'function') {
                try { onSentenceStart(new TextDecoder().decode(msg.payload)); } catch (_) {}
              }
              continue;
            }
            if (msg.event === EventType.TTSSentenceEnd) {
              if (typeof onSentenceEnd === 'function') {
                try { onSentenceEnd(new TextDecoder().decode(msg.payload)); } catch (_) {}
              }
              continue;
            }
            if (msg.event === EventType.SessionFinished) {
              console.log('[TTS WS] session finished, chunks=', chunkCount, 'total=', Math.round(performance.now() - t0), 'ms');
              finishedResolve();
              return;
            }
            // UsageResponse 等其它事件忽略
          }
        }
      } catch (err) {
        finishedReject(err);
      }
    })();
  }

  /**
   * 往当前 active session 发送一段文本。Voice Copilot 每个 session 只调用一次
   * （整段当前 Speech Text），不做分句 push（tasks.md T3.3）。
   */
  async pushText(text) {
    if (!this._activeSession) throw new Error('pushText: no active session, call beginSession first');
    if (!text || !text.length) return;
    const s = this._activeSession;
    console.log(
      '[TTS WS] pushText →',
      'sessionId=', s.sessionId.slice(0, 8),
      'len=', text.length
    );
    const payload = JSON.stringify({
      user: { uid: s.userUid },
      req_params: { ...s.reqParamsBase, text },
      event: EventType.TaskRequest,
    });
    await this._sendEvent(EventType.TaskRequest, s.sessionId, payload);
  }

  /**
   * 正常结束：发送 FinishSession，等待消息泵收到 SessionFinished 后释放 chain。
   *
   * Correctness requirement (tasks.md T3.3 / review ⑦): this awaits
   * `s.finishedPromise`, which the pump above only resolves upon actually
   * observing EventType.SessionFinished from the provider — NOT upon the
   * FinishSession request merely being sent. Callers (Phase 5) must be
   * able to rely on this Promise resolving only once the provider has
   * confirmed no more audio chunks are coming.
   *
   * Concurrency fix (found during Phase 6 verification, real bug, not
   * theoretical): this method does NOT null `this._activeSession`
   * immediately on entry. Voice Copilot's actual call pattern (Phase 5)
   * invokes beginSession -> pushText -> endSession back-to-back without
   * waiting for user interaction, so endSession() is normally already
   * in flight — genuinely still awaiting `s.finishedPromise` — at the
   * exact moment a user clicks Stop and triggers cancelSession() on the
   * very same session. The original version of this method nulled
   * `_activeSession` synchronously on entry, which meant cancelSession()
   * (called moments later) found nothing to act on, silently no-op'd,
   * and — critically — never called chainRelease(), leaving the *next*
   * beginSession() blocked until this session's real SessionFinished
   * eventually arrived (i.e. Stop appeared to work in the UI but the
   * old generation kept running server-side and blocked the next Speak
   * for its full remaining duration). Only nulling `_activeSession` in
   * `finally`, keyed off object identity (`this._activeSession === s`),
   * keeps the session visible to cancelSession() for as long as this
   * call is genuinely still waiting on it.
   */
  async endSession() {
    const s = this._activeSession;
    if (!s) return;
    try {
      await this._sendEvent(EventType.FinishSession, s.sessionId, '{}');
      await s.finishedPromise;
    } finally {
      if (this._activeSession === s) this._activeSession = null;
      s.chainRelease();
    }
  }

  /**
   * 中止当前 session（tasks.md T3.5）：不等待服务端确认（fire-and-forget
   * CancelSession），但无条件释放 chain —— 这是让下一次 beginSession() 不被
   * 永久阻塞的关键，必须在任何路径下都执行，不能只放在成功分支里。
   *
   * A session may have BOTH endSession() and cancelSession() called on
   * it — not "exactly one of the two" as originally assumed (see the
   * concurrency-fix note on endSession() above for why that assumption
   * was wrong and what broke because of it). This method must therefore
   * be able to act on `this._activeSession` even while endSession() is
   * concurrently awaiting the very same session's `finishedPromise`, and
   * must unblock that concurrent await itself — the pump's own
   * cancelled-early-return path does not settle `finishedPromise` (it
   * just stops consuming), so without the explicit `s.finishedResolve()`
   * call below, a concurrently in-flight endSession() would hang
   * forever waiting for a SessionFinished that will never arrive once
   * the pump has stopped listening for it.
   *
   * T3.5a — forced-reconnect fallback (empirically required, not the
   * connection-reuse path plan.md §15 originally assumed): reusing the
   * WebSocket connection immediately after cancelling a session that had
   * audio actively in flight was tested against the real Volcengine
   * endpoint and reproducibly caused the *server* to send a MsgType.Error
   * frame and then silently stop responding to the next session's
   * StartSession on that same connection — no further messages, no
   * WebSocket close event, just a dead connection that never recovers.
   * This is a server-side behavior, not a client-side message-routing
   * bug (a real client-side requeue deadlock was found and fixed
   * separately in _waitForEvent, but fixing it did not make connection
   * reuse safe — the server-side dead-connection behavior persisted).
   * Per T3.5a's explicit instruction for exactly this outcome, cancelling
   * therefore always forces a full disconnect before releasing the
   * chain, trading the TTFA benefit of connection reuse for correctness.
   * See Phase 3 completion notes in tasks.md for the empirical trace.
   */
  async cancelSession() {
    const session = this._activeSession;
    if (!session) return;
    session.cancelled = true;
    if (this._activeSession === session) this._activeSession = null;
    try {
      await this._sendEvent(EventType.CancelSession, session.sessionId, '{}');
    } catch (err) {
      console.warn('[TTS WS] cancelSession: CancelSession send failed (ignored, fire-and-forget):', err.message);
    }
    try {
      await this._disconnect();
    } catch (err) {
      console.warn('[TTS WS] cancelSession: forced disconnect failed (ignored, will reconnect on next beginSession):', err.message);
    }
    // Only unblock a concurrently in-flight endSession() (awaiting this
    // same session's finishedPromise) and release the chain now, AFTER
    // the forced disconnect has actually finished — not before. A second
    // real bug found during Phase 6 verification: resolving
    // finishedPromise earlier let endSession()'s own `finally` release
    // the chain while this method's disconnect was still tearing down
    // `this.ws`, letting the *next* beginSession()'s connect() race that
    // teardown and crash with "Cannot set properties of null (setting
    // 'onmessage')". The pump itself never settles finishedPromise once
    // it observes `cancelled` (it just stops consuming), so this call
    // must settle it — just not until disconnect is truly done.
    session.finishedResolve();
    // Safe to call even if endSession()'s own `finally` already called
    // this — chainRelease() is a Promise resolver, calling it more than
    // once is a no-op after the first call.
    session.chainRelease();
  }

  // ─── 消息收发 ──────────────────────────────────────────────────────────────

  _setupHandlers() {
    this.ws.onmessage = (event) => {
      try {
        if (!(event.data instanceof ArrayBuffer)) {
          throw new Error('Expected binary WebSocket frame');
        }
        const msg = unmarshalMessage(new Uint8Array(event.data));

        if (this._msgCallbacks.length > 0) {
          const { resolve } = this._msgCallbacks.shift();
          resolve(msg);
        } else {
          this._msgQueue.push(msg);
        }
      } catch (err) {
        console.error('[TTS WS] message parse error:', err);
      }
    };

    this.ws.onclose = (event) => {
      console.log('[TTS WS] closed:', event.code, event.reason);
      this._rejectPendingCallbacks(new Error(`WebSocket closed (code ${event.code})`));
      this._hardReset();
    };

    this.ws.onerror = (err) => {
      console.error('[TTS WS] error after open:', err);
    };
  }

  async _sendEvent(eventType, sessionId, payloadStr) {
    const msg = createMessage(MsgType.FullClientRequest, MsgTypeFlagBits.WithEvent);
    msg.event = eventType;
    if (sessionId) msg.sessionId = sessionId;
    msg.payload = new TextEncoder().encode(payloadStr || '{}');
    this.ws.send(marshalMessage(msg));
  }

  _receiveMessage() {
    return new Promise((resolve, reject) => {
      if (this._msgQueue.length > 0) {
        resolve(this._msgQueue.shift());
        return;
      }
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not open'));
        return;
      }
      this._msgCallbacks.push({ resolve, reject });
    });
  }

  async _waitForEvent(expectedMsgType, expectedEvent, sessionId) {
    const deadline = Date.now() + 15000; // 15s 超时
    while (true) {
      if (Date.now() > deadline) throw new Error(`Timeout waiting for event ${expectedEvent}`);

      const msg = await this._receiveMessage();

      if (msg.type === MsgType.Error) {
        throw new Error(`TTS server error: ${new TextDecoder().decode(msg.payload)}`);
      }

      // T3.5a correctness fix, found by empirical Phase 3 verification
      // (tasks.md): a message carrying a *different*, populated sessionId
      // than the one we're waiting on can never be the message this call
      // is looking for — e.g. a straggler from a just-cancelled session's
      // pump on a reused connection. Discard it here instead of
      // unshifting it back onto the front of _msgQueue: requeuing to the
      // front, combined with a concurrent pump loop that silently drops
      // (rather than requeues) its own cancelled-session messages, was
      // observed to deadlock — this call kept re-dequeuing the same
      // stray message forever while genuinely new messages (including
      // the SessionStarted this call is actually waiting for) piled up
      // unseen behind it. Messages with no sessionId, or matching our
      // own, keep the original requeue-and-keep-waiting behavior.
      if (sessionId && msg.sessionId && msg.sessionId !== sessionId) {
        console.warn(
          '[TTS WS] _waitForEvent: discarding stray message for sessionId=', msg.sessionId.slice(0, 8),
          'while waiting for sessionId=', sessionId.slice(0, 8)
        );
        continue;
      }

      const sessionMatch = !sessionId || !msg.sessionId || msg.sessionId === sessionId;
      if (msg.type === expectedMsgType && msg.event === expectedEvent && sessionMatch) {
        return msg;
      }

      this._msgQueue.unshift(msg);
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  // ─── 内部工具 ──────────────────────────────────────────────────────────────

  _rejectPendingCallbacks(err) {
    const callbacks = this._msgCallbacks.splice(0);
    for (const { reject } of callbacks) {
      try { reject(err); } catch (_) {}
    }
  }

  _hardReset() {
    this.ws = null;
    this.isConnected = false;
    this.isConnecting = false;
    this._currentResourceId = null;
    this._msgQueue = [];
    this._msgCallbacks = [];
  }

  _uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
}
