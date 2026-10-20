/**
 * AudioBridgeClient — browser side of the local Audio Bridge (server/lib/audio-bridge.js,
 * docs/teams-web-audio-injection-spec.md Phase 1).
 *
 * As a producer (the SayWise workspace) it forwards the same Audio Chunks the
 * StreamingAudioPlayer is already playing locally; as a consumer (test page, Phase 2's
 * Teams injector) it receives them. Forwarding is strictly best-effort and fire-and-forget:
 * if the bridge is down, chunks are dropped silently — local playback must never wait on,
 * or fail because of, the bridge.
 *
 * Connection state (BridgeClientState) is exactly one of:
 *   DISCONNECTED — no socket (never connected, closed, or waiting to reconnect)
 *   CONNECTING   — socket opening
 *   IDLE         — connected, no stream in flight
 *   STREAMING    — connected, a stream is in flight (producer: between beginStream() and
 *                  endStream()/abortStream(); consumer: between 'start'/first chunk and
 *                  'end'/'abort')
 *
 * Works in Node too (tests) by passing a WebSocket implementation such as `ws`.
 */

export const BridgeClientState = Object.freeze({
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING: 'CONNECTING',
  IDLE: 'IDLE',
  STREAMING: 'STREAMING',
});

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;
// Must match server/lib/audio-bridge.js's close code for a replaced producer.
const REPLACED_CLOSE_CODE = 4000;

/** ws://<current host>/audio-bridge?role=<role> — the bridge lives on the same server. */
export function defaultBridgeUrl(role, base = globalThis.location?.href) {
  if (!base || base.startsWith('file:') || base.startsWith('about:')) {
    return `ws://127.0.0.1:4100/audio-bridge?role=${role}`;
  }
  const url = new URL('/audio-bridge', base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('role', role);
  return url.toString();
}

export class AudioBridgeClient {
  /**
   * @param {object} options
   * @param {'producer'|'consumer'} options.role
   * @param {string} [options.url]            defaults to defaultBridgeUrl(role)
   * @param {boolean} [options.autoReconnect] default true
   * @param {Function} [options.WebSocketImpl] default globalThis.WebSocket
   * @param {(state: string) => void} [options.onStateChange]
   * @param {(msg: object) => void} [options.onMessage]   consumer: every JSON control frame
   * @param {(bytes: Uint8Array) => void} [options.onChunk] consumer: every Audio Chunk
   */
  constructor(options) {
    this.role = options.role;
    this.url = options.url || defaultBridgeUrl(this.role);
    this.autoReconnect = options.autoReconnect !== false;
    this.WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;
    this.onStateChange = options.onStateChange || (() => {});
    this.onMessage = options.onMessage || (() => {});
    this.onChunk = options.onChunk || (() => {});

    this.state = BridgeClientState.DISCONNECTED;
    this.ws = null;
    this.streamId = null;
    this._wanted = false; // connect() called and disconnect() not since
    this._reconnectDelay = RECONNECT_MIN_MS;
    this._reconnectTimer = null;
  }

  connect() {
    this._wanted = true;
    if (this.ws) return;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    this._setState(BridgeClientState.CONNECTING);

    const ws = new this.WebSocketImpl(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this._reconnectDelay = RECONNECT_MIN_MS;
      this._setState(BridgeClientState.IDLE);
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      if (typeof event.data === 'string') this._handleControl(event.data);
      else this._handleChunk(new Uint8Array(event.data));
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      // Replaced by a newer producer (another SayWise tab, the test page's simulator):
      // reconnecting would just kick that one out in turn, so stay down.
      if (event.code === REPLACED_CLOSE_CODE) this._wanted = false;
      this.ws = null;
      this.streamId = null;
      this._setState(BridgeClientState.DISCONNECTED);
      this._scheduleReconnect();
    };
    // 'error' is always followed by 'close', which does the cleanup.
    ws.onerror = () => {};
  }

  disconnect() {
    this._wanted = false;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    this.streamId = null;
    if (ws) ws.close();
    this._setState(BridgeClientState.DISCONNECTED);
  }

  get connected() {
    return this.state === BridgeClientState.IDLE || this.state === BridgeClientState.STREAMING;
  }

  // ---- producer API ------------------------------------------------------

  /**
   * Starts a new stream. `startedAt` (epoch ms — Date.now(), comparable across tabs on the
   * same machine) is the Speak click time consumers measure TTFA from.
   */
  beginStream({ mimeType = 'audio/mpeg', startedAt = Date.now() } = {}) {
    if (!this.connected) return;
    this.streamId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this._send(JSON.stringify({ type: 'start', streamId: this.streamId, mimeType, startedAt }));
    this._setState(BridgeClientState.STREAMING);
  }

  /** Forwards one Audio Chunk; a no-op unless a stream is in flight. Never throws. */
  sendChunk(bytes) {
    if (this.state !== BridgeClientState.STREAMING) return;
    this._send(bytes);
  }

  endStream() {
    this._finishStream('end');
  }

  abortStream() {
    this._finishStream('abort');
  }

  // ---- internals ---------------------------------------------------------

  _finishStream(type) {
    if (this.state !== BridgeClientState.STREAMING) return;
    this._send(JSON.stringify({ type, streamId: this.streamId }));
    this.streamId = null;
    this._setState(BridgeClientState.IDLE);
  }

  _send(data) {
    try {
      this.ws?.send(data);
    } catch (err) {
      console.warn('[audio-bridge] send failed:', err);
    }
  }

  _handleControl(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (this.role === 'consumer') {
      if (msg.type === 'start') {
        this.streamId = msg.streamId ?? null;
        this._setState(BridgeClientState.STREAMING);
      } else if (msg.type === 'end' || msg.type === 'abort') {
        this.streamId = null;
        this._setState(BridgeClientState.IDLE);
      }
    }
    this.onMessage(msg);
  }

  _handleChunk(bytes) {
    if (this.role !== 'consumer') return;
    // A chunk with no 'start' (e.g. joined mid-stream) still means audio is flowing.
    if (this.state === BridgeClientState.IDLE) this._setState(BridgeClientState.STREAMING);
    this.onChunk(bytes);
  }

  _scheduleReconnect() {
    if (!this._wanted || !this.autoReconnect) return;
    const delay = this._reconnectDelay;
    this._reconnectDelay = Math.min(delay * 2, RECONNECT_MAX_MS);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._wanted) this.connect();
    }, delay);
  }

  _setState(next) {
    if (this.state === next) return;
    this.state = next;
    try {
      this.onStateChange(next);
    } catch (err) {
      console.error('[audio-bridge] onStateChange threw:', err);
    }
  }
}
