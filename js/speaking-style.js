/**
 * speaking-style.js — Personal Speaking Profile ("My Style") storage
 * (speaking-style spec.md §4.5/§5, plan.md §4.1).
 *
 * Stored in localStorage, not on the dedicated server — this is per-browser-user
 * preference data the client already has and sends fresh with every Translated Speak
 * request (js/translation-client.js); it is not a secret and the server does not persist
 * it between requests (every translate call is stateless, plan.md §4.1/§9.5). This mirrors
 * voice-profiles.js's getSavedConfiguration()/saveLocalConfiguration() read/write split
 * rather than inventing a new pattern.
 *
 * @typedef {Object} MyStyleProfile
 * @property {string} speakingPreferences free-form paragraph
 * @property {string} preferredPhrases newline-separated
 * @property {string} avoidedPhrases newline-separated
 * @property {string} exampleSentences newline-separated
 */

const STORAGE_KEY = 'voiceCopilot.myStyleProfile';

const EMPTY_PROFILE = Object.freeze({
  speakingPreferences: '',
  preferredPhrases: '',
  avoidedPhrases: '',
  exampleSentences: '',
});

/**
 * @returns {MyStyleProfile} `{}`-equivalent (all fields empty) if never saved, unset, or
 *   unparsable — same corrupt-data tolerance as voice-profiles.js's getSavedConfiguration().
 */
export function loadMyStyleProfile() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY_PROFILE };
    const parsed = JSON.parse(raw);
    return {
      speakingPreferences: typeof parsed.speakingPreferences === 'string' ? parsed.speakingPreferences : '',
      preferredPhrases: typeof parsed.preferredPhrases === 'string' ? parsed.preferredPhrases : '',
      avoidedPhrases: typeof parsed.avoidedPhrases === 'string' ? parsed.avoidedPhrases : '',
      exampleSentences: typeof parsed.exampleSentences === 'string' ? parsed.exampleSentences : '',
    };
  } catch (_) {
    // Corrupt localStorage content — treat exactly like "not present," not a hard failure.
    return { ...EMPTY_PROFILE };
  }
}

/** @param {MyStyleProfile} profile */
export function saveMyStyleProfile(profile) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      speakingPreferences: profile?.speakingPreferences || '',
      preferredPhrases: profile?.preferredPhrases || '',
      avoidedPhrases: profile?.avoidedPhrases || '',
      exampleSentences: profile?.exampleSentences || '',
    })
  );
}

/**
 * True if any of the four fields is non-empty after trim. Client-side mirror of the
 * server's own check (server/lib/translate.js) — used only for an optional Settings-page
 * hint, not for correctness: the server independently falls back to Natural Conversation
 * regardless of what the client sends (speaking-style plan.md §4.3/§8).
 * @param {MyStyleProfile} [profile]
 * @returns {boolean}
 */
export function hasMyStyleContent(profile) {
  if (!profile) return false;
  return [profile.speakingPreferences, profile.preferredPhrases, profile.avoidedPhrases, profile.exampleSentences].some(
    (v) => typeof v === 'string' && v.trim().length > 0
  );
}
