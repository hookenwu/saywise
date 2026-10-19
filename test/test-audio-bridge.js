/**
 * Audio Bridge tests — server/lib/audio-bridge.js + js/audio-bridge-client.js.
 *
 * Run: node test/test-audio-bridge.js   (exits non-zero on any failure)
 *
 * Uses the `ws` package already installed under server/node_modules (cd server && npm
 * install), resolved from there since the repo root has no node_modules of its own.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

import { attachAudioBridge, BridgeState, BRIDGE_PATH, REPLACED_CLOSE_CODE } from '../server/lib/audio-bridge.js';
import { AudioBridgeClient, BridgeClientState } from '../js/audio-bridge-client.js';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const WebSocket = require('ws');

// ---- helpers ---------------------------------------------------------------

async function startBridge(options = {}) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('plain http ok');
  });
  const bridge = attachAudioBridge(server, { log: () => {}, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    server,
    bridge,
    port,
    url: (role) => `ws://127.0.0.1:${port}${BRIDGE_PATH}?role=${role}`,
    async stop() {
      await bridge.close();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Opens a raw `ws` socket and records every frame it receives. */
function connect(url, headers = {}) {
  const ws = new WebSocket(url, { headers });
  const frames = []; // { binary: boolean, data: Buffer | object }
  const waiters = [];
  ws.on('message', (data, isBinary) => {
    frames.push(isBinary ? { binary: true, data } : { binary: false, data: JSON.parse(data.toString()) });
    for (const w of [...waiters]) w();
  });
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    ws.once('unexpected-response', (req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
  const closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)));

  /** Resolves once `predicate(frames)` is true; rejects after `timeoutMs`. */
  function waitFor(predicate, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (predicate(frames)) {
          waiters.splice(waiters.indexOf(check), 1);
          clearTimeout(timer);
          resolve(frames);
        }
      };
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(check), 1);
        reject(new Error(`timed out; frames so far: ${JSON.stringify(frames.map(describe))}`));
      }, timeoutMs);
      waiters.push(check);
      check();
    });
  }
  return { ws, frames, opened, closed, waitFor };
}

const describe = (f) => (f.binary ? `<${f.data.length} bytes>` : f.data);
const controls = (frames, type) => frames.filter((f) => !f.binary && f.data.type === type).map((f) => f.data);
const chunks = (frames) => frames.filter((f) => f.binary).map((f) => f.data);
const until = (fn, timeoutMs = 2000) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (fn()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('condition not met in time'));
      setTimeout(tick, 5);
    };
    tick();
  });

// ---- server bridge ---------------------------------------------------------

test('plain HTTP requests are unaffected by the attached bridge', async () => {
  const b = await startBridge();
  try {
    const body = await fetch(`http://127.0.0.1:${b.port}/anything`).then((r) => r.text());
    assert.equal(body, 'plain http ok');
  } finally {
    await b.stop();
  }
});

test('upgrade requests for other paths and invalid roles are rejected', async () => {
  const b = await startBridge();
  try {
    await assert.rejects(connect(`ws://127.0.0.1:${b.port}/not-the-bridge`).opened);
    await assert.rejects(connect(`ws://127.0.0.1:${b.port}${BRIDGE_PATH}`).opened, /HTTP 400/);
    await assert.rejects(connect(b.url('admin')).opened, /HTTP 400/);
  } finally {
    await b.stop();
  }
});

test('state machine: DISCONNECTED -> IDLE -> STREAMING -> IDLE -> DISCONNECTED', async () => {
  const b = await startBridge();
  try {
    assert.equal(b.bridge.getState(), BridgeState.DISCONNECTED);

    const consumer = connect(b.url('consumer'));
    await consumer.waitFor((f) => controls(f, 'hello').length === 1);
    assert.deepEqual(controls(consumer.frames, 'hello')[0], {
      type: 'hello',
      role: 'consumer',
      state: 'DISCONNECTED',
      streamId: null,
    });

    const producer = connect(b.url('producer'));
    await producer.opened;
    await consumer.waitFor((f) => controls(f, 'state').some((s) => s.state === 'IDLE'));
    assert.equal(b.bridge.getState(), BridgeState.IDLE);

    producer.ws.send(JSON.stringify({ type: 'start', streamId: 's1', mimeType: 'audio/mpeg', startedAt: 1 }));
    await consumer.waitFor((f) => controls(f, 'state').some((s) => s.state === 'STREAMING'));
    assert.equal(b.bridge.getState(), BridgeState.STREAMING);

    producer.ws.send(JSON.stringify({ type: 'end', streamId: 's1' }));
    await consumer.waitFor((f) => controls(f, 'state').filter((s) => s.state === 'IDLE').length === 2);
    assert.equal(b.bridge.getState(), BridgeState.IDLE);

    producer.ws.close();
    await consumer.waitFor((f) => controls(f, 'state').some((s) => s.state === 'DISCONNECTED'));
    assert.equal(b.bridge.getState(), BridgeState.DISCONNECTED);

    // Every reported state is one of the three, never anything in between.
    const seen = controls(consumer.frames, 'state').map((s) => s.state);
    assert.deepEqual(seen, ['IDLE', 'STREAMING', 'IDLE', 'DISCONNECTED']);
    consumer.ws.close();
  } finally {
    await b.stop();
  }
});

test('binary chunks are forwarded byte-exact and in order to multiple consumers', async () => {
  const b = await startBridge();
  try {
    const consumers = [connect(b.url('consumer')), connect(b.url('consumer')), connect(b.url('consumer'))];
    await Promise.all(consumers.map((c) => c.opened));
    const producer = connect(b.url('producer'));
    await producer.opened;
    await until(() => b.bridge.getStats().consumers === 3 && b.bridge.getState() === BridgeState.IDLE);

    const sent = [];
    for (let i = 0; i < 50; i++) {
      const chunk = Buffer.alloc(100 + i * 37);
      for (let j = 0; j < chunk.length; j++) chunk[j] = (i * 31 + j) & 0xff;
      sent.push(chunk);
    }

    producer.ws.send(JSON.stringify({ type: 'start', streamId: 'multi', mimeType: 'audio/mpeg', startedAt: 123 }));
    for (const chunk of sent) producer.ws.send(chunk);
    producer.ws.send(JSON.stringify({ type: 'end', streamId: 'multi' }));

    for (const c of consumers) {
      await c.waitFor((f) => controls(f, 'end').length === 1);
      const received = chunks(c.frames);
      assert.equal(received.length, sent.length);
      received.forEach((chunk, i) => assert.ok(chunk.equals(sent[i]), `chunk ${i} differs`));
      assert.deepEqual(controls(c.frames, 'start')[0], {
        type: 'start',
        streamId: 'multi',
        mimeType: 'audio/mpeg',
        startedAt: 123,
      });
      // start precedes every chunk, end follows every chunk
      const startIdx = c.frames.findIndex((f) => !f.binary && f.data.type === 'start');
      const endIdx = c.frames.findIndex((f) => !f.binary && f.data.type === 'end');
      const chunkIdx = c.frames.map((f, i) => (f.binary ? i : -1)).filter((i) => i >= 0);
      assert.ok(startIdx < chunkIdx[0] && endIdx > chunkIdx.at(-1));
    }

    const stats = b.bridge.getStats();
    assert.equal(stats.chunksForwarded, 50);
    assert.equal(stats.bytesForwarded, sent.reduce((n, c) => n + c.length, 0));
    assert.equal(stats.streams, 1);

    // Producers never receive their own audio back; consumers can't inject audio.
    assert.equal(chunks(producer.frames).length, 0);
    consumers[0].ws.send(Buffer.from([1, 2, 3]));
    producer.ws.send(Buffer.from([9]));
    await consumers[1].waitFor((f) => chunks(f).length === 51);
    assert.ok(chunks(consumers[1].frames).at(-1).equals(Buffer.from([9])));

    for (const c of [...consumers, producer]) c.ws.close();
  } finally {
    await b.stop();
  }
});

test('a chunk without a preceding start still streams (implicit STREAMING)', async () => {
  const b = await startBridge();
  try {
    const consumer = connect(b.url('consumer'));
    const producer = connect(b.url('producer'));
    await Promise.all([consumer.opened, producer.opened]);
    await until(() => b.bridge.getStats().consumers === 1);
    producer.ws.send(Buffer.from([0xff, 0xf3]));
    await consumer.waitFor((f) => chunks(f).length === 1);
    assert.equal(b.bridge.getState(), BridgeState.STREAMING);
    consumer.ws.close();
    producer.ws.close();
  } finally {
    await b.stop();
  }
});

test('producer dropping mid-stream aborts the stream for consumers', async () => {
  const b = await startBridge();
  try {
    const consumer = connect(b.url('consumer'));
    const producer = connect(b.url('producer'));
    await Promise.all([consumer.opened, producer.opened]);
    producer.ws.send(JSON.stringify({ type: 'start', streamId: 'x' }));
    producer.ws.send(Buffer.from([1]));
    await consumer.waitFor((f) => chunks(f).length === 1);
    producer.ws.terminate();
    await consumer.waitFor((f) => controls(f, 'abort').length === 1);
    await consumer.waitFor((f) => controls(f, 'state').some((s) => s.state === 'DISCONNECTED'));
    assert.deepEqual(controls(consumer.frames, 'abort')[0], { type: 'abort', streamId: 'x' });
    consumer.ws.close();
  } finally {
    await b.stop();
  }
});

test('a new producer replaces the previous one', async () => {
  const b = await startBridge();
  try {
    const consumer = connect(b.url('consumer'));
    const first = connect(b.url('producer'));
    await Promise.all([consumer.opened, first.opened]);
    first.ws.send(JSON.stringify({ type: 'start', streamId: 'old' }));
    await until(() => b.bridge.getState() === BridgeState.STREAMING);

    const second = connect(b.url('producer'));
    await second.opened;
    assert.equal(await first.closed, REPLACED_CLOSE_CODE);
    await consumer.waitFor((f) => controls(f, 'abort').some((a) => a.streamId === 'old'));
    assert.equal(b.bridge.getState(), BridgeState.IDLE);

    // The replaced producer's close must not flip the bridge to DISCONNECTED.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(b.bridge.getState(), BridgeState.IDLE);
    assert.equal(b.bridge.getStats().producerConnected, true);

    second.ws.send(Buffer.from([7, 7]));
    await consumer.waitFor((f) => chunks(f).length === 1);
    consumer.ws.close();
    second.ws.close();
  } finally {
    await b.stop();
  }
});

test('origin policy: same-origin and Teams consumers allowed, foreign producers rejected', async () => {
  const b = await startBridge({ allowedOrigins: ['http://localhost:3000'] });
  try {
    const host = `127.0.0.1:${b.port}`;
    await connect(b.url('producer'), { origin: `http://${host}` }).opened;
    await connect(b.url('producer'), { origin: 'http://localhost:3000' }).opened;
    await connect(b.url('consumer'), { origin: 'https://teams.microsoft.com' }).opened;
    await assert.rejects(connect(b.url('producer'), { origin: 'https://teams.microsoft.com' }).opened, /HTTP 403/);
    await assert.rejects(connect(b.url('producer'), { origin: 'https://evil.example' }).opened, /HTTP 403/);
    await assert.rejects(connect(b.url('consumer'), { origin: 'https://evil.example' }).opened, /HTTP 403/);
  } finally {
    await b.stop();
  }
});

test('cleanup: closed consumers are dropped and close() terminates everyone', async () => {
  const b = await startBridge();
  const consumers = [connect(b.url('consumer')), connect(b.url('consumer'))];
  const producer = connect(b.url('producer'));
  await Promise.all([...consumers, producer].map((c) => c.opened));
  await until(() => b.bridge.getStats().consumers === 2);

  consumers[0].ws.close();
  await until(() => b.bridge.getStats().consumers === 1);

  await b.stop();
  await Promise.all([consumers[1].closed, producer.closed]);
  assert.equal(b.server.listenerCount('upgrade'), 0);
});

// ---- browser client (js/audio-bridge-client.js) ----------------------------

test('AudioBridgeClient producer -> consumer end to end', async () => {
  const b = await startBridge();
  const producerStates = [];
  const consumerStates = [];
  const received = [];
  const messages = [];
  const producer = new AudioBridgeClient({
    role: 'producer',
    url: b.url('producer'),
    WebSocketImpl: WebSocket,
    onStateChange: (s) => producerStates.push(s),
  });
  const consumer = new AudioBridgeClient({
    role: 'consumer',
    url: b.url('consumer'),
    WebSocketImpl: WebSocket,
    onStateChange: (s) => consumerStates.push(s),
    onChunk: (bytes) => received.push(bytes),
    onMessage: (msg) => messages.push(msg),
  });
  try {
    // Before connecting, producer calls are silent no-ops (toggle-off behaviour).
    producer.beginStream();
    producer.sendChunk(new Uint8Array([1]));
    producer.endStream();
    assert.equal(producer.state, BridgeClientState.DISCONNECTED);

    consumer.connect();
    producer.connect();
    await until(() => producer.state === 'IDLE' && consumer.state === 'IDLE' && b.bridge.getStats().consumers === 1);

    producer.beginStream({ startedAt: 42 });
    assert.equal(producer.state, BridgeClientState.STREAMING);
    producer.sendChunk(new Uint8Array([1, 2, 3]));
    producer.sendChunk(new Uint8Array([4, 5]));
    producer.endStream();
    assert.equal(producer.state, BridgeClientState.IDLE);

    await until(() => messages.some((m) => m.type === 'end'));
    assert.deepEqual(received.map((u) => [...u]), [[1, 2, 3], [4, 5]]);
    assert.ok(received.every((u) => u instanceof Uint8Array));
    assert.equal(messages.find((m) => m.type === 'start').startedAt, 42);
    assert.equal(consumer.state, BridgeClientState.IDLE);
    assert.deepEqual(consumerStates, ['CONNECTING', 'IDLE', 'STREAMING', 'IDLE']);
    assert.deepEqual(producerStates, ['CONNECTING', 'IDLE', 'STREAMING', 'IDLE']);

    // abortStream ends the consumer's stream too.
    producer.beginStream();
    producer.abortStream();
    await until(() => messages.some((m) => m.type === 'abort'));
    assert.equal(consumer.state, BridgeClientState.IDLE);

    producer.disconnect();
    assert.equal(producer.state, BridgeClientState.DISCONNECTED);
    await until(() => b.bridge.getState() === BridgeState.DISCONNECTED);
  } finally {
    producer.disconnect();
    consumer.disconnect();
    await b.stop();
  }
});

test('a replaced AudioBridgeClient producer does not reconnect and evict its replacement', async () => {
  const b = await startBridge();
  const first = new AudioBridgeClient({ role: 'producer', url: b.url('producer'), WebSocketImpl: WebSocket });
  const second = new AudioBridgeClient({ role: 'producer', url: b.url('producer'), WebSocketImpl: WebSocket });
  try {
    first.connect();
    await until(() => first.state === BridgeClientState.IDLE);
    second.connect();
    await until(() => second.state === BridgeClientState.IDLE && first.state === BridgeClientState.DISCONNECTED);
    await new Promise((r) => setTimeout(r, 1200)); // > RECONNECT_MIN_MS
    assert.equal(first.state, BridgeClientState.DISCONNECTED);
    assert.equal(second.state, BridgeClientState.IDLE);
  } finally {
    first.disconnect();
    second.disconnect();
    await b.stop();
  }
});

test('AudioBridgeClient reconnects after the bridge restarts', async () => {
  const b1 = await startBridge();
  const port = b1.port;
  const client = new AudioBridgeClient({ role: 'consumer', url: b1.url('consumer'), WebSocketImpl: WebSocket });
  let b2;
  try {
    client.connect();
    await until(() => client.state === BridgeClientState.IDLE);
    await b1.stop();
    await until(() => client.state !== BridgeClientState.IDLE);

    const server = http.createServer();
    const bridge = attachAudioBridge(server, { log: () => {} });
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    b2 = {
      async stop() {
        await bridge.close();
        await new Promise((resolve) => server.close(resolve));
      },
    };
    await until(() => client.state === BridgeClientState.IDLE, 5000);
  } finally {
    client.disconnect();
    await b2?.stop();
  }
});
