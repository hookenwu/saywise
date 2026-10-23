/**
 * Humanize gateway tests — server/lib/humanize-backend.js and the rewrite routing in
 * server/lib/translate.js (specs/voice-copilot-humanize-gateway/plan.md §4.1).
 *
 * Run: node test/test-humanize-gateway.js   (local mock OpenAI-compatible server; no real network)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const { humanizeBackend, streamChatCompletions } = await import('../server/lib/humanize-backend.js');
const T = await import('../server/lib/translate.js');

/** Mock /v1/chat/completions. `script(req, body, res, n)` writes the response; n = call count. */
async function mockGateway(script) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      calls.push({ url: req.url, headers: req.headers, body });
      script(req, body, res, calls.length);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  return { baseUrl, calls, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

const sse = (res, events) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of events) res.write(typeof e === 'string' ? e : `data: ${JSON.stringify(e)}\n\n`);
  res.end('data: [DONE]\n\n');
};
const delta = (d) => ({ model: 'gemini-3.8-flash-tiered', choices: [{ index: 0, delta: d }] });

async function collect(gen) {
  let out = '';
  for await (const { content } of gen) out += content;
  return out;
}

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  return Promise.resolve(fn()).finally(() => {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });
}

test('humanizeBackend: unset base URL = rollback (null); defaults model and reasoning effort', () => {
  assert.equal(humanizeBackend({}), null);
  assert.equal(humanizeBackend({ HUMANIZE_LLM_BASE_URL: '  ' }), null);
  assert.deepEqual(humanizeBackend({ HUMANIZE_LLM_BASE_URL: 'http://127.0.0.1:8045/v1/', HUMANIZE_LLM_API_KEY: 'k' }), {
    baseUrl: 'http://127.0.0.1:8045/v1', apiKey: 'k', model: 'gemini-3.8-flash', reasoningEffort: 'none',
  });
});

test('streamChatCompletions: request shape; relays content, drops reasoning_content and pings', async () => {
  const gw = await mockGateway((req, body, res) =>
    sse(res, [delta({ role: 'assistant', content: null, reasoning_content: 'thinking...' }), ': ping\n\n', delta({ content: '嗯，' }), delta({ content: '好的。' })]));
  try {
    const out = await collect(streamChatCompletions({ baseUrl: gw.baseUrl, apiKey: 'secret', model: 'gemini-3.8-flash', reasoningEffort: 'none', systemInstruction: 'SYS', text: '好的。' }));
    assert.equal(out, '嗯，好的。');
    const { url, headers, body } = gw.calls[0];
    assert.equal(url, '/v1/chat/completions');
    assert.equal(headers.authorization, 'Bearer secret');
    assert.deepEqual(body, {
      model: 'gemini-3.8-flash', stream: true, reasoning_effort: 'none',
      messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: '好的。' }],
    });
  } finally { await gw.close(); }
});

test('streamChatCompletions: HTTP error carries status', async () => {
  const gw = await mockGateway((req, body, res) => { res.writeHead(429); res.end('busy'); });
  try {
    await assert.rejects(collect(streamChatCompletions({ baseUrl: gw.baseUrl, model: 'm', systemInstruction: 's', text: 't' })), (e) => e.status === 429);
  } finally { await gw.close(); }
});

test('streamTranslate rewrite → gateway with the same system instruction; translate never touches it', async () => {
  const gw = await mockGateway((req, body, res) => sse(res, [delta({ content: 'Yeah, sure.' })]));
  try {
    await withEnv({ HUMANIZE_LLM_BASE_URL: gw.baseUrl, HUMANIZE_LLM_API_KEY: 'k' }, async () => {
      const text = 'Sure.';
      const out = await collect(T.streamTranslate(text, { delivery: 'natural', mode: 'rewrite', stylePreset: 'natural' }));
      assert.equal(out, 'Yeah, sure.');
      assert.equal(gw.calls[0].body.messages[0].content, T.buildSystemInstruction({ stylePreset: 'natural', delivery: 'natural', mode: 'rewrite', inputText: text }));
      assert.equal(T.needsGeminiCredential('rewrite'), false);
      assert.equal(T.needsGeminiCredential('translate'), true);
      // translate mode goes to Gemini (no key here → fails), not to the gateway
      await assert.rejects(collect(T.streamTranslate('你好', { delivery: 'natural', mode: 'translate' })));
      assert.equal(gw.calls.length, 1);
    });
  } finally { await gw.close(); }
});

test('streamTranslate: retries a transient gateway error once before any content', async () => {
  const gw = await mockGateway((req, body, res, n) => (n === 1 ? (res.writeHead(503), res.end()) : sse(res, [delta({ content: 'ok' })])));
  try {
    await withEnv({ HUMANIZE_LLM_BASE_URL: gw.baseUrl }, async () => {
      assert.equal(await collect(T.streamTranslate('ok', { mode: 'rewrite' })), 'ok');
      assert.equal(gw.calls.length, 2);
    });
  } finally { await gw.close(); }
});

test('streamTranslate: abort cancels the gateway request', async () => {
  const gw = await mockGateway((req, body, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(`data: ${JSON.stringify(delta({ content: 'a' }))}\n\n`); /* never ends */ });
  try {
    await withEnv({ HUMANIZE_LLM_BASE_URL: gw.baseUrl }, async () => {
      const ac = new AbortController();
      const gen = T.streamTranslate('a', { mode: 'rewrite', signal: ac.signal });
      assert.equal((await gen.next()).value.content, 'a');
      ac.abort();
      await assert.rejects(gen.next(), (e) => e.name === 'AbortError');
    });
  } finally { await gw.close(); }
});

test('gateway unset: rewrite needs the Gemini credential again (rollback)', async () => {
  await withEnv({ HUMANIZE_LLM_BASE_URL: undefined }, () => {
    assert.equal(T.needsGeminiCredential('rewrite'), true);
  });
});
