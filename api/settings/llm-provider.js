/**
 * GET /api/settings/llm-provider — Vercel Serverless Function adapter, mirrors
 * `server/routes/settings.js`'s Express route (see that file's own comment for why this
 * adapter exists alongside it — same reasoning as `api/translate-stream.js`).
 *
 * Read-only Translation/LLM Provider Credential status (speaking-style spec.md
 * §13.1/§13.2): never returns the real key, only whether it's configured and a masked
 * preview. The credential itself is set via this Vercel project's Environment Variables
 * (`GEMINI_API_KEY`) — there is no write endpoint, on Vercel or locally.
 */

import { readMaskedStatus } from '../../server/lib/credential-store.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    res.status(200).json(await readMaskedStatus());
  } catch (err) {
    console.error('[api/settings/llm-provider] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to read credential status' });
  }
}
