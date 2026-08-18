/**
 * Voice Copilot MVP — localStorage persistence (plan.md §17).
 *
 * Persisted: selectedVoiceProfileId, speed, volume, a Speech Text
 * draft, and (since Phase 11, spec.md §9) the "Chinese -> English"
 * translationEnabled toggle — plain user preferences with no "confirmed"
 * semantics to go stale (unlike the old, discarded LLM-era design's Final
 * Text).
 *
 * Never persisted: credentials (live only in config/voice-config.local.js,
 * Phase 2, or the dedicated server's credential store, Phase 12), any
 * audio data (there is none to persist under the streaming architecture —
 * MediaSource/SourceBuffer state is inherently session-scoped), and
 * translatedText (transient per-round display data, plan.md §11).
 *
 * Keys are prefixed `voiceCopilot.` to avoid colliding with the existing
 * Live2D page's unprefixed localStorage keys (e.g. `selectedLive2DModel`,
 * `chatSessionId`).
 */

const KEYS = {
  selectedVoiceProfileId: 'voiceCopilot.selectedVoiceProfileId',
  speed: 'voiceCopilot.speed',
  volume: 'voiceCopilot.volume',
  speechText: 'voiceCopilot.speechText',
  translationEnabled: 'voiceCopilot.translationEnabled',
};

function safeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch (_) {
    // localStorage can throw in some privacy modes — persistence is a
    // convenience, never a hard requirement, so just behave as if unset.
    return null;
  }
}

function safeSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (_) {
    // ignore — see safeGet
  }
}

/**
 * @returns {{
 *   selectedVoiceProfileId: string | null,
 *   speed: number | null,
 *   volume: number | null,
 *   speechText: string,
 *   translationEnabled: boolean,
 * }}
 */
export function loadPersistedPreferences() {
  const speedRaw = safeGet(KEYS.speed);
  const volumeRaw = safeGet(KEYS.volume);
  const speed = speedRaw !== null ? parseFloat(speedRaw) : NaN;
  const volume = volumeRaw !== null ? parseFloat(volumeRaw) : NaN;
  return {
    selectedVoiceProfileId: safeGet(KEYS.selectedVoiceProfileId),
    speed: Number.isFinite(speed) ? speed : null,
    volume: Number.isFinite(volume) ? volume : null,
    speechText: safeGet(KEYS.speechText) || '',
    translationEnabled: safeGet(KEYS.translationEnabled) === 'true',
  };
}

export function persistSelectedVoiceProfileId(id) {
  safeSet(KEYS.selectedVoiceProfileId, id);
}

export function persistSpeed(speed) {
  safeSet(KEYS.speed, String(speed));
}

export function persistVolume(volume) {
  safeSet(KEYS.volume, String(volume));
}

export function persistSpeechText(text) {
  safeSet(KEYS.speechText, text);
}

export function persistTranslationEnabled(enabled) {
  safeSet(KEYS.translationEnabled, String(enabled));
}
