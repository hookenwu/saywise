/**
 * Humanize Fidelity Gate tests — server/lib/fidelity-gate.js and its wiring in
 * server/lib/translate.js (specs/voice-copilot-humanize-fidelity-gate/plan.md §3).
 *
 * Run: node test/test-fidelity-gate.js   (no network: real recorded rewrites + a local mock gateway)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';

const { gateRewrite, findMismatches } = await import('../server/lib/fidelity-gate.js');
const T = await import('../server/lib/translate.js');
const { cases } = JSON.parse(fs.readFileSync(new URL('./fixtures/humanize-fidelity-cases.json', import.meta.url), 'utf8'));

// ------------------------------------------------ recorded real rewrites (hand-labelled)

test('recorded rewrites: no unsafe rewrite is spoken unchanged', () => {
  const missed = cases.filter((c) => c.label === 'unsafe' && gateRewrite(c.source, c.output, c.lang).verdict === 'pass');
  assert.deepEqual(missed.map((c) => `${c.id}: ${c.note}`), []);
});

test('recorded rewrites: whatever is spoken is meaning-equivalent to the source', () => {
  for (const c of cases) {
    const { verdict, text } = gateRewrite(c.source, c.output, c.lang);
    if (verdict === 'fallback') assert.equal(text, c.source, c.id);
    else assert.deepEqual(findMismatches(c.source, text, c.lang), [], c.id);
  }
});

test('recorded rewrites: false fallbacks on safe rewrites stay at the measured level (≤ 2 of 49)', () => {
  const safe = cases.filter((c) => c.label === 'safe');
  const fp = safe.filter((c) => gateRewrite(c.source, c.output, c.lang).verdict !== 'pass').map((c) => c.id);
  assert.ok(safe.length >= 49);
  assert.ok(fp.length <= 2, `false positives: ${fp.join(', ')}`);
});

// ------------------------------------------------ targeted cases: must fall back / repair / pass

const zh = (s, o) => gateRewrite(s, o, 'zh');
const en = (s, o) => gateRewrite(s, o, 'en');

test('zh facts: numbers, units, dates, weekdays, terms', () => {
  assert.equal(zh('退款 1,280.50 元，周三到账。', '退款 1,280 元，周三到账。').verdict, 'fallback');
  assert.equal(zh('延迟是 350 毫秒。', '延迟是 350 秒。').verdict, 'fallback');
  assert.equal(zh('首付 30%。', '首付 40%。').verdict, 'fallback');
  assert.equal(zh('周三下午三点前到账。', '周四下午三点前到账。').verdict, 'fallback');
  assert.equal(zh('明天下午三点前回复你。', '明天三点前回复你。').verdict, 'fallback');
  assert.equal(zh('状态是 PENDING。', '状态是 FAILED。').verdict, 'fallback');
  assert.equal(zh('合同金额是 48 万。', '合同金额是 4.8 万。').verdict, 'fallback');
});

test('zh facts: equivalent spellings pass', () => {
  assert.equal(zh('响应时间从两秒降到了两百毫秒。', '嗯，响应时间从 2 秒降到了 200 毫秒。').verdict, 'pass');
  assert.equal(zh('截止日期是20号还是27号？', '截止日期是二十号，还是二十七号啊？').verdict, 'pass');
  assert.equal(zh('QPS 峰值在 2 万左右。', 'QPS 峰值呢，大概在两万。').verdict, 'pass');
  assert.equal(zh('今天晚上 10 点发版。', '今晚 10 点发版哈。').verdict, 'pass');
  assert.equal(zh('先上线一个简化版本。', '先上线个简化版吧。').verdict, 'pass');
});

test('zh negation: flips fall back, lexicalised forms and A-not-A questions pass', () => {
  assert.equal(zh('所以先不要重试。', '所以先重试吧。').verdict, 'fallback');
  assert.equal(zh('不是 FAILED。', '是 FAILED。').verdict, 'fallback');
  assert.equal(zh('他会来。', '他不一定会来。').verdict, 'fallback');
  assert.equal(zh('能再说一遍吗？', '不好意思，能不能再说一遍？').verdict, 'pass');
  assert.equal(zh('先不要重试。', '先别急着重试。').verdict, 'pass');
  assert.equal(zh('整体没问题，但是成本要再算。', '整体没啥问题，不过成本得再算算。').verdict, 'pass');
});

test('zh certainty, commitment, intent, timing', () => {
  assert.equal(zh('测试可能来不及。', '测试来不及了。').verdict, 'fallback');
  assert.equal(zh('测试可能来不及。', '测试恐怕来不及。').verdict, 'fallback');
  assert.equal(zh('我们承诺月底前上线。', '我们保证月底前上线。').verdict, 'fallback');
  assert.equal(zh('今晚 10 点发版。', '我们打算今晚 10 点发版。').verdict, 'fallback');
  assert.equal(zh('发布就得往后推了。', '发布只能往后推了。').verdict, 'fallback');
  assert.equal(zh('我觉得可以先上线。', '可以先上线。').verdict, 'fallback');
  assert.equal(zh('我好像没听到最后一部分。', '我没听清最后那部分。').verdict, 'fallback');
});

test('zh decision state: dropping/adding a decisive verb falls back; tentative 看看 alone does not', () => {
  assert.equal(zh('收集一下用户反馈，再决定要不要做完整的功能。', '收集一下用户的反馈，然后再看看要不要做完整的功能。').verdict, 'fallback');
  assert.equal(zh('再决定要不要做。', '再考虑要不要做。').verdict, 'fallback');
  assert.equal(zh('我们再看看要不要做。', '我们再决定要不要做。').verdict, 'fallback');
  assert.equal(zh('客户已经同意了这个方案。', '客户还在考虑这个方案。').verdict, 'fallback');
  assert.equal(zh('我回头确认一下。', '我回头看一下。').verdict, 'fallback');
  assert.equal(zh('方案下周敲定。', '方案下周定。').verdict, 'fallback');
  assert.equal(zh('收集一下用户反馈，再决定要不要做。', '先看看用户的反馈怎么样，再决定要不要做。').verdict, 'pass');
  assert.equal(zh('我回头确认一下。', '那个，我回头去确认一下。').verdict, 'pass');
  assert.equal(zh('方案下周敲定。', '方案呢，下周就能定下来。').verdict, 'pass');
});

test('zh conditions, qualifiers and before/after', () => {
  assert.equal(zh('剩下的验收后一次付清。', '剩下的等验收合格之后一次付清。').verdict, 'fallback');
  assert.equal(zh('剩下的验收后一次付清。', '剩下的验收前一次付清。').verdict, 'fallback');
  assert.equal(zh('如果延期，我会通知你。', '万一延期了，我会通知你。').verdict, 'fallback');
  assert.equal(zh('如果延期，我会通知你。', '延期了我会通知你。').verdict, 'fallback');
  assert.equal(zh('剩下的验收后一次付清。', '剩下的呢，等验收之后一次付清。').verdict, 'pass');
  assert.equal(zh('如果延期，我会通知你。', '要是延期的话，我会通知你。').verdict, 'pass');
  assert.equal(zh('主要是数据库没加索引。', '嗯，主要是数据库查询没加索引。').verdict, 'pass');
});

test('zh subjects: who acts/commits must not change; pro-drop is fine', () => {
  assert.equal(zh('我会第一时间通知你。', '你会第一时间通知我。').verdict, 'fallback');
  assert.equal(zh('这个 bug 已经修复了。', '我们已经把这个 bug 修复了。').verdict, 'fallback');
  assert.equal(zh('我觉得我们可以先上线。', '我觉得可以先上线。').verdict, 'pass');
  assert.equal(zh('我觉得我们可以先上线。', '我觉得咱们可以先上线。').verdict, 'pass');
  assert.equal(zh('其他同事已经确认了。', '其他同事呢，已经确认了。').verdict, 'pass');
});

test('zh aspect: added 刚才 about a past action falls back; deictic 刚才 (没听清/说) passes', () => {
  assert.equal(zh('这个方案我看了一下。', '这个方案我刚才看了一下。').verdict, 'fallback');
  assert.equal(zh('我没听清最后那部分。', '我刚才没听清最后那部分。').verdict, 'pass');
  assert.equal(zh('接口改完了。', '接口已经改完了。').verdict, 'fallback');
});

test('zh repair: only added pure adverbs are deleted, and the rest of the spoken style survives', () => {
  const r = zh('订单状态现在是 PENDING，所以先不要重试。', '嗯，订单状态现在其实是 PENDING，所以呢，先别急着重试。');
  assert.equal(r.verdict, 'repaired');
  assert.equal(r.text, '嗯，订单状态现在是 PENDING，所以呢，先别急着重试。');
  assert.equal(zh('我有点担心时间。', '其实，我有点担心时间。').text, '我有点担心时间。');
  assert.equal(zh('发布得往后推。', '发布估计得往后推。').text, '发布得往后推。');
  // not an adverb here → no deletion → fall back
  assert.equal(zh('这个数是 350。', '这个估计值是 350。').verdict, 'fallback');
  // a deletable word plus an unrepairable change → fall back, never a half-repair
  assert.equal(zh('我们承诺月底前上线。', '其实我们保证月底前上线。').verdict, 'fallback');
});

test('fallback: empty output speaks the original', () => {
  assert.deepEqual(zh('好的。', '  '), { verdict: 'fallback', text: '好的。', reasons: ['empty'] });
});

test('en: facts, negation, certainty, commitment, subjects', () => {
  assert.equal(en('We dropped from two seconds to two hundred milliseconds.', 'So, um, we dropped from 2 seconds to 200 milliseconds.').verdict, 'pass');
  assert.equal(en('Did you say the twentieth or the twenty-seventh?', 'Did you say the 20th... or the 27th?').verdict, 'pass');
  assert.equal(en('We finished the API changes last Friday.', 'We finished the API changes last Monday.').verdict, 'fallback');
  assert.equal(en("QA won't have enough time.", 'QA will have enough time.').verdict, 'fallback');
  assert.equal(en('We might have to push the release.', 'We have to push the release.').verdict, 'fallback');
  assert.equal(en('I promise it ships on Friday.', 'I guarantee it ships on Friday.').verdict, 'fallback');
  assert.equal(en('We have about 20 users.', 'We have 20 users.').verdict, 'fallback');
  assert.equal(en("I'll send it to you tonight.", "You'll get it from me tonight.").verdict, 'fallback');
  assert.equal(en('Let me check and get back to you.', "Yeah, I'll check and, you know, get back to you.").verdict, 'pass');
  assert.equal(en("We'll decide after the review.", "We'll see after the review.").verdict, 'fallback');
  assert.equal(en('The client approved the budget.', 'The client is looking at the budget.').verdict, 'fallback');
  assert.equal(en("Let me confirm with the backend team.", "Let me, um, confirm with the backend team.").verdict, 'pass');
  const r = en("I'm a bit worried about the timeline.", "I'm actually a bit worried about the timeline.");
  assert.deepEqual([r.verdict, r.text], ['repaired', "I'm a bit worried about the timeline."]);
});

// ------------------------------------------------ wiring in streamTranslate

async function mockGateway(text, { hang = false } = {}) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const piece of text.match(/.{1,3}/gsu) || []) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
      if (!hang) res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

async function collect(gen) {
  const chunks = [];
  for await (const { content } of gen) chunks.push(content);
  return chunks;
}

test('streamTranslate rewrite + gate on: one chunk with the gated text', async () => {
  const gw = await mockGateway('嗯，订单状态现在其实是 PENDING，先别急着重试。');
  try {
    await withEnv({ HUMANIZE_LLM_BASE_URL: gw.url, HUMANIZE_FIDELITY_GATE: 'on' }, async () => {
      const chunks = await collect(T.streamTranslate('订单状态现在是 PENDING，先不要重试。', { mode: 'rewrite', delivery: 'natural' }));
      assert.deepEqual(chunks, ['嗯，订单状态现在是 PENDING，先别急着重试。']);
    });
  } finally { await gw.close(); }
});

test('streamTranslate rewrite + gate on: unsafe rewrite → the original, verbatim', async () => {
  const gw = await mockGateway('我们保证月底前上线。');
  try {
    await withEnv({ HUMANIZE_LLM_BASE_URL: gw.url }, async () => {
      assert.deepEqual(await collect(T.streamTranslate('我们承诺月底前上线。', { mode: 'rewrite' })), ['我们承诺月底前上线。']);
    });
  } finally { await gw.close(); }
});

test('streamTranslate rewrite + HUMANIZE_FIDELITY_GATE=off: streams the raw rewrite as before', async () => {
  const gw = await mockGateway('我们保证月底前上线。');
  try {
    await withEnv({ HUMANIZE_LLM_BASE_URL: gw.url, HUMANIZE_FIDELITY_GATE: 'off' }, async () => {
      const chunks = await collect(T.streamTranslate('我们承诺月底前上线。', { mode: 'rewrite' }));
      assert.ok(chunks.length > 1);
      assert.equal(chunks.join(''), '我们保证月底前上线。');
    });
  } finally { await gw.close(); }
});

test('streamTranslate rewrite + gate on: abort while buffering rejects and stops the upstream', async () => {
  const gw = await mockGateway('还在生成', { hang: true });
  try {
    await withEnv({ HUMANIZE_LLM_BASE_URL: gw.url }, async () => {
      const ac = new AbortController();
      const pending = T.streamTranslate('好的。', { mode: 'rewrite', signal: ac.signal }).next();
      setTimeout(() => ac.abort(), 50);
      await assert.rejects(pending, (e) => e.name === 'AbortError');
    });
  } finally { await gw.close(); }
});

test('fidelityGateEnabled: on by default, off only when set to off', () => {
  assert.equal(T.fidelityGateEnabled({}), true);
  assert.equal(T.fidelityGateEnabled({ HUMANIZE_FIDELITY_GATE: 'OFF' }), false);
  assert.equal(T.fidelityGateEnabled({ HUMANIZE_FIDELITY_GATE: 'on' }), true);
});
