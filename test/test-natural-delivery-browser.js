/**
 * Natural Delivery browser smoke test — real page served by server/index.js in headless
 * Chrome (puppeteer-core from server/node_modules).
 *
 * Run: node test/test-natural-delivery-browser.js
 * Checks the Delivery / Humanize controls (render, hidden rules, persistence) without any
 * credentials. If config/voice-config.local.js and GEMINI_API_KEY are available it also runs
 * real Speak rounds — Direct (Natural), Direct (Off) and Humanize — and asserts each one
 * reaches real audio playback with the expected wire behaviour.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const puppeteer = require('puppeteer-core');
const repo = new URL('../', import.meta.url).pathname;
const PORT = 4197;
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = ['/opt/google/chrome/google-chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
const hasTtsCredentials = fs.existsSync(`${repo}config/voice-config.local.js`);

let server, browser;

test.before(async () => {
  server = spawn(process.execPath, ['index.js'], {
    cwd: `${repo}server`,
    env: { ...process.env, VOICE_COPILOT_SERVER_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--disable-gpu', '--mute-audio'],
  });
});

test.after(async () => {
  await browser?.close();
  server?.kill();
});

async function openPage() {
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  const translateBodies = [];
  page.on('request', (r) => { if (r.url().endsWith('/api/translate-stream')) translateBodies.push(JSON.parse(r.postData())); });
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  return { page, logs, translateBodies };
}

const visible = (page, sel) => page.$eval(sel, (el) => !el.closest('[hidden]') && getComputedStyle(el).display !== 'none');

test('Delivery and Humanize controls render, hide correctly and persist', async () => {
  const { page } = await openPage();
  assert.equal(await page.$eval('#delivery-select', (el) => el.value), 'natural', 'default Delivery is Natural');
  assert.equal(await page.$eval('#humanize-toggle', (el) => el.checked), false, 'Humanize is opt-in');
  assert.equal(await visible(page, '#humanize-toggle'), true);
  // Speaking Style is translate-only; before the [hidden] CSS fix it was always visible.
  assert.equal(await visible(page, '#style-preset-select'), false);

  await page.select('#delivery-select', 'off');
  assert.equal(await page.$eval('#humanize-toggle', (el) => el.disabled), true, 'Humanize needs Delivery on');
  await page.select('#delivery-select', 'light');
  await page.click('#humanize-toggle');
  await page.reload({ waitUntil: 'networkidle0' });
  assert.equal(await page.$eval('#delivery-select', (el) => el.value), 'light', 'Delivery persisted');
  assert.equal(await page.$eval('#humanize-toggle', (el) => el.checked), true, 'Humanize persisted');
  await page.evaluate(() => localStorage.clear());
  await page.close();
});

async function speakRound(page, logs, text) {
  logs.length = 0;
  await page.$eval('#speech-text', (el, t) => { el.value = t; el.dispatchEvent(new Event('input')); }, text);
  await page.waitForFunction(() => !document.querySelector('#speak-btn').disabled, { timeout: 15000 });
  await page.click('#speak-btn');
  await page.waitForFunction(() => document.querySelector('#status-text').textContent === 'Playing', { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#replay-btn').disabled === false, { timeout: 60000 });
  const out = logs.join('\n');
  console.log(`    ${(out.match(/delivery= \w+/) || ['?'])[0]} ${(out.match(/\[TTFA\] \d+ms/) || ['?'])[0]}`);
  return out;
}

test('real Speak rounds: Direct Natural, Direct Off, Humanize', { skip: !hasTtsCredentials && 'no config/voice-config.local.js' }, async () => {
  const { page, logs, translateBodies } = await openPage();
  await page.evaluate(() => { localStorage.clear(); });
  await page.reload({ waitUntil: 'networkidle0' });

  let out = await speakRound(page, logs, 'Okay, that makes sense. Let me check with the backend team.');
  assert.match(out, /delivery= natural model= \(default\)/);
  assert.match(out, /\[TTFA\] \d+ms/);
  assert.equal(translateBodies.length, 0, 'Direct Speak with Humanize off never calls the LLM');

  await page.select('#delivery-select', 'off');
  out = await speakRound(page, logs, 'Okay, that makes sense. Let me check with the backend team.');
  assert.match(out, /delivery= off model= seed-tts-2.0-expressive/);

  const translationAvailable = await page.$eval('#translation-toggle', (el) => !el.disabled);
  if (translationAvailable) {
    await page.select('#delivery-select', 'natural');
    await page.click('#humanize-toggle');
    out = await speakRound(page, logs, 'I see your point. But I am a bit worried about the timeline.');
    out = await speakRound(page, logs, 'Sorry, could you repeat that? I think I missed the last part.');
    assert.equal(translateBodies.at(-1).mode, 'rewrite');
    assert.equal(translateBodies.at(-1).delivery, 'natural');
    assert.equal(await page.$eval('#translated-text-label', (el) => el.textContent), 'Spoken Text');
    const spoken = await page.$eval('#translated-text-display', (el) => el.textContent);
    assert.ok(spoken.length > 10, `rewrite shown: ${spoken}`);
    console.log(`    humanized: ${spoken}`);
  }
  await page.evaluate(() => localStorage.clear());
  await page.close();
});
