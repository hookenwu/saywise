/**
 * Audio Bridge — local WebSocket fan-out of Streaming TTS Audio Chunks
 * (docs/teams-web-audio-injection-spec.md §3.2.1 "模式 1", Phase 1).
 *
 * One producer (the SayWise workspace tab) pushes the same MP3 Audio Chunks it is already
 * appending to its own StreamingAudioPlayer; every connected consumer (a Teams Web
 * injector tab, test/audio-bridge-test.html, ...) receives them verbatim. The bridge never
 * decodes, buffers, or reorders audio — it is a relay, so it adds no latency of its own
 * beyond a socket write.
 *
 * Wire protocol (all JSON control frames are text; audio is binary):
 *   producer -> bridge  {type:'start', streamId, mimeType, startedAt}   begin a stream
 *                       <binary>                                         one Audio Chunk
 *                       {type:'end', streamId}                           generation finished
 *                       {type:'abort', streamId}                         Stop / superseded
 *   bridge -> consumer  the producer's frames above, forwarded unchanged, plus
 *                       {type:'state', state, streamId}                  bridge state changes
 *   bridge -> any       {type:'hello', role, state, streamId}            right after connect
 *
 * Bridge state (BridgeSessionState) is exactly one of:
 *   DISCONNECTED — no producer connected
 *   IDLE         — a producer is connected, no stream in flight
 *   STREAMING    — between a producer's 'start' (or first chunk) and its 'end'/'abort'
 * Every transition goes through setState(), so the three can never overlap.
 *
 * Only one producer is active at a time: a newly connecting producer replaces (closes) the
 * previous one, which matches "the most recently opened SayWise tab is the one speaking".
 */

import { WebSocketServer } from 'ws';

export const BRIDGE_PATH = '/audio-bridge';

export const BridgeState = Object.freeze({
  DISCONNECTED: 'DISCONNECTED',
  IDLE: 'IDLE',
  STREAMING: 'STREAMING',
});

// Origins always allowed to consume (Teams Web, both enterprise and consumer flavours) —
// Phase 2's injector runs inside these pages.
const DEFAULT_CONSUMER_ORIGINS = ['https://teams.microsoft.com', 'https://teams.live.com'];

// A consumer that can't keep up is skipped for this chunk rather than letting its send
// queue grow without bound and stall the process — live audio has no use for stale bytes.
const MAX_CONSUMER_BUFFERED_BYTES = 4 * 1024 * 1024;

const HEARTBEAT_INTERVAL_MS = 30_000;

// Close code sent to a producer that a newer producer replaced; js/audio-bridge-client.js
// does not auto-reconnect on it, so two producers can't keep evicting each other.
export const REPLACED_CLOSE_CODE = 4000;

/**
 * Attaches the bridge to an existing http.Server's 'upgrade' event, handling only
 * requests for BRIDGE_PATH — every other upgrade request is left for other listeners (or
 * rejected if there are none), and plain HTTP traffic is never touched.
 *
 * @param {import('node:http').Server} httpServer
 * @param {object} [options]
 * @param {string[]} [options.allowedOrigins]  extra origins allowed for both roles; '*' allows any
 * @param {(msg: string) => void} [options.log]
 * @returns {{ getState(): string, getStats(): object, close(): Promise<void> }}
 */
export function attachAudioBridge(httpServer, options = {}) {
  const extraOrigins = options.allowedOrigins || [];
  const log = options.log || ((msg) => console.log(`[audio-bridge] ${msg}`));

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  let producer = null;
  const consumers = new Set();
  let state = BridgeState.DISCONNECTED;
  let streamId = null;
  const stats = { chunksForwarded: 0, bytesForwarded: 0, streams: 0 };

  function isOriginAllowed(origin, host, role) {
    // Non-browser clients (tests, CLI tools) send no Origin; they are already on this
    // machine since the server binds to loopback by default.
    if (!origin) return true;
    if (extraOrigins.includes('*') || extraOrigins.includes(origin)) return true;
    // Same-origin: the SayWise workspace and test page served by this very server.
    try {
      if (new URL(origin).host === host) return true;
    } catch {
      return false;
    }
    // Only consumers may come from Teams — an arbitrary page must never be able to act as
    // producer and push audio into someone's meeting microphone.
    return role === 'consumer' && DEFAULT_CONSUMER_ORIGINS.includes(origin);
  }

  function sendJson(ws, obj) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  function broadcast(data, isBinary) {
    for (const ws of consumers) {
      if (ws.readyState !== ws.OPEN) continue;
      if (ws.bufferedAmount > MAX_CONSUMER_BUFFERED_BYTES) continue;
      ws.send(data, { binary: isBinary });
    }
  }

  function setState(next, nextStreamId = null) {
    if (state === next && streamId === nextStreamId) return;
    state = next;
    streamId = nextStreamId;
    broadcast(JSON.stringify({ type: 'state', state, streamId }), false);
  }

  function handleProducerText(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return; // malformed control frame — ignore rather than drop the producer
    }
    if (msg.type === 'start') {
      // A 'start' while already STREAMING means the producer superseded its own previous
      // round without an explicit abort — tell consumers the old one is gone first.
      if (state === BridgeState.STREAMING) {
        broadcast(JSON.stringify({ type: 'abort', streamId }), false);
      }
      stats.streams++;
      setState(BridgeState.STREAMING, msg.streamId ?? null);
      broadcast(text, false);
    } else if (msg.type === 'end' || msg.type === 'abort') {
      if (state !== BridgeState.STREAMING) return;
      broadcast(text, false);
      setState(BridgeState.IDLE);
    }
  }

  function handleProducerBinary(data) {
    // A chunk with no preceding 'start' still counts as a stream — consumers just won't
    // have a startedAt to measure TTFA from.
    if (state !== BridgeState.STREAMING) {
      stats.streams++;
      setState(BridgeState.STREAMING);
    }
    stats.chunksForwarded++;
    stats.bytesForwarded += data.length;
    broadcast(data, true);
  }

  function attachProducer(ws) {
    if (producer) {
      log('new producer connected, replacing the previous one');
      const previous = producer;
      producer = null; // so its close handler doesn't flip state to DISCONNECTED
      previous.close(REPLACED_CLOSE_CODE, 'replaced by a newer producer');
    }
    producer = ws;
    // A replaced producer may have been mid-stream; its stream can't continue.
    if (state === BridgeState.STREAMING) {
      broadcast(JSON.stringify({ type: 'abort', streamId }), false);
    }
    setState(BridgeState.IDLE);

    ws.on('message', (data, isBinary) => {
      if (producer !== ws) return;
      if (isBinary) handleProducerBinary(data);
      else handleProducerText(data.toString());
    });
    ws.on('close', () => {
      if (producer !== ws) return;
      producer = null;
      if (state === BridgeState.STREAMING) {
        broadcast(JSON.stringify({ type: 'abort', streamId }), false);
      }
      setState(BridgeState.DISCONNECTED);
    });
  }

  function attachConsumer(ws) {
    consumers.add(ws);
    // Consumers are receive-only; anything they send is ignored.
    ws.on('close', () => consumers.delete(ws));
  }

  wss.on('connection', (ws, req, role) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('error', (err) => log(`${role} socket error: ${err.message}`));

    if (role === 'producer') attachProducer(ws);
    else attachConsumer(ws);

    sendJson(ws, { type: 'hello', role, state, streamId });
  });

  function onUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== BRIDGE_PATH) {
      // Not ours. Express has no WebSocket routes, so with no other upgrade listener this
      // request would otherwise hang forever.
      if (httpServer.listenerCount('upgrade') === 1) socket.destroy();
      return;
    }

    const role = url.searchParams.get('role');
    if (role !== 'producer' && role !== 'consumer') {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    if (!isOriginAllowed(req.headers.origin, req.headers.host, role)) {
      log(`rejected ${role} from origin ${req.headers.origin}`);
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, role));
  }

  httpServer.on('upgrade', onUpgrade);

  // Terminate peers that vanished without a close frame (sleeping laptop, killed tab), so
  // a dead producer doesn't keep the bridge pinned in IDLE/STREAMING.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  return {
    getState: () => state,
    getStats: () => ({ ...stats, state, streamId, producerConnected: !!producer, consumers: consumers.size }),
    close() {
      clearInterval(heartbeat);
      httpServer.off('upgrade', onUpgrade);
      for (const ws of wss.clients) ws.terminate();
      return new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}
