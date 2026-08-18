/**
 * StreamingAudioPlayer — MediaSource/SourceBuffer-backed streaming audio
 * playback for a single Speak round.
 *
 * Adapted from public/js/streaming-response-handler.js's StreamingAudioSource
 * (tasks.md Phase 4):
 *  - constructor / appendChunk() / _flush() / end() / dispose() are the
 *    core reuse (T4.1-T4.3) — pure MediaSource/SourceBuffer plumbing with
 *    zero Live2D reference in the source.
 *  - setupAnalyser() (AnalyserNode/DelayNode lip-sync chain) is NOT
 *    adapted — 100% Live2D mouth-sync specific, never called by anything
 *    else in the reference class either (T4.1).
 *  - The reference's _audioQueue/_playLoop FIFO (built for multiple
 *    LLM-generated sentences arriving over time) is NOT built — Voice
 *    Copilot has exactly one Speech Text per Speak click, so exactly one
 *    StreamingAudioPlayer instance is ever active at a time (T4.4).
 *  - firstChunkReady is renamed firstPlayableReady and its resolution
 *    condition is corrected (review ④): it now resolves only once the
 *    SourceBuffer's own `buffered` state confirms a real, non-zero
 *    playable range after an `updateend`, not merely because a chunk was
 *    handed to appendBuffer() (T4.2).
 *  - This class is the SOLE owner of the <audio> element (review ⑥) —
 *    autoplay is triggered internally once firstPlayableReady resolves;
 *    no other module calls .play()/.pause()/.currentTime on it directly.
 *    Callers only ever use the public pause()/resume()/replay()/stop()
 *    methods and react to the onPlaying/onAutoplayBlocked/onError/
 *    onStatusChange callbacks (T4.5).
 *  - TTFA (review ⑤) is measured to the <audio> element's actual first
 *    'playing' event, not to play() being called or its Promise
 *    resolving — onPlaying fires from that event, not from the play()
 *    call site (T4.6).
 */

export class StreamingAudioPlayer {
  /**
   * @param {object} [callbacks]
   * @param {() => void} [callbacks.onPlaying]          fires once, on the first real 'playing' event of this round
   * @param {() => void} [callbacks.onAutoplayBlocked]   fires if the internal auto-play() is rejected (e.g. NotAllowedError)
   * @param {(error: {type: string, message: string}) => void} [callbacks.onError]
   * @param {(status: 'stopped'|'buffering'|'playing'|'paused') => void} [callbacks.onStatusChange]
   * @param {string} [mimeType]
   */
  constructor(callbacks = {}, mimeType = 'audio/mpeg') {
    this._callbacks = callbacks;
    this.mimeType = mimeType;

    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.mediaSource = new MediaSource();
    this._objectUrl = URL.createObjectURL(this.mediaSource);
    this.audio.src = this._objectUrl;

    this._sourceBuffer = null;
    this._queue = [];
    this._ended = false; // end() has been called — no more chunks coming
    this._disposed = false;
    this._playingFired = false; // guards onPlaying firing more than once per round
    this._suppressPauseEvent = false; // see stop(): avoids the native 'pause'
    // event (queued async by the browser) clobbering an explicit stop()
    this._watchdogTimer = null;

    this.playbackStatus = 'buffering';

    this._firstPlayableResolve = null;
    this.firstPlayableReady = new Promise((res) => { this._firstPlayableResolve = res; });

    this._readyPromise = new Promise((resolve, reject) => {
      const onOpen = () => {
        try {
          this._sourceBuffer = this.mediaSource.addSourceBuffer(this.mimeType);
          this._sourceBuffer.mode = 'sequence';
          this._sourceBuffer.addEventListener('updateend', () => {
            this._checkPlayable();
            this._flush();
          });
          this._flush();
          resolve();
        } catch (e) {
          reject(e);
        }
      };
      this.mediaSource.addEventListener('sourceopen', onOpen, { once: true });
    });

    this._setupAudioListeners();

    // Once a real playable range exists, this class autonomously starts
    // playback — no external caller triggers this (review ⑥).
    this.firstPlayableReady.then(() => this._autoPlay());
  }

  // ─── Ingest ────────────────────────────────────────────────────────────

  /** Called from tts-client.js's onChunk as Audio Chunks arrive. */
  async appendChunk(bytes) {
    if (this._disposed || this._ended) return;
    await this._readyPromise;
    if (this._disposed) return;
    this._queue.push(bytes);
    this._flush();
  }

  /** Called once tts-client.js's endSession() has resolved (review ⑦ — never earlier). */
  async end() {
    await this._readyPromise;
    if (this._disposed) return;
    this._ended = true;
    this._flush();
  }

  _flush() {
    if (this._disposed) return;
    if (!this._sourceBuffer || this._sourceBuffer.updating) return;
    if (this._queue.length > 0) {
      const chunk = this._queue.shift();
      try {
        this._sourceBuffer.appendBuffer(chunk);
      } catch (e) {
        console.error('[StreamingAudioPlayer] appendBuffer failed:', e);
        this._emitError({ type: 'source-buffer-append-failed', message: e.message });
      }
      return;
    }
    if (this._ended) {
      try {
        if (this.mediaSource.readyState === 'open') this.mediaSource.endOfStream();
      } catch (_) {
        // 忽略重复 endOfStream
      }
      this._startWatchdog();
    }
  }

  /**
   * T4.2 correction (review ④): firstPlayableReady must not resolve just
   * because a chunk was queued/appended — only once the SourceBuffer's
   * own buffered TimeRanges confirm a real, non-zero playable range. A
   * single very small first chunk may not be enough on its own; this is
   * checked again on every subsequent updateend until it is.
   */
  _checkPlayable() {
    if (!this._firstPlayableResolve || !this._sourceBuffer) return;
    const buffered = this._sourceBuffer.buffered;
    if (buffered.length > 0 && buffered.end(0) - buffered.start(0) > 0) {
      const resolve = this._firstPlayableResolve;
      this._firstPlayableResolve = null;
      resolve();
    }
  }

  // ─── Autoplay (sole owner of the <audio> element — review ⑥) ──────────

  async _autoPlay() {
    if (this._disposed) return;
    try {
      await this.audio.play();
      // playbackStatus/onPlaying are driven by the real 'playing' event
      // listener below (review ⑤), not from here — play() resolving does
      // not guarantee audio is actually audible yet.
    } catch (err) {
      console.warn('[StreamingAudioPlayer] autoplay blocked:', err.message);
      if (typeof this._callbacks.onAutoplayBlocked === 'function') {
        this._callbacks.onAutoplayBlocked();
      }
    }
  }

  _setupAudioListeners() {
    this.audio.addEventListener('playing', () => {
      if (this._disposed) return;
      if (!this._playingFired) {
        this._playingFired = true;
        if (typeof this._callbacks.onPlaying === 'function') this._callbacks.onPlaying();
      }
      this._setStatus('playing');
    });

    this.audio.addEventListener('pause', () => {
      if (this._suppressPauseEvent) return;
      if (this._disposed) return;
      this._setStatus('paused');
    });

    this.audio.addEventListener('ended', () => {
      if (this._disposed) return;
      this._setStatus('stopped');
      this._stopWatchdog();
    });

    this.audio.addEventListener('error', () => {
      if (this._disposed) return;
      const mediaError = this.audio.error;
      // MediaSource.endOfStream() can spuriously trigger audio.onerror
      // partway through in some browsers — log but still surface it,
      // callers can decide how to react (plan.md §15/§18).
      console.warn('[StreamingAudioPlayer] audio error:', mediaError);
      this._emitError({
        type: 'audio-element-error',
        message: mediaError ? `MediaError code ${mediaError.code}` : 'unknown audio error',
      });
    });
  }

  _emitError(error) {
    if (typeof this._callbacks.onError === 'function') this._callbacks.onError(error);
  }

  _setStatus(status) {
    if (this.playbackStatus === status) return;
    this.playbackStatus = status;
    if (typeof this._callbacks.onStatusChange === 'function') this._callbacks.onStatusChange(status);
  }

  // ─── Public control surface (review ⑥ — the only way to affect playback) ──

  pause() {
    if (this._disposed) return;
    this.audio.pause();
    // Native 'pause' event listener above will call _setStatus('paused').
  }

  resume() {
    if (this._disposed) return;
    this.audio.play().catch((err) => {
      console.warn('[StreamingAudioPlayer] resume() play() rejected:', err.message);
    });
  }

  /** Only meaningful once generation has fully completed — gating that decision is the caller's job (plan.md §15). */
  replay() {
    if (this._disposed) return;
    this.audio.currentTime = 0;
    this.audio.play().catch((err) => {
      console.warn('[StreamingAudioPlayer] replay() play() rejected:', err.message);
    });
  }

  /**
   * Stop playback locally. Does NOT touch the TTS session/WebSocket —
   * callers (Phase 6) are responsible for also calling
   * tts-client.cancelSession() when appropriate; this method only owns
   * the <audio>/MediaSource/SourceBuffer side of Stop (spec.md §7.1).
   */
  stop() {
    if (this._disposed) return;
    this._suppressPauseEvent = true;
    try {
      this.audio.pause();
      this.audio.currentTime = 0;
    } finally {
      // Let the (now-suppressed) queued 'pause' event drain before
      // re-enabling the listener, so a later legitimate pause() call
      // isn't accidentally suppressed too.
      setTimeout(() => { this._suppressPauseEvent = false; }, 0);
    }
    this._setStatus('stopped');
    this.dispose();
  }

  // ─── Cleanup ───────────────────────────────────────────────────────────

  _startWatchdog() {
    if (this._watchdogTimer) return;
    // MediaSource.endOfStream() doesn't always reliably fire 'ended' in
    // every browser — poll buffered-range end against currentTime once
    // the stream has ended, and treat reaching it as completion.
    this._watchdogTimer = setInterval(() => {
      if (this._disposed) { this._stopWatchdog(); return; }
      const buffered = this.audio.buffered;
      if (buffered && buffered.length > 0) {
        const end = buffered.end(buffered.length - 1);
        if (this.audio.currentTime >= end - 0.05) {
          this._stopWatchdog();
          if (this.playbackStatus !== 'stopped') this._setStatus('stopped');
        }
      }
    }, 250);
  }

  _stopWatchdog() {
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._stopWatchdog();
    try { this.audio.pause(); } catch (_) {}
    try { this.audio.removeAttribute('src'); this.audio.load(); } catch (_) {}
    try { URL.revokeObjectURL(this._objectUrl); } catch (_) {}
  }
}
