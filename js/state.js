/**
 * Voice Copilot MVP — application state.
 *
 * Single flat state object, mutated only through the named actions exported
 * below (no ad hoc globals). Shape and enum values come directly from
 * plan.md §8 — do not add fields here without updating plan.md first.
 *
 * generationStatus and playbackStatus are two independent state machines
 * (spec.md §6.1 / §7.2) — they must never be merged into one field.
 */

const state = {
  speechText: '',

  voiceProfiles: [],
  selectedVoiceProfileId: null,
  speed: 1.0,
  volume: 1.0,

  generationStatus: 'idle', // 'idle' | 'generating' | 'completed' | 'error'
  // { type, message } | null — type is 'tts-generation-failed' or, since Phase 11's
  // Translated Speak (spec.md §9), 'translation-failed' (plan.md §7.4/§11) — same field,
  // no new state machine, just an additional value the error can carry.
  generationError: null,

  playbackStatus: 'stopped', // 'stopped' | 'buffering' | 'playing' | 'paused'
  playbackError: null, // { type, message } | null

  // §9's optional Chinese -> English toggle (plan.md §11) — default off, persisted like
  // speed/volume. Does not change generationStatus/playbackStatus's vocabulary (plan §7.4).
  translationEnabled: false,
  // Cleared at the start of every Speak round; only meaningful when translationEnabled was
  // true for that round. Read-only display data, never fed back into speechText
  // (spec.md §9.4) — not persisted (plan.md §11).
  translatedText: '',
};

const listeners = new Set();

function notify() {
  for (const listener of listeners) {
    listener(state);
  }
}

export function getState() {
  return state;
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setSpeechText(text) {
  state.speechText = text;
  notify();
}

export function setVoiceProfiles(profiles) {
  state.voiceProfiles = profiles;
  notify();
}

export function setSelectedVoiceProfileId(id) {
  state.selectedVoiceProfileId = id;
  notify();
}

export function setSpeed(speed) {
  state.speed = speed;
  notify();
}

export function setVolume(volume) {
  state.volume = volume;
  notify();
}

export function setGenerationStatus(status, error = null) {
  state.generationStatus = status;
  state.generationError = error;
  notify();
}

export function setPlaybackStatus(status, error = null) {
  state.playbackStatus = status;
  if (error !== null) {
    state.playbackError = error;
  }
  notify();
}

export function setPlaybackError(error) {
  state.playbackError = error;
  notify();
}

export function setTranslationEnabled(enabled) {
  state.translationEnabled = enabled;
  notify();
}

export function setTranslatedText(text) {
  state.translatedText = text;
  notify();
}
