/**
 * Voice Copilot MVP — localStorage persistence (plan.md §17).
 *
 * Persisted: selectedVoiceProfileId, speed, volume, pitch, a Speech Text
 * draft, and (since Phase 11, spec.md §9) the "Chinese -> English"
 * translationEnabled toggle — plain user preferences with no "confirmed"
 * semantics to go stale (unlike the old, discarded LLM-era design's Final
 * Text). pitch (speaking-style spec.md §7, plan.md §5.4) follows the exact
 * same pattern as speed/volume.
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
  pitch: 'voiceCopilot.pitch',
  speechText: 'voiceCopilot.speechText',
  translationEnabled: 'voiceCopilot.translationEnabled',
  stylePreset: 'voiceCopilot.stylePreset',
};

// Speaking Style (speaking-style spec.md §4, plan.md §4.1) — only these four values are
// ever valid; anything else read back from localStorage (unset, corrupted, or a stale
// value from a since-removed preset) falls back to 'natural'. Mirrors the server-side
// allowlist in server/routes/translate.js's normalizeStylePreset() (same four values, same
// 'natural' fallback) so a corrupted/tampered localStorage value can never reach app.js's
// reactive state or the translate request as anything but one of the four known presets.
const VALID_STYLE_PRESETS = new Set(['natural', 'professional', 'concise', 'my-style']);

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
 *   pitch: number | null,
 *   speechText: string,
 *   translationEnabled: boolean,
 *   stylePreset: 'natural' | 'professional' | 'concise' | 'my-style',
 * }}
 */
export function loadPersistedPreferences() {
  const speedRaw = safeGet(KEYS.speed);
  const volumeRaw = safeGet(KEYS.volume);
  const pitchRaw = safeGet(KEYS.pitch);
  const speed = speedRaw !== null ? parseFloat(speedRaw) : NaN;
  const volume = volumeRaw !== null ? parseFloat(volumeRaw) : NaN;
  const pitch = pitchRaw !== null ? parseFloat(pitchRaw) : NaN;
  const stylePresetRaw = safeGet(KEYS.stylePreset);
  return {
    selectedVoiceProfileId: safeGet(KEYS.selectedVoiceProfileId),
    speed: Number.isFinite(speed) ? speed : null,
    volume: Number.isFinite(volume) ? volume : null,
    pitch: Number.isFinite(pitch) ? pitch : null,
    speechText: safeGet(KEYS.speechText) || '',
    translationEnabled: safeGet(KEYS.translationEnabled) === 'true',
    stylePreset: VALID_STYLE_PRESETS.has(stylePresetRaw) ? stylePresetRaw : 'natural',
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

export function persistPitch(pitch) {
  safeSet(KEYS.pitch, String(pitch));
}

export function persistSpeechText(text) {
  safeSet(KEYS.speechText, text);
}

export function persistTranslationEnabled(enabled) {
  safeSet(KEYS.translationEnabled, String(enabled));
}

export function persistStylePreset(preset) {
  safeSet(KEYS.stylePreset, preset);
}
