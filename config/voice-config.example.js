/**
 * Voice Copilot MVP — Provider Configuration + Voice Profile template.
 *
 * Copy this file to `voice-config.local.js` (same directory) and fill in
 * real values. `voice-config.local.js` is gitignored — never commit real
 * credentials.
 *
 * Concept split (spec.md §5.1): PROVIDER_CONFIGURATION is the shared
 * connection credential for the TTS provider; VOICE_PROFILES is the list
 * of individually usable voices. Provider Configuration does not belong to
 * any single Voice Profile.
 */

/** @type {{ provider: 'volcengine', appKey: string, accessToken: string }} */
export const PROVIDER_CONFIGURATION = {
  provider: 'volcengine',
  appKey: 'REPLACE_ME',
  accessToken: 'REPLACE_ME',
};

/**
 * Base URL for the dedicated Node server's API (spec.md §14, plan.md §8.3/§10.7).
 * Defaults to same-origin ('', relative paths) — correct when the dedicated server
 * (public/voice-copilot/server/) serves this page itself. Set DEV_SERVER_BASE_URL_OVERRIDE
 * only for the co-located dev phase, where this page is served via the Live2D project's
 * app.js on a different port than the dedicated server.
 */
export const DEV_SERVER_BASE_URL_OVERRIDE = '';
export const SERVER_BASE_URL = DEV_SERVER_BASE_URL_OVERRIDE || '';

/**
 * @type {Array<{
 *   id: string,
 *   name: string,
 *   speakerId: string,
 *   languageCapability: string[],
 *   speed: number,
 *   volume: number,
 *   pitch?: number,
 *   description?: string,
 * }>}
 */
export const VOICE_PROFILES = [
  {
    id: 'my-voice',
    name: 'My Voice',
    speakerId: 'REPLACE_ME', // e.g. "S_xxxxxxxx"
    languageCapability: ['en', 'zh'],
    speed: 1.0,
    volume: 1.0,
    pitch: 0, // optional Prosody control (speaking-style spec.md §7.3) — 0 is neutral
    description: '',
  },
];
