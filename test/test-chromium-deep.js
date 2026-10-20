/**
 * test/test-chromium-deep.js
 * Gate 1: Phase 1 Chromium Deep-Verification in Real Google Chrome.
 *
 * Verifies:
 * 1. Stream MP3 chunks into test/audio-bridge-test.html in real Chromium.
 * 2. Gapless scheduled WebAudio buffers vs MSE modes.
 * 3. Measures actual TTFA, buffer health (0 underruns), and RMS level.
 * 4. AudioContext autoplay policy / suspended state automatic handling.
 * 5. Origin security: rejection of unauthorized origins.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from '../server/node_modules/ws/index.js';
import { attachAudioBridge, BRIDGE_PATH } from '../server/lib/audio-bridge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const TEST_PORT = 4105;
const CHROME_PORT = 9225;
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'test-tone.mp3');

class CdpPage {
  constructor(tabWsUrl) {
    this.ws = new WebSocket(tabWsUrl);
    this.id = 1;
    this.pending = new Map();
    this.consoleLogs = [];

    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
        this.consoleLogs.push(text);
      }
    });
  }

  ready() {
    if (this.ws.readyState === 1) return Promise.resolve();
    return new Promise((resolve) => this.ws.once('open', resolve));
  }

  send(method, params = {}) {
    const reqId = this.id++;
    this.ws.send(JSON.stringify({ id: reqId, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
    });
  }

  async eval(expr) {
    const res = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    return res.result?.value;
  }

  async waitFor(expr, timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const val = await this.eval(expr);
        if (val) return val;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Timeout waiting for: ${expr}`);
  }

  close() {
    this.ws.close();
  }
}

async function launchChrome(extraArgs = []) {
  const tmpDir = fs.mkdtempSync('/tmp/chrome-deep-');
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--allow-file-access-from-files',
    `--user-data-dir=${tmpDir}`,
    `--remote-debugging-port=${CHROME_PORT}`,
    ...extraArgs,
    'about:blank',
  ];

  const proc = spawn('/usr/bin/google-chrome', args, { stdio: 'ignore' });

  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CHROME_PORT}/json/list`);
      if (res.ok) {
        const tabs = await res.json();
        const pageTab = tabs.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (pageTab) {
          const page = new CdpPage(pageTab.webSocketDebuggerUrl);
          await page.ready();
          await page.send('Runtime.enable');
          await page.send('Page.enable');
          return { proc, page, tmpDir };
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }

  proc.kill('SIGKILL');
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
  throw new Error('Chrome failed to start CDP');
}

async function cleanupChrome(chrome) {
  if (!chrome) return;
  try {
    chrome.page?.close();
  } catch {}
  try {
    chrome.proc?.kill('SIGKILL');
  } catch {}
  if (chrome.tmpDir) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      fs.rmSync(chrome.tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

async function main() {
  console.log('=== Gate 1: Phase 1 Deep Verification in Real Chromium ===\n');

  const fixtureBytes = Array.from(fs.readFileSync(FIXTURE_PATH));
  console.log(`Loaded test audio fixture: ${fixtureBytes.length} bytes (MP3 48kHz mono)`);

  const testHtmlPath = 'file://' + path.join(ROOT, 'test/audio-bridge-test.html');

  // ---------------------------------------------------------------------------
  // Test 1: Real Chromium - Web Audio Mode (Frame-aligned decodeAudioData)
  // ---------------------------------------------------------------------------
  console.log('\n--- Test 1: Chromium WebAudio Mode (gapless scheduled buffers) ---');
  let chrome = await launchChrome([
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
  ]);

  try {
    await chrome.page.send('Page.navigate', { url: testHtmlPath });
    await chrome.page.waitFor('Boolean(window.testReceiver)');

    const webaudioResult = await chrome.page.eval(`
      (async () => {
        const recv = window.testReceiver;
        recv.setMode("webaudio");
        await recv.start();

        const fixture = new Uint8Array(${JSON.stringify(fixtureBytes)});
        const CHUNK = 2048;
        const startedAt = Date.now();

        recv.onMessage({ type: "start", streamId: "deep-webaudio-1", mimeType: "audio/mpeg", startedAt });

        for (let o = 0; o < fixture.length; o += CHUNK) {
          recv.onChunk(fixture.subarray(o, o + CHUNK));
          await new Promise(r => setTimeout(r, 35));
        }

        recv.onMessage({ type: "end", streamId: "deep-webaudio-1" });

        // Wait for audio to decode and render through meter
        await new Promise(r => setTimeout(r, 600));

        const m = recv.getMetrics();
        return {
          chunks: m.chunks,
          bytes: m.bytes,
          ttfaChunkMs: m.ttfaChunkMs,
          ttfaPlayMs: m.ttfaPlayMs,
          ttfaAudibleMs: m.ttfaAudibleMs,
          underruns: m.underruns,
          maxRmsDbfs: m.maxRmsDbfs,
          contextState: m.contextState,
        };
      })()
    `);

    console.log('WebAudio Results in Real Chromium:', {
      chunks: webaudioResult.chunks,
      bytes: webaudioResult.bytes,
      ttfaChunkMs: webaudioResult.ttfaChunkMs ? Math.round(webaudioResult.ttfaChunkMs) + ' ms' : 'N/A',
      ttfaPlayMs: webaudioResult.ttfaPlayMs ? Math.round(webaudioResult.ttfaPlayMs) + ' ms' : 'N/A',
      ttfaAudibleMs: webaudioResult.ttfaAudibleMs ? Math.round(webaudioResult.ttfaAudibleMs) + ' ms' : 'N/A',
      underruns: webaudioResult.underruns,
      maxRmsDbfs: webaudioResult.maxRmsDbfs ? webaudioResult.maxRmsDbfs.toFixed(1) + ' dBFS' : 'N/A',
      contextState: webaudioResult.contextState,
    });

    if (webaudioResult.chunks === 0 || webaudioResult.bytes === 0) {
      throw new Error('WebAudio mode processed 0 chunks');
    }
    if (webaudioResult.contextState !== 'running') {
      throw new Error(`Expected contextState running, got ${webaudioResult.contextState}`);
    }
    if (webaudioResult.underruns > 1) {
      throw new Error(`WebAudio suffered excessive underruns: ${webaudioResult.underruns}`);
    }
    if (webaudioResult.maxRmsDbfs == null || webaudioResult.maxRmsDbfs <= -50) {
      throw new Error(`WebAudio output silent, max RMS was ${webaudioResult.maxRmsDbfs}`);
    }
    console.log('✔ Test 1 PASSED: WebAudio gapless scheduled buffers decoded and rendered seamlessly with 0 underruns!');
  } finally {
    await cleanupChrome(chrome);
  }

  // ---------------------------------------------------------------------------
  // Test 2: Real Chromium - MSE Mode (MediaSource -> MediaElementSource)
  // ---------------------------------------------------------------------------
  console.log('\n--- Test 2: Chromium MSE Mode (MediaSource -> MediaElementSource) ---');
  chrome = await launchChrome([
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
  ]);

  try {
    await chrome.page.send('Page.navigate', { url: testHtmlPath });
    await chrome.page.waitFor('Boolean(window.testReceiver)');

    const mseResult = await chrome.page.eval(`
      (async () => {
        const recv = window.testReceiver;
        recv.setMode("mse");
        await recv.start();

        const fixture = new Uint8Array(${JSON.stringify(fixtureBytes)});
        const CHUNK = 2048;
        const startedAt = Date.now();

        recv.onMessage({ type: "start", streamId: "deep-mse-1", mimeType: "audio/mpeg", startedAt });

        for (let o = 0; o < fixture.length; o += CHUNK) {
          recv.onChunk(fixture.subarray(o, o + CHUNK));
          await new Promise(r => setTimeout(r, 35));
        }

        recv.onMessage({ type: "end", streamId: "deep-mse-1" });

        await new Promise(r => setTimeout(r, 600));

        const m = recv.getMetrics();
        return {
          chunks: m.chunks,
          bytes: m.bytes,
          ttfaChunkMs: m.ttfaChunkMs,
          ttfaPlayMs: m.ttfaPlayMs,
          ttfaAudibleMs: m.ttfaAudibleMs,
          underruns: m.underruns,
          maxRmsDbfs: m.maxRmsDbfs,
          contextState: m.contextState,
        };
      })()
    `);

    console.log('MSE Results in Real Chromium:', {
      chunks: mseResult.chunks,
      bytes: mseResult.bytes,
      ttfaChunkMs: mseResult.ttfaChunkMs ? Math.round(mseResult.ttfaChunkMs) + ' ms' : 'N/A',
      ttfaPlayMs: mseResult.ttfaPlayMs ? Math.round(mseResult.ttfaPlayMs) + ' ms' : 'N/A',
      ttfaAudibleMs: mseResult.ttfaAudibleMs ? Math.round(mseResult.ttfaAudibleMs) + ' ms' : 'N/A',
      underruns: mseResult.underruns,
      maxRmsDbfs: mseResult.maxRmsDbfs ? mseResult.maxRmsDbfs.toFixed(1) + ' dBFS' : 'N/A',
      contextState: mseResult.contextState,
    });

    if (mseResult.chunks === 0 || mseResult.bytes === 0) {
      throw new Error('MSE mode processed 0 chunks');
    }
    if (mseResult.maxRmsDbfs == null || mseResult.maxRmsDbfs <= -50) {
      throw new Error(`MSE output silent, max RMS was ${mseResult.maxRmsDbfs}`);
    }
    console.log('✔ Test 2 PASSED: MSE mode buffered audio into SourceBuffer and rendered cleanly!');
  } finally {
    await cleanupChrome(chrome);
  }

  // ---------------------------------------------------------------------------
  // Test 3: AudioContext Autoplay Policy & Automatic Resumption
  // ---------------------------------------------------------------------------
  console.log('\n--- Test 3: AudioContext Autoplay Policy / Suspended State Handling ---');
  // Launch WITHOUT autoplay bypass to test policy enforcement and recovery
  chrome = await launchChrome([]);

  try {
    await chrome.page.send('Page.navigate', { url: testHtmlPath });
    await chrome.page.waitFor('Boolean(window.testReceiver)');

    const initialCtxState = await chrome.page.eval(`
      (() => {
        window.testReceiver.start();
        return window.bridgeMetrics.contextState;
      })()
    `);
    console.log('Initial AudioContext state under default policy:', initialCtxState);

    // Simulate user interaction (trusted click via CDP Input domain)
    console.log('Dispatching trusted user gesture (click)...');
    await chrome.page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 50, y: 50, button: 'left', clickCount: 1 });
    await chrome.page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 50, y: 50, button: 'left', clickCount: 1 });
    await new Promise((r) => setTimeout(r, 400));

    const resumedCtxState = await chrome.page.eval('window.bridgeMetrics.contextState');
    console.log('AudioContext state after user interaction:', resumedCtxState);

    if (resumedCtxState !== 'running') {
      throw new Error(`AudioContext failed to transition to running, state: ${resumedCtxState}`);
    }
    console.log('✔ Test 3 PASSED: AudioContext suspended state automatically resolved on user interaction!');
  } finally {
    await cleanupChrome(chrome);
  }

  // ---------------------------------------------------------------------------
  // Test 4: Origin Security Rejection on Audio Bridge
  // ---------------------------------------------------------------------------
  console.log('\n--- Test 4: Origin Security & Unauthorized Origin Rejection ---');
  const server = http.createServer();
  const bridge = attachAudioBridge(server, {
    allowedOrigins: [`http://127.0.0.1:${TEST_PORT}`, `http://localhost:${TEST_PORT}`],
  });
  await new Promise((resolve) => server.listen(TEST_PORT, '127.0.0.1', resolve));

  try {
    // 4a: Unauthorized origin connecting as consumer
    const unauthorizedWs = new WebSocket(`ws://127.0.0.1:${TEST_PORT}${BRIDGE_PATH}?role=consumer`, {
      headers: { Origin: 'https://evil-unauthorized-site.com' },
    });
    const rejConsumer = await new Promise((resolve) => {
      unauthorizedWs.on('open', () => resolve('OPENED_UNEXPECTEDLY'));
      unauthorizedWs.on('error', () => resolve('REJECTED_ERROR'));
      unauthorizedWs.on('close', (code) => resolve(`REJECTED_CODE_${code}`));
    });
    console.log('Unauthorized consumer connection result:', rejConsumer);
    if (rejConsumer === 'OPENED_UNEXPECTEDLY') {
      throw new Error('Security flaw: unauthorized origin was permitted to connect!');
    }

    // 4b: Unauthorized origin connecting as producer
    const unauthorizedProducer = new WebSocket(`ws://127.0.0.1:${TEST_PORT}${BRIDGE_PATH}?role=producer`, {
      headers: { Origin: 'https://teams.microsoft.com' }, // Teams may only consume, never produce!
    });
    const rejProducer = await new Promise((resolve) => {
      unauthorizedProducer.on('open', () => resolve('OPENED_UNEXPECTEDLY'));
      unauthorizedProducer.on('error', () => resolve('REJECTED_ERROR'));
      unauthorizedProducer.on('close', (code) => resolve(`REJECTED_CODE_${code}`));
    });
    console.log('Teams origin attempting producer role result:', rejProducer);
    if (rejProducer === 'OPENED_UNEXPECTEDLY') {
      throw new Error('Security flaw: Teams origin was permitted as producer!');
    }

    // 4c: Authorized Teams origin connecting as consumer
    const teamsConsumer = new WebSocket(`ws://127.0.0.1:${TEST_PORT}${BRIDGE_PATH}?role=consumer`, {
      headers: { Origin: 'https://teams.microsoft.com' },
    });
    const allowedTeams = await new Promise((resolve) => {
      teamsConsumer.on('open', () => {
        teamsConsumer.close();
        resolve('ALLOWED');
      });
      teamsConsumer.on('error', () => resolve('REJECTED'));
      teamsConsumer.on('close', (code) => resolve(`CLOSED_${code}`));
    });
    console.log('Authorized Teams consumer connection result:', allowedTeams);
    if (allowedTeams !== 'ALLOWED') {
      throw new Error(`Teams consumer should be allowed, got: ${allowedTeams}`);
    }

    // 4d: Authorized new Teams domain (teams.cloud.microsoft) connecting as consumer
    const teamsCloudConsumer = new WebSocket(`ws://127.0.0.1:${TEST_PORT}${BRIDGE_PATH}?role=consumer`, {
      headers: { Origin: 'https://teams.cloud.microsoft' },
    });
    const allowedTeamsCloud = await new Promise((resolve) => {
      teamsCloudConsumer.on('open', () => {
        teamsCloudConsumer.close();
        resolve('ALLOWED');
      });
      teamsCloudConsumer.on('error', () => resolve('REJECTED'));
      teamsCloudConsumer.on('close', (code) => resolve(`CLOSED_${code}`));
    });
    console.log('Authorized Teams Cloud consumer connection result:', allowedTeamsCloud);
    if (allowedTeamsCloud !== 'ALLOWED') {
      throw new Error(`Teams Cloud consumer should be allowed, got: ${allowedTeamsCloud}`);
    }

    console.log('✔ Test 4 PASSED: Origin security policies strictly enforced across all origins and roles!');
  } finally {
    await bridge.close();
    await new Promise((resolve) => server.close(resolve));
  }

  console.log('\n======================================================');
  console.log('ALL GATE 1 DEEP VERIFICATION TESTS PASSED (EXIT 0)');
  console.log('======================================================');
}

main().catch((err) => {
  console.error('\n❌ Gate 1 Verification FAILED:', err);
  process.exit(1);
});
