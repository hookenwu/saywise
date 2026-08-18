/**
 * Translation/LLM Provider Credential store (spec.md §13.1/§13.2).
 *
 * Read-only, environment-only: the credential comes exclusively from `GEMINI_API_KEY` in
 * this server's process environment (`server/.env` in dev, the deployment platform's env
 * config in production). There is no browser-writable path — unlike Voice/TTS Provider
 * Configuration (a per-browser-user value the client needs directly to open the TTS
 * WebSocket), the Translation/LLM credential is a server-held deployment secret, set once
 * by whoever operates this server instance, not something an end user fills into a web
 * form. Settings only ever displays whether it's configured (readMaskedStatus) — it can
 * never write one.
 */

function maskAccessToken(token) {
  if (!token) return null;
  if (token.length <= 8) return '••••';
  return `${token.slice(0, 4)}••••${token.slice(-4)}`;
}

/** @returns {Promise<{ provider: string, accessToken: string } | null>} the real credential — server-side use only, never sent to the browser */
export async function readCredential() {
  if (process.env.GEMINI_API_KEY) {
    return { provider: 'gemini', accessToken: process.env.GEMINI_API_KEY };
  }
  return null;
}

/**
 * @returns {Promise<{ configured: boolean, provider: string, maskedAccessToken: string | null }>}
 * Safe to send to the browser — never includes the real accessToken.
 */
export async function readMaskedStatus() {
  const credential = await readCredential();
  if (!credential) {
    return { configured: false, provider: 'gemini', maskedAccessToken: null };
  }
  return {
    configured: true,
    provider: credential.provider,
    maskedAccessToken: maskAccessToken(credential.accessToken),
  };
}
