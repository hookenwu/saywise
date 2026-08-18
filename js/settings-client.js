/**
 * settings-client.js — Translation/LLM Provider Credential status check + the main
 * workspace's reachability gate (spec.md §13.1/§13.2).
 *
 * The Settings *page* itself (its DOM wiring — populate/save) lives in js/settings-page.js,
 * used only by settings.html — a separate page, not an inline panel on the main workspace
 * (decoupled so the main workspace stays focused). This file holds only what both the main
 * page (app.js, via updateTranslationAvailability) and the Settings page (settings-page.js)
 * both need, so neither duplicates the fetch logic.
 *
 * Two independent credential stores, matching spec §5.1/§9.3/§13.1's concept split:
 * Voice/TTS Provider Configuration + Voice Profile are written straight to localStorage
 * (synchronous, no server round-trip — the browser needs these values directly anyway to
 * open the TTS WebSocket itself). The Translation/LLM Provider Credential is read-only from
 * the browser's perspective — it is configured exclusively via the dedicated server's
 * `GEMINI_API_KEY` environment variable (server/.env.example), a deployment-time secret set
 * by whoever operates the server, not a value any Settings form can write. There is
 * deliberately no PUT here.
 */

/** @returns {Promise<{ configured: boolean, provider: string, maskedAccessToken: string | null } | null>} null if unreachable */
export async function probeLlmProvider(serverBaseUrl) {
  try {
    const res = await fetch(`${serverBaseUrl}/api/settings/llm-provider`, { method: 'GET' });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null; // dedicated server not running / unreachable — not an error to surface loudly
  }
}

/**
 * Updates the main workspace's "Chinese -> English" toggle's disabled/title state per
 * plan.md §10.1: disabled with an explanatory tooltip whenever the dedicated server has
 * never been confirmed reachable. Direct Speak is entirely unaffected either way — this
 * only gates the toggle that switches into Translated Speak.
 *
 * @param {string} serverBaseUrl
 * @returns {Promise<boolean>} whether the server was reachable this time
 */
export async function updateTranslationAvailability(serverBaseUrl) {
  const toggle = document.getElementById('translation-toggle');
  const status = await probeLlmProvider(serverBaseUrl);
  const reachable = status !== null;
  toggle.disabled = !reachable;
  toggle.title = reachable
    ? ''
    : 'Translation server not reachable — start public/voice-copilot/server (node server/index.js) to enable Chinese → English.';
  return reachable;
}
