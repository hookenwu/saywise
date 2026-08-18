/**
 * Voice Copilot MVP — Provider Configuration + Voice Profile loading.
 *
 * Shapes (plan.md §13/§14, spec.md §5.1):
 *
 * @typedef {Object} ProviderConfiguration
 * @property {string} provider
 * @property {string} appKey
 * @property {string} accessToken
 *
 * @typedef {Object} VoiceProfile
 * @property {string} id
 * @property {string} name
 * @property {string} speakerId
 * @property {string[]} languageCapability
 * @property {number} speed
 * @property {number} volume
 * @property {string} [description]
 *
 * Phase 12 (spec.md §13, plan.md §9.1): loadConfiguration() is now localStorage-first,
 * with config/voice-config.local.js as a first-run fallback rather than the only source —
 * this is what makes the Settings panel (Phase 12) a real, durable way to configure the
 * app instead of "edit a file." The ProviderConfiguration/VoiceProfile shapes above are
 * unchanged (a source-resolution-order change only, plan.md §9.1's own framing).
 */

const LOCAL_CONFIG_PATH = '../config/voice-config.local.js';
const EXAMPLE_CONFIG_PATH = 'config/voice-config.example.js';

const STORAGE_KEYS = {
  providerConfiguration: 'voiceCopilot.providerConfiguration',
  voiceProfiles: 'voiceCopilot.voiceProfiles',
};

// Cached after a successful loadConfiguration() call, so Phase 3's
// tts-client.js can read the Provider Configuration without re-importing
// the local config module itself (keeps the single point of config
// loading/validation in this file, per spec.md §5.1's concept split).
let cachedProviderConfiguration = null;

/** @returns {ProviderConfiguration | null} */
export function getProviderConfiguration() {
  return cachedProviderConfiguration;
}

/**
 * Reads back ONLY what the user has explicitly saved through Settings — localStorage,
 * nothing else. Deliberately does not fall back to config/voice-config.local.js or any
 * other source: this is the "already-saved user configuration" half of the settings.html
 * page's own distinction between that and "code defaults" (never shown/pre-filled in the
 * Settings form). loadConfiguration() below is the *runtime* resolution (localStorage
 * first, file as a fallback so the app actually works) and is a different concern — the
 * Settings page must never blur the two by treating a file-based fallback value as if the
 * user had saved it.
 *
 * @returns {{ providerConfiguration: ProviderConfiguration, voiceProfiles: VoiceProfile[] } | null}
 * null if either key is missing, unparsable, or fails basic shape validation.
 */
export function getSavedConfiguration() {
  try {
    const providerRaw = localStorage.getItem(STORAGE_KEYS.providerConfiguration);
    const profilesRaw = localStorage.getItem(STORAGE_KEYS.voiceProfiles);
    if (!providerRaw || !profilesRaw) return null;
    const providerConfiguration = JSON.parse(providerRaw);
    const voiceProfiles = JSON.parse(profilesRaw);
    if (validateConfiguration(providerConfiguration, voiceProfiles)) return null;
    return { providerConfiguration, voiceProfiles };
  } catch (_) {
    // Corrupt localStorage content — treat exactly like "not present," not a hard failure.
    return null;
  }
}

/**
 * Writes Provider Configuration + Voice Profiles to localStorage (Phase 12, T12.4) — used
 * by the Settings form's Save handler. This becomes loadConfiguration()'s primary source
 * from the next load onward (plan.md §9.1's "the path once the user has ever saved
 * Settings"), superseding config/voice-config.local.js without deleting or requiring it.
 *
 * @param {ProviderConfiguration} providerConfiguration
 * @param {VoiceProfile[]} voiceProfiles
 */
export function saveLocalConfiguration(providerConfiguration, voiceProfiles) {
  localStorage.setItem(STORAGE_KEYS.providerConfiguration, JSON.stringify(providerConfiguration));
  localStorage.setItem(STORAGE_KEYS.voiceProfiles, JSON.stringify(voiceProfiles));
}

/**
 * Loads and validates Provider Configuration + Voice Profiles, localStorage-first with
 * config/voice-config.local.js as a fallback (plan.md §9.1). Never throws — failures are
 * returned as a typed result so the caller can fail loudly with a banner (spec.md §18 /
 * plan.md §14) instead of leaving a silently broken selector.
 *
 * `serverBaseUrl` is resolved independently of TTS credential validity (read straight off
 * the config module import, when that import succeeds at all) — so Settings remains able
 * to reach the dedicated server and fix a broken TTS configuration even when the rest of
 * this function's validation fails.
 *
 * @returns {Promise<
 *   | { ok: true, providerConfiguration: ProviderConfiguration, voiceProfiles: VoiceProfile[], serverBaseUrl: string }
 *   | { ok: false, error: { type: string, message: string }, serverBaseUrl: string }
 * >}
 */
export async function loadConfiguration() {
  let mod = null;
  try {
    mod = await import(LOCAL_CONFIG_PATH);
  } catch (_) {
    // File missing entirely — not fatal on its own any more (Phase 12): localStorage
    // (checked below) can supply a complete configuration with no file present at all.
  }
  const serverBaseUrl = mod?.SERVER_BASE_URL || '';

  // Step 1-2 (plan.md §9.1): localStorage is the primary source once the user has ever
  // saved Settings. getSavedConfiguration() already runs this through validateConfiguration()
  // internally, so a non-null result here is guaranteed usable.
  const stored = getSavedConfiguration();
  if (stored) {
    cachedProviderConfiguration = stored.providerConfiguration;
    return {
      ok: true,
      providerConfiguration: stored.providerConfiguration,
      voiceProfiles: stored.voiceProfiles,
      serverBaseUrl,
    };
  }

  // Step 3 (plan.md §9.1): fall back to config/voice-config.local.js exactly as the
  // original, unchanged Phase 2 code path did.
  if (mod) {
    const fileError = validateConfiguration(mod.PROVIDER_CONFIGURATION, mod.VOICE_PROFILES);
    if (!fileError) {
      cachedProviderConfiguration = mod.PROVIDER_CONFIGURATION;
      return {
        ok: true,
        providerConfiguration: mod.PROVIDER_CONFIGURATION,
        voiceProfiles: mod.VOICE_PROFILES,
        serverBaseUrl,
      };
    }
  }

  // Step 4 (plan.md §9.1): neither source is valid — Settings is now the primary fix,
  // config/voice-config.local.js is a secondary/dev-only mention.
  return {
    ok: false,
    error: {
      type: 'missing-configuration',
      message: `No usable Voice / TTS Provider Configuration found. Open Settings to configure your Provider Credential and Voice Profile — or, for local development, copy ${EXAMPLE_CONFIG_PATH} to config/voice-config.local.js and fill it in.`,
    },
    serverBaseUrl,
  };
}

function validateConfiguration(providerConfiguration, voiceProfiles) {
  if (!providerConfiguration || typeof providerConfiguration !== 'object') {
    return {
      type: 'missing-provider-configuration',
      message: `Provider Configuration is missing. Open Settings to configure it — or see ${EXAMPLE_CONFIG_PATH} for local development.`,
    };
  }

  const { provider, appKey, accessToken } = providerConfiguration;
  if (!provider || !appKey || !accessToken || appKey === 'REPLACE_ME' || accessToken === 'REPLACE_ME') {
    return {
      type: 'missing-credential',
      message: 'Provider Configuration is incomplete — fill in Provider / App ID / Access Token via Settings.',
    };
  }

  if (!Array.isArray(voiceProfiles) || voiceProfiles.length === 0) {
    return {
      type: 'missing-voice-profile',
      message: 'No Voice Profile configured — add one via Settings.',
    };
  }

  for (const profile of voiceProfiles) {
    const isValid =
      profile &&
      typeof profile.id === 'string' &&
      profile.id.length > 0 &&
      typeof profile.name === 'string' &&
      profile.name.length > 0 &&
      typeof profile.speakerId === 'string' &&
      profile.speakerId.length > 0 &&
      profile.speakerId !== 'REPLACE_ME' &&
      Array.isArray(profile.languageCapability) &&
      profile.languageCapability.length > 0;
    if (!isValid) {
      return {
        type: 'invalid-voice-profile',
        message: `Voice Profile "${(profile && profile.id) || '(unknown)'}" is missing required fields (id/name/speakerId/languageCapability).`,
      };
    }
  }

  return null;
}

/** e.g. ['en', 'zh'] -> "EN · 中" */
export function formatLanguageCapability(languageCapability) {
  const labels = { en: 'EN', zh: '中' };
  return languageCapability.map((code) => labels[code] || code.toUpperCase()).join(' · ');
}
