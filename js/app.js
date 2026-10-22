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
 * Natural Delivery (specs/voice-copilot-natural-delivery): a Delivery level that shapes
 * both the TTS payload and the LLM text, an opt-in Humanize (same-language spoken rewrite)
 * for Direct Speak, and word-safe incremental pushes on the LLM paths — see that spec's
 * research.md for the measurements behind each choice.
 * Phase 11: the optional Translated Speak path (spec.md §9) — a thin
 * handleSpeak() dispatcher branching to the unchanged handleDirectSpeak()
 * (renamed, zero logic change) or the new handleTranslatedSpeak() (now handleLlmSpeak(mode)), per
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
  setStylePreset,
  setDelivery,
  setHumanizeEnabled,
} from './state.js';
import { loadConfiguration, formatLanguageCapability } from './voice-profiles.js';
import { StreamingTTSClient } from './tts-client.js';
import { StreamingAudioPlayer } from './streaming-audio-player.js';
import { streamTranslation, TranslationError } from './translation-client.js';
import { createSpeakableChunker } from './delivery.js';
import { updateTranslationAvailability } from './settings-client.js';
import { loadMyStyleProfile } from './speaking-style.js';
import { AudioBridgeClient } from './audio-bridge-client.js';
import {
  loadPersistedPreferences,
  persistSelectedVoiceProfileId,
  persistSpeed,
  persistVolume,
  persistPitch,
  persistSpeechText,
  persistTranslationEnabled,
  persistStylePreset,
  persistAudioBridgeEnabled,
  persistDelivery,
  persistHumanizeEnabled,
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
const stylePresetEl = document.getElementById('style-preset-select');
const stylePresetRowEl = document.getElementById('style-preset-row');
const translatedTextPanelEl = document.getElementById('translated-text-panel');
const translatedTextDisplayEl = document.getElementById('translated-text-display');
const translatedTextLabelEl = document.getElementById('translated-text-label');
const deliverySelectEl = document.getElementById('delivery-select');
const humanizeRowEl = document.getElementById('humanize-row');
const humanizeToggleEl = document.getElementById('humanize-toggle');
const audioBridgeToggleEl = document.getElementById('audio-bridge-toggle');
const audioBridgeStatusEl = document.getElementById('audio-bridge-status');

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

// Which LLM mode produced the current state.translatedText ('translate' | 'rewrite'), or
// null for a Direct Speak round — drives the text panel's label/visibility and the
// status/error wording. Local module state for the same reason as awaitingManualPlay.
let lastLlmMode = null;

/**
 * Which Speak path the current settings select (natural-delivery spec.md §3.2): Chinese ->
 * English always goes through the LLM; Direct Speak only does when the user explicitly
 * opted into Humanize AND Delivery isn't Off. Otherwise the text is spoken verbatim.
 * @returns {'translate' | 'rewrite' | null}
 */
function llmModeFor(state) {
  if (state.translationEnabled) return 'translate';
  if (state.humanizeEnabled && state.delivery !== 'off') return 'rewrite';
  return null;
}

// Audio Bridge producer (docs/teams-web-audio-injection-spec.md Phase 1) — forwards each
// round's Audio Chunks to the local bridge alongside, never instead of, local playback.
// Connected only while the "Audio Bridge" toggle is on; every call below is a silent no-op
// otherwise, so the Speak flow behaves exactly as before with the toggle off.
const AUDIO_BRIDGE_STATUS_LABELS = {
  DISCONNECTED: 'Offline',
  CONNECTING: 'Connecting…',
  IDLE: 'Connected',
  STREAMING: 'Sending',
};
const audioBridge = new AudioBridgeClient({
  role: 'producer',
  onStateChange: (bridgeState) => {
    audioBridgeStatusEl.textContent = AUDIO_BRIDGE_STATUS_LABELS[bridgeState];
  },
});

function setAudioBridgeEnabled(enabled) {
  audioBridgeStatusEl.hidden = !enabled;
  if (enabled) audioBridge.connect();
  else audioBridge.disconnect();
}

// Fan-out used as each round's onChunk: local player first, bridge second.
function forwardChunk(player, bytes) {
  player.appendChunk(bytes);
  audioBridge.sendChunk(bytes);
}

function statusLabel(state) {
  const { generationStatus, playbackStatus, translatedText } = state;
  // Player-facing states take priority once something is happening;
  // otherwise fall back to the generation-facing label (spec.md §6.1/§7.2
  // — these are two independent state machines, this is purely a display
  // choice about which one is more informative to show right now).
  if (playbackStatus === 'buffering') {
    // Display-only refinement (plan.md §7.4, T11.9) — not a new state value; every other
    // piece of code still only ever sees playbackStatus: 'buffering'. Translating covers
    // the window before any TTS chunk (and therefore no translated text) has arrived yet.
    if (lastLlmMode && generationStatus === 'generating' && !translatedText) {
      return lastLlmMode === 'rewrite' ? 'Rewriting…' : 'Translating…';
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
  // Natural Delivery: the same panel also shows a Humanize rewrite ("Spoken Text"); it stays
  // visible only while the current settings still select the mode that produced it.
  translatedTextPanelEl.hidden = !(
    lastLlmMode && llmModeFor(state) === lastLlmMode && state.translatedText.length > 0
  );
  translatedTextLabelEl.textContent = lastLlmMode === 'rewrite' ? 'Spoken Text' : 'Translated Text';
  translatedTextDisplayEl.textContent = state.translatedText;

  // Humanize only applies to Direct Speak — Translated Speak already produces spoken text.
  humanizeRowEl.hidden = state.translationEnabled;
  humanizeToggleEl.disabled = state.delivery === 'off';

  // Speaking Style row (speaking-style spec.md §6.2/§8, plan.md §6.2): hidden — not merely
  // disabled — when translation is off, since Style has zero effect on Direct Speak. Same
  // hidden-when-irrelevant pattern as the Translated Text panel above.
  stylePresetRowEl.hidden = !state.translationEnabled;

  // T7.4 — TTS connection/generation/timeout failures all funnel through
  // generationError (plan §18's three rows share the same recovery
  // action in this implementation: Retry re-issues Speak from scratch).
  // Since Phase 11 (plan §7.4), generationError.type also disambiguates
  // 'translation-failed' from the pre-existing 'tts-generation-failed' —
  // same element, same field, just a copy prefix that varies by type.
  if (state.generationStatus === 'error' && state.generationError) {
    generationErrorEl.hidden = false;
    const prefix =
      state.generationError.type === 'translation-failed'
        ? lastLlmMode === 'rewrite' ? 'Rewrite error: ' : 'Translation error: '
        : '';
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
  audioBridge.abortStream();

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
 * handleDirectSpeak/handleLlmSpeak independently owns its own guard sequence and
 * its own single teardownCurrentRound() call (see the double-teardown/guard-ordering
 * correction in this file's header comment and plan.md §7): if the dispatcher tore down
 * the current round before delegating, a Speak click that turns out to be a no-op (a
 * guard failing inside the delegated handler) would have already destroyed whatever round
 * was previously playing — a real regression, not merely a redundant call.
 */
function handleSpeak() {
  const mode = llmModeFor(getState());
  if (mode) {
    return handleLlmSpeak(mode);
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
  lastLlmMode = null;
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
  audioBridge.beginStream({ startedAt: performance.timeOrigin + speakClickedAt });

  try {
    await ttsClient.beginSession(
      { speaker: profile.speakerId, speed: state.speed, volume: state.volume, pitch: state.pitch, delivery: state.delivery },
      { onChunk: (bytes) => forwardChunk(player, bytes) }
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
    audioBridge.endStream();
  } catch (err) {
    if (currentPlayer !== player) return; // same staleness guard for the failure path
    audioBridge.abortStream();
    console.error('[Voice Copilot] Speak failed:', err);
    setGenerationStatus('error', { type: 'tts-generation-failed', message: err.message });
  }
}

/**
 * LLM Speak — Translated Speak (Phase 11, T11.5, spec.md §9, plan.md §7.2) and, since
 * Natural Delivery, Humanize (`mode === 'rewrite'`, same-language spoken rewrite). The two
 * differ only in the request's `mode`; everything below is shared. A full sibling of
 * handleDirectSpeak, not a continuation that assumes teardown already happened:
 * independently guards, then tears down, then runs LLM Streaming Translation ->
 * Streaming TTS. Player construction, callback wiring, staleness guards, and completion
 * handling are deliberately copy-identical to handleDirectSpeak's pattern (kept as literal
 * duplication rather than a shared helper, so handleDirectSpeak's own body stays a true,
 * untouched "pure rename" — see this file's header comment).
 */
async function handleLlmSpeak(mode) {
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
  lastLlmMode = mode;
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
  audioBridge.beginStream({ startedAt: performance.timeOrigin + speakClickedAt });

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
      { speaker: profile.speakerId, speed: state.speed, volume: state.volume, pitch: state.pitch, delivery: state.delivery },
      { onChunk: (bytes) => forwardChunk(player, bytes) }
    );
    ttsSessionOpen = true;

    // Natural Delivery (spec.md §3.3): push word-safe chunks as soon as they arrive rather
    // than whole sentences — the provider segments sentences itself with lookahead, and
    // app-side sentence batching both delayed audio and broke cross-sentence prosody
    // (research.md E4/E4b).
    const chunker = createSpeakableChunker();
    let translatedSoFar = '';
    // Speaking Style (speaking-style spec.md §4, plan.md §4.5): stylePreset always
    // accompanies the request; myStyle is only loaded (and only meaningful server-side)
    // when stylePreset === 'my-style' — no change to the streaming/staleness-guard/
    // cleanup control flow below, this is purely a request-body addition to a call site
    // that already exists.
    const myStyle = mode === 'translate' && state.stylePreset === 'my-style' ? loadMyStyleProfile() : undefined;
    for await (const { content } of streamTranslation(text, {
      signal: translationAbort.signal,
      serverBaseUrl,
      stylePreset: state.stylePreset,
      myStyle,
      delivery: state.delivery,
      mode,
    })) {
      if (currentPlayer !== player) return; // staleness guard, same pattern as Direct Speak

      translatedSoFar += content;
      setTranslatedText(translatedSoFar); // live update of the read-only Translated Text area (§12)

      for (const chunk of chunker.push(content)) {
        await ttsClient.pushText(chunk);
      }
    }

    if (currentPlayer !== player) return;
    const tail = chunker.flush();
    if (tail) {
      await ttsClient.pushText(tail); // flush trailing partial word
    }

    // Same completion semantics as Direct Speak (review ⑦, unchanged) — gated on the
    // provider's SessionFinished, not on request-send.
    await ttsClient.endSession();
    ttsSessionOpen = false;

    if (currentPlayer !== player) return;

    replayAvailable = true;
    setGenerationStatus('completed');
    player.end();
    audioBridge.endStream();
  } catch (err) {
    if (currentPlayer !== player) return; // same staleness guard for the failure path

    console.error(`[Voice Copilot] ${mode === 'rewrite' ? 'Humanized' : 'Translated'} Speak failed:`, err);

    // Correctness-critical cleanup (T11.5 step 6 / T11.8) — see the ttsSessionOpen comment
    // above for why this must happen unconditionally, regardless of which branch
    // (translation or TTS) failed.
    if (ttsSessionOpen) {
      await ttsClient.cancelSession();
    }
    player.dispose();
    currentPlayer = null;
    audioBridge.abortStream();
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

stylePresetEl.addEventListener('change', () => {
  setStylePreset(stylePresetEl.value);
  persistStylePreset(stylePresetEl.value);
});

deliverySelectEl.addEventListener('change', () => {
  setDelivery(deliverySelectEl.value);
  persistDelivery(deliverySelectEl.value);
});

humanizeToggleEl.addEventListener('change', () => {
  setHumanizeEnabled(humanizeToggleEl.checked);
  persistHumanizeEnabled(humanizeToggleEl.checked);
});

audioBridgeToggleEl.addEventListener('change', () => {
  setAudioBridgeEnabled(audioBridgeToggleEl.checked);
  persistAudioBridgeEnabled(audioBridgeToggleEl.checked);
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

// Speaking Style (plan.md §6.2) — restore the same way; default 'natural' (spec.md §11),
// already allowlist-normalized by loadPersistedPreferences() (persistence.js).
stylePresetEl.value = persisted.stylePreset;
setStylePreset(persisted.stylePreset);

// Natural Delivery (plan.md §2.5) — restore the same way; defaults Natural / Humanize off,
// already allowlist-normalized by loadPersistedPreferences().
deliverySelectEl.value = persisted.delivery;
setDelivery(persisted.delivery);
humanizeToggleEl.checked = persisted.humanizeEnabled;
setHumanizeEnabled(persisted.humanizeEnabled);

// Audio Bridge — restore the persisted toggle; `?bridge=1` in the URL also turns it on
// (handy for a dedicated meeting tab) without changing the persisted preference.
const audioBridgeAutoConnect = new URLSearchParams(location.search).get('bridge') === '1';
audioBridgeToggleEl.checked = persisted.audioBridgeEnabled || audioBridgeAutoConnect;
setAudioBridgeEnabled(audioBridgeToggleEl.checked);

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
