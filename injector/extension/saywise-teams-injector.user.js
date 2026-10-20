// ==UserScript==
// @name         SayWise Teams Web Microphone Injector
// @namespace    https://github.com/saywise
// @version      0.2.0
// @description  Mixes SayWise Streaming TTS into the microphone track Teams Web gets from getUserMedia (docs/teams-web-audio-injection-spec.md Phase 2).
// @match        https://teams.microsoft.com/*
// @match        https://teams.live.com/*
// @match        https://teams.cloud.microsoft/*
// @match        http://127.0.0.1:4100/test/*
// @match        http://localhost:4100/test/*
// @run-at       document-start
// @grant        none
// @inject-into  page
// @sandbox      raw
// ==/UserScript==

/**
 * SayWise Teams Web Microphone Injector (docs/teams-web-audio-injection-spec.md §3.2.2, Phase 2).
 *
 * Runs in the page's own JavaScript world before any Teams script, and replaces
 * MediaDevices.prototype.getUserMedia so that every request for audio gets back a mixed
 * track instead of the raw microphone:
 *
 *   real mic ─ MediaStreamSource ─ micGain ─┐
 *                                           ├─ mixer ─ limiter ─ MediaStreamDestination ─▶ caller
 *   bridge MP3 chunks ─ decoder ─ ttsBus ─ ttsGain ─┘
 *
 * The TTS side is fed by the SayWise Audio Bridge (server/lib/audio-bridge.js), which this
 * script joins as a consumer. Requests without audio, and anything that goes wrong while
 * building the mix, fall through to the real getUserMedia — the injector must never be
 * the reason a meeting has no microphone.
 *
 * Bridge connection state (BridgeConnectionState, spec §4.1) is exactly one of
 *   DISCONNECTED / CONNECTING / STANDBY / STREAMING / ERROR
 * and the mix mode (AudioMixMode, spec §4.2) exactly one of
 *   REAL_MIC_ONLY / TTS_ONLY / DUCKING / SIMULTANEOUS.
 *
 * The same file is the Tampermonkey/Violentmonkey userscript and, copied verbatim to
 * injector/extension/injector.js by injector/build-extension.js, the MV3 extension's
 * MAIN-world content script.
 *
 * Config (later wins): built-in defaults < localStorage 'saywise.injector.config' (JSON)
 * < window.__SAYWISE_INJECTOR_CONFIG__ set by an earlier document-start script.
 * Control/inspection from the console: window.__saywiseInjector.
 */
(function saywiseTeamsInjector() {
  'use strict';

  if (window.__saywiseInjector) return; // userscript and extension both installed
  const proto = window.MediaDevices && window.MediaDevices.prototype;
  if (!proto || typeof proto.getUserMedia !== 'function') return; // insecure context / no WebRTC

  const VERSION = '0.2.0';
  const LOG = '[saywise-injector]';

  const AudioMixMode = Object.freeze({
    REAL_MIC_ONLY: 'REAL_MIC_ONLY',
    TTS_ONLY: 'TTS_ONLY',
    DUCKING: 'DUCKING',
    SIMULTANEOUS: 'SIMULTANEOUS',
  });

  const BridgeConnectionState = Object.freeze({
    DISCONNECTED: 'DISCONNECTED',
    CONNECTING: 'CONNECTING',
    STANDBY: 'STANDBY',
    STREAMING: 'STREAMING',
    ERROR: 'ERROR',
  });

  const DUCK_DB = -18;
  const DUCK_GAIN = 10 ** (DUCK_DB / 20);
  // setTargetAtTime time constants: ~3τ to settle. Fast attack so the first syllable isn't
  // masked, slower release so the mic doesn't pop back between words.
  const ATTACK_TAU = 0.02;
  const RELEASE_TAU = 0.1;
  const MODE_TAU = 0.03;
  // Keep ducking through short decode gaps instead of pumping the mic between batches.
  const DUCK_HANGOVER_MS = 250;
  const VIRTUAL_MIC_ID = 'saywise-virtual-mic';
  const VIRTUAL_MIC_LABEL = 'SayWise Virtual Microphone';
  const RECONNECT_MIN_MS = 500;
  const RECONNECT_MAX_MS = 10_000;
  const RELAY_KEY = '__saywiseRelay';

  const STORAGE = {
    config: 'saywise.injector.config',
    mode: 'saywise.injector.mode',
    hud: 'saywise.injector.hud',
  };

  const nativeGetUserMedia = proto.getUserMedia;
  const nativeEnumerateDevices = proto.enumerateDevices;
  const nativeTrackStop = MediaStreamTrack.prototype.stop;
  const nativeTrackClone = MediaStreamTrack.prototype.clone;

  function storageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null; // storage blocked (sandboxed frame, privacy mode)
    }
  }
  function storageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {}
  }

  function readConfig() {
    const config = {
      bridgeUrl: 'ws://127.0.0.1:4100/audio-bridge?role=consumer',
      mode: AudioMixMode.DUCKING,
      hud: true,
      virtualDevice: true, // offer a virtual mic in enumerateDevices when none is attached
      relayWaitMs: 300, // how long to wait for the extension relay before going direct
    };
    try {
      Object.assign(config, JSON.parse(storageGet(STORAGE.config) || '{}'));
    } catch {}
    Object.assign(config, window.__SAYWISE_INJECTOR_CONFIG__ || {});
    const savedMode = storageGet(STORAGE.mode);
    if (!window.__SAYWISE_INJECTOR_CONFIG__?.mode && AudioMixMode[savedMode]) config.mode = savedMode;
    if (!AudioMixMode[config.mode]) config.mode = AudioMixMode.DUCKING;
    return config;
  }

  const config = readConfig();

  // ---- tiny event emitter (HUD and tests subscribe to the same events) -------------

  const listeners = new Map();
  function on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
    return () => listeners.get(type).delete(fn);
  }
  function emit(type, detail) {
    for (const fn of listeners.get(type) || []) {
      try {
        fn(detail);
      } catch (err) {
        console.error(LOG, `${type} listener threw`, err);
      }
    }
  }

  const stats = {
    chunks: 0,
    bytes: 0,
    streams: 0,
    decodeErrors: 0,
    underruns: 0,
    sessionsCreated: 0,
    fallbacks: 0, // getUserMedia calls served by the raw mic because mixing failed
    transport: null, // 'websocket' | 'relay'
    producerState: null, // the bridge's own BridgeSessionState, from hello/state frames
  };

  // =====================================================================================
  // Audio engine: one AudioContext and one TTS bus shared by every getUserMedia session.
  // =====================================================================================

  let ctx = null;
  let ttsBus = null;
  let ttsAnalyser = null;
  let mode = config.mode;
  let ttsActive = false; // decoded TTS audio is scheduled/playing (drives DUCKING)
  const sessions = new Set();

  function ensureContext() {
    if (ctx) return ctx;
    ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    ttsBus = ctx.createGain();
    ttsAnalyser = ctx.createAnalyser();
    ttsAnalyser.fftSize = 1024;
    ttsBus.connect(ttsAnalyser);
    // getUserMedia is normally called from a click (Join), so resume() succeeds; if the
    // autoplay policy still holds the context, the next user gesture releases it.
    const resume = () => {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    };
    resume();
    for (const type of ['pointerdown', 'keydown', 'click']) window.addEventListener(type, resume, { capture: true, passive: true });
    ctx.addEventListener('statechange', () => emit('change'));
    return ctx;
  }

  function targetGains() {
    switch (mode) {
      case AudioMixMode.REAL_MIC_ONLY:
        return { mic: 1, tts: 0 };
      case AudioMixMode.TTS_ONLY:
        return { mic: 0, tts: 1 };
      case AudioMixMode.SIMULTANEOUS:
        return { mic: 1, tts: 1 };
      case AudioMixMode.DUCKING:
      default:
        return { mic: ttsActive ? DUCK_GAIN : 1, tts: 1 };
    }
  }

  /** Smoothly moves `param` to `value`, starting at context time `at`, from wherever it is now. */
  function rampParam(param, value, at, tau) {
    const now = ctx.currentTime;
    if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(now);
    else {
      param.cancelScheduledValues(now);
      param.setValueAtTime(param.value, now);
    }
    param.setTargetAtTime(value, Math.max(at, now), tau);
  }

  function applyGains(at, tau = MODE_TAU) {
    if (!ctx) return;
    const { mic, tts } = targetGains();
    const when = at ?? ctx.currentTime;
    for (const s of sessions) {
      rampParam(s.micGain.gain, mic, when, tau);
      rampParam(s.ttsGain.gain, tts, when, tau);
    }
  }

  function setMode(next) {
    if (!AudioMixMode[next]) throw new TypeError(`unknown AudioMixMode ${next}`);
    if (next === mode) return;
    mode = next;
    storageSet(STORAGE.mode, mode);
    applyGains();
    emit('change');
  }

  let hangoverTimer = null;
  function onTtsScheduled(startTime) {
    clearTimeout(hangoverTimer);
    hangoverTimer = null;
    if (ttsActive) return;
    ttsActive = true;
    // Duck exactly when the first buffer becomes audible, not when the stream was announced.
    if (mode === AudioMixMode.DUCKING) applyGains(startTime - 0.01, ATTACK_TAU);
    emit('change');
  }
  function onTtsDrained() {
    if (!ttsActive || hangoverTimer) return;
    hangoverTimer = setTimeout(() => {
      hangoverTimer = null;
      if (player && player.busy) return;
      ttsActive = false;
      if (mode === AudioMixMode.DUCKING) applyGains(undefined, RELEASE_TAU);
      emit('change');
    }, DUCK_HANGOVER_MS);
  }

  // ---- one mixed track per getUserMedia call ------------------------------------------

  class MixSession {
    /** @param {MediaStreamTrack|null} micTrack  null = no physical mic (silent dummy input) */
    constructor(micTrack) {
      this.id = ++stats.sessionsCreated;
      this.micTrack = micTrack;
      this.refs = 1; // the track plus any clones the caller made
      this.disposed = false;

      this.micGain = ctx.createGain();
      this.ttsGain = ctx.createGain();
      this.mixer = ctx.createGain();
      // Safety limiter: SIMULTANEOUS at full scale must not clip the encoder input. At
      // normal speech levels (well under -1 dBFS) it is transparent.
      this.limiter = ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -1;
      this.limiter.knee.value = 0;
      this.limiter.ratio.value = 20;
      this.limiter.attack.value = 0.002;
      this.limiter.release.value = 0.1;
      this.destination = ctx.createMediaStreamDestination();
      this.destination.channelCount = 1; // a microphone is mono
      this.micAnalyser = ctx.createAnalyser();
      this.micAnalyser.fftSize = 1024;
      this.outAnalyser = ctx.createAnalyser();
      this.outAnalyser.fftSize = 1024;

      const { mic, tts } = targetGains();
      this.micGain.gain.value = mic;
      this.ttsGain.gain.value = tts;

      this.micGain.connect(this.mixer);
      ttsBus.connect(this.ttsGain).connect(this.mixer);
      this.mixer.connect(this.limiter).connect(this.destination);
      this.limiter.connect(this.outAnalyser);

      this.micSource = null;
      if (micTrack) {
        this.micSource = ctx.createMediaStreamSource(new MediaStream([micTrack]));
        this.micSource.connect(this.micGain);
        this.micSource.connect(this.micAnalyser);
        // Unplugged mic: keep the mixed track alive (TTS still works), just lose the input.
        micTrack.addEventListener('ended', () => {
          this.micSource?.disconnect();
          this.micSource = null;
          emit('change');
        });
      }

      this.track = this.destination.stream.getAudioTracks()[0];
      this._dress(this.track);
      sessions.add(this);
    }

    /**
     * Makes the destination track look like the microphone it stands in for, so device
     * pickers and constraint code in the caller keep working, and makes stop() release
     * the real device.
     */
    _dress(track) {
      const session = this;
      const mic = this.micTrack;
      const define = (name, value) => Object.defineProperty(track, name, { value, configurable: true, writable: true });
      Object.defineProperty(track, 'label', { configurable: true, get: () => (mic ? mic.label : VIRTUAL_MIC_LABEL) });
      define('getSettings', () =>
        mic ? mic.getSettings() : { deviceId: VIRTUAL_MIC_ID, groupId: VIRTUAL_MIC_ID, channelCount: 1, sampleRate: ctx.sampleRate },
      );
      define('getCapabilities', () => (mic && mic.getCapabilities ? mic.getCapabilities() : {}));
      define('getConstraints', () => (mic ? mic.getConstraints() : {}));
      define('applyConstraints', (c) => (mic ? mic.applyConstraints(c) : Promise.resolve()));
      let stopped = false;
      define('stop', function stop() {
        nativeTrackStop.call(this);
        if (stopped) return;
        stopped = true;
        session._release();
      });
      define('clone', function clone() {
        const copy = nativeTrackClone.call(this);
        session.refs++;
        session._dress(copy);
        return copy;
      });
      Object.defineProperty(track, '__saywiseSession', { value: session.id });
    }

    _release() {
      if (--this.refs > 0) return;
      this.dispose();
    }

    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      sessions.delete(this);
      this.micTrack?.stop();
      this.micSource?.disconnect();
      try {
        ttsBus.disconnect(this.ttsGain);
      } catch {}
      for (const n of [this.micGain, this.ttsGain, this.mixer, this.limiter]) n.disconnect();
      emit('change');
    }
  }

  // =====================================================================================
  // Streaming MP3 decoder: frame-aligned decodeAudioData + gapless scheduled buffers
  // (same technique as test/audio-bridge-test.html's WebAudioPlayer). Each batch is
  // decoded with the previous batch's last OVERLAP frames prepended — bit reservoir and
  // MDCT overlap state — then that prefix is trimmed, which keeps seams click-free.
  // =====================================================================================

  const BITRATES = {
    v1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    v2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  };
  const SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

  /** Length in bytes of the MPEG Layer III frame at buf[i], or 0 if there is no valid header. */
  function frameLength(buf, i) {
    if (i + 4 > buf.length || buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) return 0;
    const version = (buf[i + 1] >> 3) & 3;
    const layer = (buf[i + 1] >> 1) & 3;
    const bitrateIdx = buf[i + 2] >> 4;
    const srIdx = (buf[i + 2] >> 2) & 3;
    const padding = (buf[i + 2] >> 1) & 1;
    if (version === 1 || layer !== 1 || bitrateIdx === 0 || bitrateIdx === 15 || srIdx === 3) return 0;
    const bitrate = (version === 3 ? BITRATES.v1 : BITRATES.v2)[bitrateIdx] * 1000;
    return Math.floor(((version === 3 ? 144 : 72) * bitrate) / SAMPLE_RATES[version][srIdx]) + padding;
  }

  class StreamPlayer {
    static OVERLAP = 4;
    static FIRST_BATCH = 3; // small first batch for low TTFA
    static BATCH = 8;

    constructor() {
      this.out = ctx.createGain(); // per stream, so an aborted stream can fade out on its own
      this.out.connect(ttsBus);
      this.pending = new Uint8Array(0);
      this.frames = [];
      this.prefix = [];
      this.chain = Promise.resolve();
      this.decoding = 0;
      this.nextTime = 0;
      this.sources = new Set();
      this.started = false;
      this.id3Checked = false;
      this.disposed = false;
    }

    /** Audio is scheduled, playing, or still being decoded. */
    get busy() {
      return !this.disposed && (this.sources.size > 0 || this.decoding > 0 || this.frames.length > 0);
    }

    push(bytes) {
      const merged = new Uint8Array(this.pending.length + bytes.length);
      merged.set(this.pending);
      merged.set(bytes, this.pending.length);
      let i = 0;
      if (!this.id3Checked && merged.length >= 10) {
        this.id3Checked = true;
        if (merged[0] === 0x49 && merged[1] === 0x44 && merged[2] === 0x33) {
          i = 10 + ((merged[6] << 21) | (merged[7] << 14) | (merged[8] << 7) | merged[9]);
        }
      }
      while (i + 4 <= merged.length) {
        const len = frameLength(merged, i);
        if (!len) {
          i++; // resync on garbage
          continue;
        }
        if (i + len > merged.length) break;
        this.frames.push(merged.subarray(i, i + len));
        i += len;
      }
      this.pending = merged.slice(i);
      if (this.frames.length >= (this.started ? StreamPlayer.BATCH : StreamPlayer.FIRST_BATCH)) this._decodeBatch();
    }

    end() {
      if (this.frames.length) this._decodeBatch();
      else if (!this.busy) onTtsDrained();
    }

    _decodeBatch() {
      this.started = true;
      const batch = this.frames;
      const all = [...this.prefix, ...batch];
      this.frames = [];
      this.prefix = batch.slice(-StreamPlayer.OVERLAP);
      const bytes = new Uint8Array(all.reduce((n, f) => n + f.length, 0));
      let o = 0;
      for (const f of all) {
        bytes.set(f, o);
        o += f.length;
      }
      this.decoding++;
      this.chain = this.chain.then(() => this._decodeAndSchedule(bytes.buffer, batch.length / all.length));
    }

    async _decodeAndSchedule(arrayBuffer, keepFraction) {
      let decoded = null;
      try {
        decoded = await ctx.decodeAudioData(arrayBuffer);
      } catch (err) {
        stats.decodeErrors++;
        console.warn(LOG, 'decodeAudioData failed', err);
      }
      this.decoding--;
      if (this.disposed) return;
      if (!decoded) {
        if (!this.busy) onTtsDrained();
        return;
      }
      const keep = Math.round(decoded.length * keepFraction);
      const offset = (decoded.length - keep) / decoded.sampleRate;
      const src = ctx.createBufferSource();
      src.buffer = decoded;
      src.connect(this.out);
      const now = ctx.currentTime;
      if (this.nextTime < now + 0.01) {
        if (this.nextTime !== 0) stats.underruns++;
        this.nextTime = now + 0.03; // scheduling headroom
      }
      src.start(this.nextTime, offset);
      onTtsScheduled(this.nextTime);
      this.nextTime += keep / decoded.sampleRate;
      this.sources.add(src);
      src.onended = () => {
        this.sources.delete(src);
        if (!this.busy) onTtsDrained();
      };
    }

    /** Stops playback; `fade` avoids the click of cutting a waveform mid-cycle. */
    dispose(fade = true) {
      if (this.disposed) return;
      this.disposed = true;
      const sources = [...this.sources];
      this.sources.clear();
      const out = this.out;
      const finish = () => {
        for (const src of sources) {
          try {
            src.stop();
          } catch {}
          src.disconnect();
        }
        out.disconnect();
      };
      if (fade && sources.length) {
        out.gain.setTargetAtTime(0, ctx.currentTime, 0.008);
        setTimeout(finish, 60);
      } else finish();
      onTtsDrained();
    }
  }

  let player = null;

  function beginStream() {
    if (!ctx) return; // nobody has asked for a mic yet: nothing to mix into
    player?.dispose();
    stats.streams++;
    player = new StreamPlayer();
  }

  // =====================================================================================
  // Bridge consumer. Transport is a direct WebSocket, or — when the MV3 extension's
  // ISOLATED-world relay (injector/extension/relay.js) is present — a WebSocket opened by
  // the relay and tunnelled over window.postMessage, which is not subject to the page's
  // CSP connect-src.
  // =====================================================================================

  let relayReady = false;
  let relayWaiters = [];
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data[RELAY_KEY] !== 'from-relay') return;
    const msg = event.data;
    if (msg.op === 'ready') {
      if (!relayReady) {
        relayReady = true;
        for (const w of relayWaiters) w();
        relayWaiters = [];
        bridge.onRelayAvailable();
      }
      return;
    }
    RelaySocket.dispatch(msg);
  });
  window.postMessage({ [RELAY_KEY]: 'to-relay', op: 'probe' }, '*');

  /** WebSocket-shaped wrapper around the relay's postMessage tunnel. */
  class RelaySocket {
    static nextId = 1;
    static open = new Map();
    static dispatch(msg) {
      const sock = RelaySocket.open.get(msg.id);
      if (!sock) return;
      if (msg.op === 'open') sock.onopen?.({});
      else if (msg.op === 'message') sock.onmessage?.({ data: msg.data });
      else if (msg.op === 'error') sock.onerror?.({});
      else if (msg.op === 'close') {
        RelaySocket.open.delete(msg.id);
        sock.onclose?.({ code: msg.code ?? 1006 });
      }
    }
    constructor(url) {
      this.id = RelaySocket.nextId++;
      this.binaryType = 'arraybuffer';
      RelaySocket.open.set(this.id, this);
      window.postMessage({ [RELAY_KEY]: 'to-relay', op: 'connect', id: this.id, url }, '*');
    }
    send() {} // consumers never send
    close() {
      if (!RelaySocket.open.delete(this.id)) return;
      window.postMessage({ [RELAY_KEY]: 'to-relay', op: 'close', id: this.id }, '*');
    }
  }

  const bridge = {
    state: BridgeConnectionState.DISCONNECTED,
    ws: null,
    wanted: false,
    delay: RECONNECT_MIN_MS,
    timer: null,

    setState(next) {
      if (this.state === next) return;
      this.state = next;
      emit('change');
    },

    async connect() {
      this.wanted = true;
      if (this.ws || this.timer) return;
      this.setState(BridgeConnectionState.CONNECTING);
      if (!relayReady && config.relayWaitMs > 0) {
        await new Promise((resolve) => {
          relayWaiters.push(resolve);
          setTimeout(resolve, config.relayWaitMs);
        });
        if (!this.wanted || this.ws) return;
      }
      this._open();
    },

    _open() {
      let ws;
      try {
        ws = relayReady ? new RelaySocket(config.bridgeUrl) : new WebSocket(config.bridgeUrl);
      } catch (err) {
        console.warn(LOG, 'bridge socket failed to open', err);
        this.setState(BridgeConnectionState.ERROR);
        this._retry();
        return;
      }
      stats.transport = relayReady ? 'relay' : 'websocket';
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      this.setState(BridgeConnectionState.CONNECTING);
      ws.onopen = () => {
        if (this.ws !== ws) return;
        this.delay = RECONNECT_MIN_MS;
        this.setState(BridgeConnectionState.STANDBY);
      };
      ws.onmessage = (event) => {
        if (this.ws !== ws) return;
        if (typeof event.data === 'string') this._control(event.data);
        else this._chunk(new Uint8Array(event.data));
      };
      ws.onerror = () => {};
      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.ws = null;
        stats.producerState = null;
        if (player) {
          player.end(); // play out what already arrived
          player = null;
        }
        if (!this.wanted) return this.setState(BridgeConnectionState.DISCONNECTED);
        this.setState(BridgeConnectionState.ERROR);
        this._retry();
      };
    },

    _retry() {
      const delay = this.delay;
      this.delay = Math.min(delay * 2, RECONNECT_MAX_MS);
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.wanted) this._open();
      }, delay);
    },

    disconnect() {
      this.wanted = false;
      clearTimeout(this.timer);
      this.timer = null;
      const ws = this.ws;
      this.ws = null;
      ws?.close();
      player?.dispose();
      player = null;
      stats.producerState = null;
      this.setState(BridgeConnectionState.DISCONNECTED);
    },

    /** The extension relay showed up after we went direct: switch transports. */
    onRelayAvailable() {
      if (!this.ws || stats.transport === 'relay') return;
      const ws = this.ws;
      this.ws = null;
      ws.close();
      this._open();
    },

    _control(text) {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (msg.type === 'hello' || msg.type === 'state') {
        stats.producerState = msg.state;
        emit('change');
      } else if (msg.type === 'start') {
        beginStream();
        this.setState(BridgeConnectionState.STREAMING);
      } else if (msg.type === 'end') {
        player?.end();
        this.setState(BridgeConnectionState.STANDBY);
      } else if (msg.type === 'abort') {
        player?.dispose();
        player = null;
        this.setState(BridgeConnectionState.STANDBY);
      }
    },

    _chunk(bytes) {
      stats.chunks++;
      stats.bytes += bytes.length;
      if (this.state !== BridgeConnectionState.STREAMING) {
        // Joined mid-stream: no 'start' seen.
        beginStream();
        this.setState(BridgeConnectionState.STREAMING);
      }
      player?.push(bytes);
    },
  };

  // =====================================================================================
  // getUserMedia / enumerateDevices proxies
  // =====================================================================================

  function asList(v) {
    if (v == null) return [];
    if (typeof v === 'string') return [v];
    if (Array.isArray(v)) return v;
    if (typeof v === 'object') return [...asList(v.exact), ...asList(v.ideal)];
    return [];
  }

  function requestsVirtualMic(audio) {
    return typeof audio === 'object' && asList(audio.deviceId).includes(VIRTUAL_MIC_ID);
  }

  function isNoDeviceError(err) {
    return err && (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError');
  }

  async function getUserMedia(constraints) {
    if (!constraints || !constraints.audio) return nativeGetUserMedia.call(this, constraints);

    let real = null;
    const videoOnly = constraints.video ? { video: constraints.video } : null;
    if (requestsVirtualMic(constraints.audio)) {
      if (videoOnly) real = await nativeGetUserMedia.call(this, videoOnly);
    } else {
      try {
        real = await nativeGetUserMedia.call(this, constraints);
      } catch (err) {
        // Permission denials and the like must reach the caller unchanged; only "there is
        // no microphone" is turned into a silent dummy input.
        if (!isNoDeviceError(err)) throw err;
        console.info(LOG, 'no physical microphone, using a silent dummy input');
        if (videoOnly) real = await nativeGetUserMedia.call(this, videoOnly);
      }
    }

    try {
      ensureContext();
      const micTrack = real ? real.getAudioTracks()[0] || null : null;
      const session = new MixSession(micTrack);
      const stream = new MediaStream([session.track, ...(real ? real.getVideoTracks() : [])]);
      ensureHud();
      if (!bridge.wanted) bridge.connect();
      emit('change');
      return stream;
    } catch (err) {
      stats.fallbacks++;
      console.error(LOG, 'mixing failed; passing the real microphone through', err);
      if (real) return real;
      throw err;
    }
  }

  function virtualDeviceInfo() {
    const base = window.InputDeviceInfo ? window.InputDeviceInfo.prototype : window.MediaDeviceInfo.prototype;
    const info = Object.create(base);
    const fields = { deviceId: VIRTUAL_MIC_ID, kind: 'audioinput', label: VIRTUAL_MIC_LABEL, groupId: VIRTUAL_MIC_ID };
    for (const [k, v] of Object.entries(fields)) Object.defineProperty(info, k, { value: v, enumerable: true });
    Object.defineProperty(info, 'toJSON', { value: () => ({ ...fields }) });
    Object.defineProperty(info, 'getCapabilities', { value: () => ({ deviceId: VIRTUAL_MIC_ID, channelCount: { min: 1, max: 1 } }) });
    return info;
  }

  async function enumerateDevices() {
    const devices = await nativeEnumerateDevices.call(this);
    if (!config.virtualDevice || devices.some((d) => d.kind === 'audioinput')) return devices;
    return [...devices, virtualDeviceInfo()];
  }

  // Concise method syntax keeps these non-constructible like the native ones.
  const replacements = {
    getUserMedia(constraints) {
      return getUserMedia.call(this, constraints);
    },
    enumerateDevices() {
      return enumerateDevices.call(this);
    },
  };
  for (const name of Object.keys(replacements)) {
    const desc = Object.getOwnPropertyDescriptor(proto, name);
    Object.defineProperty(proto, name, { ...desc, value: replacements[name] });
  }

  // =====================================================================================
  // Levels (HUD + tests)
  // =====================================================================================

  const levelBuf = new Float32Array(1024);
  function rmsDb(analyser) {
    if (!analyser) return -Infinity;
    analyser.getFloatTimeDomainData(levelBuf);
    let sum = 0;
    for (let i = 0; i < levelBuf.length; i++) sum += levelBuf[i] * levelBuf[i];
    const rms = Math.sqrt(sum / levelBuf.length);
    return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
  }
  function getLevels() {
    const s = [...sessions].at(-1);
    return {
      mic: s && s.micSource ? rmsDb(s.micAnalyser) : -Infinity,
      tts: rmsDb(ttsAnalyser),
      out: s ? rmsDb(s.outAnalyser) : -Infinity,
    };
  }

  // =====================================================================================
  // HUD: a small draggable/collapsible widget in a shadow root. Built with DOM APIs only
  // (Teams enforces Trusted Types, so no innerHTML) and styled with a constructed
  // stylesheet (not subject to the page's style-src CSP).
  // =====================================================================================

  const MODE_BUTTONS = [
    [AudioMixMode.REAL_MIC_ONLY, 'Mic', 'Real microphone only'],
    [AudioMixMode.TTS_ONLY, 'TTS', 'SayWise TTS only — real microphone muted'],
    [AudioMixMode.DUCKING, 'Duck', `Real microphone ducked ${DUCK_DB} dB while TTS speaks`],
    [AudioMixMode.SIMULTANEOUS, 'Mix', 'Real microphone and TTS at equal weight'],
  ];
  const STATE_COLORS = {
    DISCONNECTED: '#8c959f',
    CONNECTING: '#bf8700',
    STANDBY: '#2da44e',
    STREAMING: '#0969da',
    ERROR: '#cf222e',
  };
  const HUD_CSS = `
    :host { all: initial; position: fixed; z-index: 2147483646; right: 16px; bottom: 16px; }
    .panel { font: 12px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif; color: #1f2328;
      background: rgba(255,255,255,.96); border: 1px solid #d0d7de; border-radius: 8px;
      box-shadow: 0 4px 14px rgba(0,0,0,.18); width: 210px; user-select: none; }
    .head { display: flex; align-items: center; gap: 6px; padding: 5px 8px; cursor: grab; }
    .head:active { cursor: grabbing; }
    .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
    .title { font-weight: 600; }
    .state { color: #57606a; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    button { font: inherit; border: 1px solid #d0d7de; background: #f6f8fa; border-radius: 5px;
      padding: 1px 6px; cursor: pointer; color: inherit; }
    button.on { background: #0969da; border-color: #0969da; color: #fff; }
    .toggle { padding: 0 6px; }
    .body { padding: 2px 8px 8px; }
    .collapsed .body { display: none; }
    .row { display: flex; align-items: center; gap: 6px; margin: 3px 0; }
    .row label { width: 26px; color: #57606a; }
    .meter { flex: 1; height: 6px; background: #eaeef2; border-radius: 3px; overflow: hidden; }
    .meter > div { height: 100%; width: 0; background: #2da44e; transition: width 60ms linear; }
    .db { width: 34px; text-align: right; font-variant-numeric: tabular-nums; color: #57606a; }
    .modes { display: flex; gap: 4px; margin-top: 6px; }
    .modes button { flex: 1; padding: 2px 0; }
    .foot { margin-top: 5px; color: #57606a; font-size: 11px; }
  `;

  let hud = null;

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function ensureHud() {
    if (hud || !config.hud) return;
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', ensureHud, { once: true });
      return;
    }
    const saved = (() => {
      try {
        return JSON.parse(storageGet(STORAGE.hud) || '{}');
      } catch {
        return {};
      }
    })();

    const host = el('div');
    host.id = 'saywise-injector-hud';
    const root = host.attachShadow({ mode: 'open' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(HUD_CSS);
      root.adoptedStyleSheets = [sheet];
    } catch {
      root.appendChild(el('style', null, HUD_CSS));
    }

    const panel = el('div', 'panel');
    const head = el('div', 'head');
    const dot = el('span', 'dot');
    const stateText = el('span', 'state');
    const toggle = el('button', 'toggle');
    toggle.type = 'button';
    head.append(dot, el('span', 'title', 'SayWise'), stateText, toggle);

    const body = el('div', 'body');
    const meters = {};
    for (const [key, label] of [['mic', 'Mic'], ['tts', 'TTS'], ['out', 'Out']]) {
      const row = el('div', 'row');
      const meter = el('div', 'meter');
      const bar = el('div');
      meter.append(bar);
      const db = el('span', 'db', '—');
      row.append(el('label', null, label), meter, db);
      body.append(row);
      meters[key] = { bar, db };
    }
    const modes = el('div', 'modes');
    const modeButtons = {};
    for (const [value, label, title] of MODE_BUTTONS) {
      const b = el('button', null, label);
      b.type = 'button';
      b.title = title;
      b.dataset.mode = value;
      b.addEventListener('click', () => setMode(value));
      modes.append(b);
      modeButtons[value] = b;
    }
    const foot = el('div', 'foot');
    body.append(modes, foot);
    panel.append(head, body);
    root.append(panel);

    let collapsed = !!saved.collapsed;
    const save = () =>
      storageSet(STORAGE.hud, JSON.stringify({ collapsed, left: host.style.left || null, top: host.style.top || null }));
    function applyCollapsed() {
      panel.classList.toggle('collapsed', collapsed);
      toggle.textContent = collapsed ? '+' : '–';
      toggle.title = collapsed ? 'Expand' : 'Collapse';
    }
    toggle.addEventListener('click', () => {
      collapsed = !collapsed;
      applyCollapsed();
      save();
    });
    applyCollapsed();

    function place(left, top) {
      const r = host.getBoundingClientRect();
      left = Math.max(0, Math.min(window.innerWidth - r.width, left));
      top = Math.max(0, Math.min(window.innerHeight - r.height, top));
      Object.assign(host.style, { left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto' });
    }
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target === toggle) return;
      const r = host.getBoundingClientRect();
      const dx = e.clientX - r.left;
      const dy = e.clientY - r.top;
      head.setPointerCapture(e.pointerId);
      const move = (ev) => place(ev.clientX - dx, ev.clientY - dy);
      const up = () => {
        head.removeEventListener('pointermove', move);
        head.removeEventListener('pointerup', up);
        save();
      };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up);
    });

    function render() {
      const state = bridge.state;
      dot.style.background = STATE_COLORS[state];
      let text = state;
      if (state === BridgeConnectionState.STANDBY && stats.producerState === 'DISCONNECTED') text = 'STANDBY · no SayWise tab';
      if (ctx && ctx.state === 'suspended') text += ' · click to enable audio';
      stateText.textContent = text;
      stateText.title = `${config.bridgeUrl} (${stats.transport || '—'})`;
      for (const [value, b] of Object.entries(modeButtons)) b.classList.toggle('on', value === mode);
      const live = [...sessions];
      const mic = live.at(-1);
      foot.textContent = `${live.length} mic track${live.length === 1 ? '' : 's'}` +
        (mic && !mic.micSource ? ' · no physical mic' : '') +
        (ttsActive ? ' · speaking' : '');
    }
    function renderLevels() {
      if (!collapsed && !document.hidden) {
        const levels = getLevels();
        for (const [key, { bar, db }] of Object.entries(meters)) {
          const v = levels[key];
          const pct = Number.isFinite(v) ? Math.max(0, Math.min(1, (v + 60) / 60)) * 100 : 0;
          bar.style.width = `${pct}%`;
          bar.style.background = v > -6 ? '#cf222e' : v > -18 ? '#bf8700' : '#2da44e';
          db.textContent = Number.isFinite(v) ? v.toFixed(0) : '—';
        }
      }
      // Single-page apps sometimes replace <body>; put the HUD back if it was removed.
      if (!host.isConnected && document.body) document.body.append(host);
    }

    document.body.append(host);
    if (saved.left != null && saved.top != null) place(parseFloat(saved.left), parseFloat(saved.top));
    on('change', render);
    render();
    setInterval(renderLevels, 100);
    hud = { host, render };
  }

  // Alt+Shift+M cycles the mix mode without touching the mouse.
  window.addEventListener(
    'keydown',
    (e) => {
      if (!(e.altKey && e.shiftKey && e.code === 'KeyM')) return;
      const order = MODE_BUTTONS.map(([m]) => m);
      setMode(order[(order.indexOf(mode) + 1) % order.length]);
    },
    true,
  );

  // =====================================================================================
  // Public handle (console / tests). Non-enumerable so it doesn't show up in page scans.
  // =====================================================================================

  Object.defineProperty(window, '__saywiseInjector', {
    configurable: false,
    enumerable: false,
    value: Object.freeze({
      version: VERSION,
      AudioMixMode,
      BridgeConnectionState,
      DUCK_DB,
      getMode: () => mode,
      setMode,
      getState: () => bridge.state,
      isTtsActive: () => ttsActive,
      getLevels,
      getStats: () => ({
        ...stats,
        state: bridge.state,
        mode,
        ttsActive,
        sessions: sessions.size,
        contextState: ctx ? ctx.state : null,
        bridgeUrl: config.bridgeUrl,
      }),
      /** Current gain values of the newest session (for ramp inspection). */
      getGains: () => {
        const s = [...sessions].at(-1);
        if (!s) return null;
        const targets = targetGains();
        return {
          mic: s.micGain.gain.value,
          tts: s.ttsGain.gain.value,
          targetMic: targets.mic,
          targetTts: targets.tts,
        };
      },
      connect: () => bridge.connect(),
      disconnect: () => bridge.disconnect(),
      pushChunk: (bytes) => bridge._chunk(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)),
      control: (msg) => bridge._control(typeof msg === 'string' ? msg : JSON.stringify(msg)),
      on,
    }),
  });

  // Connect right away so the HUD (top frame) shows bridge status before the first call;
  // subframes wait until they actually hand out a microphone.
  if (window.top === window) {
    bridge.connect();
    ensureHud();
  }
  console.info(LOG, `v${VERSION} active, mode ${mode}, bridge ${config.bridgeUrl}`);
})();
