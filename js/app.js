/**
 * Voice Copilot MVP — entry point / DOM wiring.
 *
 * Phase 1-2: static workspace skeleton wired to state.js, plus Provider
 * Configuration + Voice Profile loading/selection.
 * Phase 5: Speak -> Streaming TTS Client (Phase 3) -> Streaming Audio
 * Player (Phase 4) -> automatic play, per spec.md §3's "Speak = Generate +
 * Play" anchored to first-playable-audio rather than full completion.
 * Phase 6: full Pause/Resume/Replay/Stop wiring, the Speak-while-active
 * interrupt-and-restart routine (spec.md §7.3), and generationStatus
 * correctly returning to 'idle' after Stop (review ②).
 * Phase 7: localStorage persistence (plan.md §17) and the full error
 * catalogue (plan.md §18) surfaced inline near Speak/Player.
 * Phase 11: the optional Translated Speak path (spec.md §9) — a thin
 * handleSpeak() dispatcher branching to the unchanged handleDirectSpeak()
 * (renamed, zero logic change) or the new handleTranslatedSpeak(), per
 * plan.md §7's double-teardown/guard-ordering correction: the dispatcher
 * itself performs no guards and no teardown — each handler independently
 * owns its own guard sequence and its own single teardownCurrentRound()
 * call, exactly mirroring handleDirectSpeak's existing structure.
 */

import {
  getState,
  subscribe,
  setSpeechText,
  setVoiceProfiles,
  setSelectedVoiceProfileId,
  setSpeed,
  setVolume,
  setPitch,
  setGenerationStatus,
  setPlaybackStatus,
  setPlaybackError,
  setTranslationEnabled,
  setTranslatedText,
} from './state.js';
import { loadConfiguration, formatLanguageCapability } from './voice-profiles.js';
import { StreamingTTSClient } from './tts-client.js';
import { StreamingAudioPlayer } from './streaming-audio-player.js';
import { streamTranslation, extractCompletedSentences, TranslationError } from './translation-client.js';
import { updateTranslationAvailability } from './settings-client.js';
import {
  loadPersistedPreferences,
  persistSelectedVoiceProfileId,
  persistSpeed,
  persistVolume,
  persistPitch,
  persistSpeechText,
  persistTranslationEnabled,
} from './persistence.js';

const speechTextEl = document.getElementById('speech-text');
const speakBtn = document.getElementById('speak-btn');
const pauseBtn = document.getElementById('pause-btn');
const resumeBtn = document.getElementById('resume-btn');
const replayBtn = document.getElementById('replay-btn');
const stopBtn = document.getElementById('stop-btn');
const statusLineEl = document.getElementById('status-line');
const statusTextEl = document.getElementById('status-text');
const voiceSelectEl = document.getElementById('voice-select');
const voiceLanguageBadgeEl = document.getElementById('voice-language-badge');
const speedInputEl = document.getElementById('speed-input');
const volumeInputEl = document.getElementById('volume-input');
const pitchInputEl = document.getElementById('pitch-input');
const errorBannerEl = document.getElementById('error-banner');
const generationErrorEl = document.getElementById('generation-error');
const generationErrorTextEl = document.getElementById('generation-error-text');
const generationErrorRetryBtn = document.getElementById('generation-error-retry');
const playbackErrorEl = document.getElementById('playback-error');
const translationToggleEl = document.getElementById('translation-toggle');
const translatedTextPanelEl = document.getElementById('translated-text-panel');
const translatedTextDisplayEl = document.getElementById('translated-text-display');

// Set once configuration loading finishes (T2.7) — when true, the
// workspace stays permanently disabled because there is no usable
// Provider Configuration / Voice Profile to operate on.
let configurationFailed = false;

// One StreamingTTSClient instance for the page's lifetime, created once
// Provider Configuration has loaded successfully — it owns its own
// WebSocket connection/session lifecycle internally (Phase 3).
let ttsClient = null;

// The StreamingAudioPlayer for whichever Speak round is currently active
// (or just finished) — Phase 6 (T6.4/T6.5) will be the one to dispose()
// and replace this on Stop / regenerate. Phase 5 does not yet do so.
let currentPlayer = null;

// performance.now() at the moment Speak was clicked, read by the current
// round's player.onPlaying callback to log TTFA (review ⑤ — measured to
// the real 'playing' event, not to play() being called).
let speakClickedAt = null;

// True only while the current round's automatic play() has been blocked
// by the browser's autoplay policy and is waiting on a manual click
// (T5.7). This is deliberately kept as local module state here rather
// than added to state.js's documented schema (plan.md §8) — it's a
// transient UI condition tied to the current player instance, not part
// of the generation/playback state machines plan.md defines.
let awaitingManualPlay = false;

// True only once the current round has both fully completed generation
// AND has not been Stop'd/superseded since (T6.3) — the sole gate on
// Replay. Also kept as local module state for the same reason as
// awaitingManualPlay above: it's derived UI-availability, not one of
// plan.md §8's two state machines itself.
let replayAvailable = false;

// Base URL for the dedicated Node server's API (plan.md §8.3/§9.1), captured once
// loadConfiguration() resolves. '' (same-origin) unless a DEV_SERVER_BASE_URL_OVERRIDE
// is set in config/voice-config.local.js for the co-located dev phase.
let serverBaseUrl = '';

// The AbortController for whichever Translated Speak round's translation fetch is
// currently in flight (Phase 11, plan.md §7.3) — null whenever no Translated Speak round
// is active. teardownCurrentRound() aborts this before proceeding with its existing
// player/session teardown steps, which is also what triggers the dedicated server's own
// prompt upstream-abort handling (Phase 10, T10.3).
let currentTranslationAbort = null;

function statusLabel(state) {
  const { generationStatus, playbackStatus, translationEnabled, translatedText } = state;
  // Player-facing states take priority once something is happening;
  // otherwise fall back to the generation-facing label (spec.md §6.1/§7.2
  // — these are two independent state machines, this is purely a display
  // choice about which one is more informative to show right now).
  if (playbackStatus === 'buffering') {
    // Display-only refinement (plan.md §7.4, T11.9) — not a new state value; every other
    // piece of code still only ever sees playbackStatus: 'buffering'. Translating covers
    // the window before any TTS chunk (and therefore no translated text) has arrived yet.
    if (translationEnabled && generationStatus === 'generating' && !translatedText) {
      return 'Translating…';
    }
    return 'Buffering';
  }
  if (playbackStatus === 'playing') return 'Playing';
  if (playbackStatus === 'paused') return 'Paused';
  if (generationStatus === 'generating') return 'Generating';
  if (generationStatus === 'error') return 'Error';
  return 'Idle';
}

function findSelectedProfile(state) {
  return state.voiceProfiles.find((p) => p.id === state.selectedVoiceProfileId) || null;
}

function renderVoiceSelect(state) {
  // Rebuilding options from state on every render is simple and safe here:
  // state.voiceProfiles is only populated once at startup (Phase 2), so
  // this never fights an in-progress user interaction the way re-forcing
  // a text/number input's value on every render would (see speed/volume
  // handling below, which is intentionally NOT done this way).
  const previousValue = voiceSelectEl.value;
  voiceSelectEl.innerHTML = '';

  if (state.voiceProfiles.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No voice configured';
    voiceSelectEl.appendChild(opt);
    voiceSelectEl.value = '';
    voiceLanguageBadgeEl.hidden = true;
    return;
  }

  for (const profile of state.voiceProfiles) {
    const opt = document.createElement('option');
    opt.value = profile.id;
    opt.textContent = profile.name;
    voiceSelectEl.appendChild(opt);
  }
  voiceSelectEl.value = state.selectedVoiceProfileId || previousValue;

  const selected = findSelectedProfile(state);
  if (selected) {
    voiceLanguageBadgeEl.hidden = false;
    voiceLanguageBadgeEl.textContent = formatLanguageCapability(selected.languageCapability);
  } else {
    voiceLanguageBadgeEl.hidden = true;
  }
}

function render(state) {
  // Pause only makes sense while audio is actually playing (spec §7.1/§7.2).
  pauseBtn.disabled = state.playbackStatus !== 'playing';

  // Resume/Play is enabled either as the autoplay-blocked manual-Play
  // affordance (T5.7) or, per T6.2, to resume from a user-initiated
  // Pause — both land on the same player.resume() call.
  resumeBtn.disabled = !(awaitingManualPlay || state.playbackStatus === 'paused');

  // Replay is only guaranteed once this round's generation has fully
  // completed and hasn't been Stop'd/superseded since (spec §7.1, T6.3) —
  // NOT simply "generationStatus is currently 'completed'", since Stop
  // resets generationStatus to 'idle' (T6.4) but a stray 'completed' read
  // from a *new* round already having failed shouldn't re-enable it either.
  replayBtn.disabled = !replayAvailable;

  // Stop is meaningful whenever there's an active or just-finished round
  // to tear down — i.e. anything other than true idle/nothing-happened.
  stopBtn.disabled = state.generationStatus !== 'generating' && state.playbackStatus === 'stopped';

  // Speak is only ever disabled for empty Speech Text (spec.md §18 —
  // "Empty Speech Text") or, at this stage, a failed configuration load
  // (T2.7 — no usable Voice Profile to speak with). It must never be
  // disabled merely because a round is in progress (tasks.md review
  // correction ①) — that behavior isn't wired until Phase 5/6.
  speakBtn.disabled = configurationFailed || state.speechText.trim().length === 0;

  statusLineEl.dataset.generationStatus = state.generationStatus;
  statusLineEl.dataset.playbackStatus = state.playbackStatus;
  statusTextEl.textContent = statusLabel(state);

  renderVoiceSelect(state);

  // Translated Text panel (Phase 11, T11.6, plan.md §12): DOM-present but hidden unless
  // translation is on and this round has actually produced translated output — no layout
  // shift for the common Direct-Speak case (spec.md §11).
  translatedTextPanelEl.hidden = !(state.translationEnabled && state.translatedText.length > 0);
  translatedTextDisplayEl.textContent = state.translatedText;

  // T7.4 — TTS connection/generation/timeout failures all funnel through
  // generationError (plan §18's three rows share the same recovery
  // action in this implementation: Retry re-issues Speak from scratch).
  // Since Phase 11 (plan §7.4), generationError.type also disambiguates
  // 'translation-failed' from the pre-existing 'tts-generation-failed' —
  // same element, same field, just a copy prefix that varies by type.
  if (state.generationStatus === 'error' && state.generationError) {
    generationErrorEl.hidden = false;
    const prefix = state.generationError.type === 'translation-failed' ? 'Translation error: ' : '';
    generationErrorTextEl.textContent = `${prefix}${state.generationError.message}`;
  } else {
    generationErrorEl.hidden = true;
  }

  // Streaming Playback Failed — surfaced independently of generationError
  // (plan §8/§18: generation may still be proceeding in the background
  // while playback itself has failed). No dedicated retry button here —
  // Stop then Speak (already fully wired, Phase 6) is the recovery path,
  // per plan §18's "suggest Stop then Speak again".
  if (state.playbackError) {
    playbackErrorEl.hidden = false;
    playbackErrorEl.textContent = `Playback error: ${state.playbackError.message}`;
  } else {
    playbackErrorEl.hidden = true;
  }
}

function showConfigurationError(error) {
  configurationFailed = true;
  errorBannerEl.hidden = false;
  errorBannerEl.textContent = `Configuration error: ${error.message}`;
  voiceSelectEl.disabled = true;
  speedInputEl.disabled = true;
  volumeInputEl.disabled = true;
}

/**
 * @param {object} profile
 * @param {{speed?: number, volume?: number, pitch?: number}} [overrides] persisted values
 *   (T7.3) take priority over the profile's own defaults when present.
 */
function applyProfileDefaults(profile, overrides = {}) {
  if (!profile) return;
  // Deliberately set imperatively here, once, rather than inside render()
  // — render() runs on every state change (including on every keystroke
  // in these same inputs via their own input listeners below), and
  // forcing el.value from state on every render would fight the user
  // mid-edit. This function only runs on startup and on profile change.
  const speed = overrides.speed ?? profile.speed;
  const volume = overrides.volume ?? profile.volume;
  // Pitch (speaking-style plan.md §5.2/§7): same override-then-profile-then-neutral
  // fallback chain as speed/volume, ending at 0 (neutral) rather than an assumed profile
  // field, since pitch is optional on VoiceProfile (T15.3).
  const pitch = overrides.pitch ?? profile.pitch ?? 0;
  speedInputEl.value = String(speed);
  volumeInputEl.value = String(volume);
  pitchInputEl.value = String(pitch);
  setSpeed(speed);
  setVolume(volume);
  setPitch(pitch);
}

/**
 * Tears down whatever the current round is (if anything) — shared by the
 * Stop button (T6.4) and the Speak-while-active interrupt-and-restart
 * routine (T6.5), per plan.md §9's own reasoning: the chain-release
 * correctness concern (Phase 3, T3.5) only needs to be gotten right once.
 *
 * player.stop() (Phase 4) already performs "pause + reset position +
 * dispose MediaSource/SourceBuffer/Object URL" as one cohesive call —
 * T6.4's numbered steps 1 and 3 are both satisfied by this single call,
 * not two separate app.js-level calls to player.stop() and
 * player.dispose(); the net effect (spec §7.1's "同时清理 MediaSource /
 * SourceBuffer / streaming buffer") is identical either way.
 */
async function teardownCurrentRound() {
  const wasGenerating = getState().generationStatus === 'generating';

  // Phase 11 (T11.7, plan.md §7.3): abort an in-flight Translated Speak translation fetch
  // *before* the existing player/session teardown steps below — this is what lets Stop
  // and the Speak-while-active interrupt-and-restart routine cleanly interrupt a
  // Translated Speak round exactly as they already interrupt a Direct Speak round's TTS
  // session, and is also what triggers the dedicated server's own prompt upstream-abort
  // handling (Phase 10, T10.3) on the next tick.
  if (currentTranslationAbort) {
    currentTranslationAbort.abort();
    currentTranslationAbort = null;
  }

  if (currentPlayer) {
    currentPlayer.stop();
    currentPlayer = null;
  }

  if (wasGenerating && ttsClient) {
    // Forces a disconnect before releasing the chain (Phase 3, T3.5a) —
    // the next beginSession() naturally waits on tts-client.js's own
    // _synthChain, so awaiting this here isn't strictly required for
    // correctness, but keeps this function's own control flow linear.
    await ttsClient.cancelSession();
  }

  awaitingManualPlay = false;
  replayAvailable = false;
  // Review ②: 'idle', never "leave generationStatus as-is" — after a
  // teardown there is no active or valid round of any kind, whether it
  // was mid-generation or already 'completed'.
  setGenerationStatus('idle');
  setPlaybackStatus('stopped');
  // T7.6 — a stale playback error from the torn-down round shouldn't
  // linger once it's gone; this covers both the Stop button and the
  // Speak-while-active interrupt path (T6.5), since both call this
  // function before anything new starts.
  setPlaybackError(null);
}

/**
 * Speak dispatcher (Phase 11, T11.4). A pure branch with no side effects of its own — it
 * performs no guard checks and never calls teardownCurrentRound() itself. Each of
 * handleDirectSpeak/handleTranslatedSpeak independently owns its own guard sequence and
 * its own single teardownCurrentRound() call (see the double-teardown/guard-ordering
 * correction in this file's header comment and plan.md §7): if the dispatcher tore down
 * the current round before delegating, a Speak click that turns out to be a no-op (a
 * guard failing inside the delegated handler) would have already destroyed whatever round
 * was previously playing — a real regression, not merely a redundant call.
 */
function handleSpeak() {
  if (getState().translationEnabled) {
    return handleTranslatedSpeak();
  }
  return handleDirectSpeak();
}

/**
 * Direct Speak (T5.1-T5.8, T6.5) — renamed from the original handleSpeak() (Phase 11,
 * T11.4). Pure rename, zero logic change: this must stay byte-for-byte identical to the
 * already-verified Phase 1-8 behavior.
 */
async function handleDirectSpeak() {
  const state = getState();
  if (configurationFailed) return;
  const text = state.speechText.trim();
  if (!text) return; // T5.8 — Speak is only ever disabled for this via the button itself

  const profile = findSelectedProfile(state);
  if (!profile || !ttsClient) return; // defensive — shouldn't happen once configured (T2.7)

  // T6.5 — always tear down whatever the current round is first; a no-op
  // if nothing is active (currentPlayer is already null). This is what
  // makes review ①'s "Speak stays clickable during Generating" actually
  // work: re-clicking Speak mid-round cancels the old one and starts
  // fresh, rather than being blocked or starting a second concurrent
  // session (tts-client.js only ever supports one).
  await teardownCurrentRound();

  awaitingManualPlay = false;
  speakClickedAt = performance.now();
  setGenerationStatus('generating');
  setPlaybackStatus('buffering');

  const player = new StreamingAudioPlayer({
    onPlaying: () => {
      const ttfa = Math.round(performance.now() - speakClickedAt);
      console.log(`[TTFA] ${ttfa}ms`); // dev-console only (spec.md §6.2) — no UI element, no SLA
      if (awaitingManualPlay) {
        awaitingManualPlay = false;
        render(getState());
      }
    },
    onAutoplayBlocked: () => {
      awaitingManualPlay = true;
      render(getState());
    },
    onError: (error) => {
      setPlaybackError(error);
    },
    onStatusChange: (status) => {
      setPlaybackStatus(status);
    },
  });
  currentPlayer = player;

  try {
    await ttsClient.beginSession(
      { speaker: profile.speakerId, speed: state.speed, volume: state.volume, pitch: state.pitch, useTTS2: true },
      { onChunk: (bytes) => player.appendChunk(bytes) }
    );
    await ttsClient.pushText(text);
    // endSession()'s Promise is gated on the provider's SessionFinished
    // (Phase 3, review ⑦) — generationStatus only ever becomes 'completed'
    // in reaction to it resolving, never merely because this call was made.
    await ttsClient.endSession();

    // Staleness guard: if Stop (T6.4) or a fresh Speak (T6.5) superseded
    // this round while the awaits above were in flight, currentPlayer no
    // longer points at this round's player — tts-client.js's endSession()
    // silently no-ops on an already-cancelled session (Phase 3), so
    // without this check a Stop that landed mid-flight could have its
    // correct 'idle' reset clobbered back to 'completed' by this stale
    // continuation resuming afterwards.
    if (currentPlayer !== player) return;

    replayAvailable = true;
    setGenerationStatus('completed');
    player.end();
  } catch (err) {
    if (currentPlayer !== player) return; // same staleness guard for the failure path
    console.error('[Voice Copilot] Speak failed:', err);
    setGenerationStatus('error', { type: 'tts-generation-failed', message: err.message });
  }
}

/**
 * Translated Speak (Phase 11, T11.5, spec.md §9, plan.md §7.2) — a full sibling of
 * handleDirectSpeak, not a continuation that assumes teardown already happened:
 * independently guards, then tears down, then runs LLM Streaming Translation ->
 * Streaming TTS. Player construction, callback wiring, staleness guards, and completion
 * handling are deliberately copy-identical to handleDirectSpeak's pattern (kept as literal
 * duplication rather than a shared helper, so handleDirectSpeak's own body stays a true,
 * untouched "pure rename" — see this file's header comment).
 */
async function handleTranslatedSpeak() {
  const state = getState();
  if (configurationFailed) return;
  const text = state.speechText.trim();
  if (!text) return;

  const profile = findSelectedProfile(state);
  if (!profile || !ttsClient) return;

  // This handler's own single teardownCurrentRound() call (T11.4/T11.5) — the dispatcher
  // above never calls this itself.
  await teardownCurrentRound();

  awaitingManualPlay = false;
  setTranslatedText(''); // cleared at the start of every Speak round (plan.md §11)
  speakClickedAt = performance.now();
  setGenerationStatus('generating');
  setPlaybackStatus('buffering');

  const player = new StreamingAudioPlayer({
    onPlaying: () => {
      const ttfa = Math.round(performance.now() - speakClickedAt);
      console.log(`[TTFA] ${ttfa}ms`); // dev-console only (spec.md §6.2) — no UI element, no SLA
      if (awaitingManualPlay) {
        awaitingManualPlay = false;
        render(getState());
      }
    },
    onAutoplayBlocked: () => {
      awaitingManualPlay = true;
      render(getState());
    },
    onError: (error) => {
      setPlaybackError(error);
    },
    onStatusChange: (status) => {
      setPlaybackStatus(status);
    },
  });
  currentPlayer = player;

  // Tracks whether ttsClient.beginSession() has actually succeeded, so the catch block
  // below knows whether there's a real session to cancelSession() (T11.5 step 6/T11.8) —
  // correctness-critical, not optional cleanup: a translation-stream failure can happen
  // after a TTS session was already opened with zero or only partial text pushed, and
  // nothing else in this path calls endSession()/cancelSession() for it if we stop here,
  // which would leave tts-client.js's _synthChain permanently unreleased (the same class
  // of silent-hang bug Phase 6 already found and fixed once for a different trigger).
  let ttsSessionOpen = false;

  const translationAbort = new AbortController();
  currentTranslationAbort = translationAbort;

  try {
    await ttsClient.beginSession(
      { speaker: profile.speakerId, speed: state.speed, volume: state.volume, pitch: state.pitch, useTTS2: true },
      { onChunk: (bytes) => player.appendChunk(bytes) }
    );
    ttsSessionOpen = true;

    let sentenceBuffer = '';
    let translatedSoFar = '';
    for await (const { content } of streamTranslation(text, {
      signal: translationAbort.signal,
      serverBaseUrl,
    })) {
      if (currentPlayer !== player) return; // staleness guard, same pattern as Direct Speak

      translatedSoFar += content;
      setTranslatedText(translatedSoFar); // live update of the read-only Translated Text area (§12)

      sentenceBuffer += content;
      const { sentences, remainder } = extractCompletedSentences(sentenceBuffer);
      for (const sentence of sentences) {
        await ttsClient.pushText(sentence);
      }
      sentenceBuffer = remainder;
    }

    if (currentPlayer !== player) return;
    if (sentenceBuffer.trim()) {
      await ttsClient.pushText(sentenceBuffer.trim()); // flush trailing partial sentence
    }

    // Same completion semantics as Direct Speak (review ⑦, unchanged) — gated on the
    // provider's SessionFinished, not on request-send.
    await ttsClient.endSession();
    ttsSessionOpen = false;

    if (currentPlayer !== player) return;

    replayAvailable = true;
    setGenerationStatus('completed');
    player.end();
  } catch (err) {
    if (currentPlayer !== player) return; // same staleness guard for the failure path

    console.error('[Voice Copilot] Translated Speak failed:', err);

    // Correctness-critical cleanup (T11.5 step 6 / T11.8) — see the ttsSessionOpen comment
    // above for why this must happen unconditionally, regardless of which branch
    // (translation or TTS) failed.
    if (ttsSessionOpen) {
      await ttsClient.cancelSession();
    }
    player.dispose();
    currentPlayer = null;
    setPlaybackStatus('stopped');

    if (err instanceof TranslationError) {
      setGenerationStatus('error', { type: 'translation-failed', message: err.message });
    } else {
      setGenerationStatus('error', { type: 'tts-generation-failed', message: err.message });
    }
  } finally {
    if (currentTranslationAbort === translationAbort) {
      currentTranslationAbort = null;
    }
  }
}

speakBtn.addEventListener('click', () => {
  handleSpeak();
});

resumeBtn.addEventListener('click', () => {
  // Serves both T5.7 (manual Play after an autoplay block) and T6.2
  // (resume after a user-initiated Pause) — both are just player.resume().
  currentPlayer?.resume();
});

pauseBtn.addEventListener('click', () => {
  // T6.1 — pause() only touches local playback; it never gates
  // appendChunk() (Phase 4), so chunk reception keeps buffering in the
  // background while paused (spec §7.1).
  currentPlayer?.pause();
});

replayBtn.addEventListener('click', () => {
  // T6.3 — button is only enabled while replayAvailable is true; guarded
  // again here in case of a stray click racing a state transition.
  if (!replayAvailable) return;
  currentPlayer?.replay();
});

stopBtn.addEventListener('click', () => {
  // T6.4 — same teardown routine T6.5 uses for interrupt-and-restart.
  teardownCurrentRound();
});

speechTextEl.addEventListener('input', () => {
  setSpeechText(speechTextEl.value);
  persistSpeechText(speechTextEl.value);
});

voiceSelectEl.addEventListener('change', () => {
  setSelectedVoiceProfileId(voiceSelectEl.value);
  persistSelectedVoiceProfileId(voiceSelectEl.value);
  applyProfileDefaults(findSelectedProfile(getState()));
});

speedInputEl.addEventListener('input', () => {
  const value = parseFloat(speedInputEl.value);
  if (!Number.isNaN(value)) {
    setSpeed(value);
    persistSpeed(value);
  }
});

volumeInputEl.addEventListener('input', () => {
  const value = parseFloat(volumeInputEl.value);
  if (!Number.isNaN(value)) {
    setVolume(value);
    persistVolume(value);
  }
});

pitchInputEl.addEventListener('input', () => {
  const value = parseFloat(pitchInputEl.value);
  if (!Number.isNaN(value)) {
    setPitch(value);
    persistPitch(value);
  }
});

generationErrorRetryBtn.addEventListener('click', () => {
  handleSpeak(); // re-reads state.speechText fresh — same text, same profile, tried again
});

translationToggleEl.addEventListener('change', () => {
  setTranslationEnabled(translationToggleEl.checked);
  persistTranslationEnabled(translationToggleEl.checked);
});

// T7.3 — restore the persisted Speech Text draft immediately on load,
// independent of configuration loading (which can fail or take a moment).
const persisted = loadPersistedPreferences();
if (persisted.speechText) {
  speechTextEl.value = persisted.speechText;
  setSpeechText(persisted.speechText);
}
// Phase 11 (plan.md §11) — restore the "Chinese -> English" toggle the same way; default
// false (spec.md §9.1), same persistence pattern as speed/volume.
translationToggleEl.checked = persisted.translationEnabled;
setTranslationEnabled(persisted.translationEnabled);

subscribe(render);
render(getState());

loadConfiguration().then((result) => {
  // Captured on both branches — Settings (Phase 12) needs this to reach the dedicated
  // server regardless of whether TTS configuration itself is currently valid.
  serverBaseUrl = result.serverBaseUrl;
  updateTranslationAvailability(serverBaseUrl); // plan.md §10.1 — gates the main "Chinese -> English" toggle

  if (!result.ok) {
    showConfigurationError(result.error);
    return;
  }
  setVoiceProfiles(result.voiceProfiles);
  // T7.3 — prefer the persisted Voice Profile if it still exists among
  // the loaded profiles; otherwise fall back to the first configured one.
  const defaultProfile =
    result.voiceProfiles.find((p) => p.id === persisted.selectedVoiceProfileId) || result.voiceProfiles[0];
  setSelectedVoiceProfileId(defaultProfile.id);
  applyProfileDefaults(defaultProfile, {
    speed: persisted.speed ?? undefined,
    volume: persisted.volume ?? undefined,
    pitch: persisted.pitch ?? undefined,
  });
  ttsClient = new StreamingTTSClient(result.providerConfiguration);
});
