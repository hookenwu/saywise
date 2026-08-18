/**
 * GET /api/settings/llm-provider — Translation/LLM Provider Credential status (spec.md
 * §13.1/§13.2). Read-only: the credential itself is configured only via this server's
 * `GEMINI_API_KEY` environment variable (see server/.env.example), never through this API.
 * Never returns the real credential in plaintext, only a masked summary.
 */

import { Router } from 'express';

import { readMaskedStatus } from '../lib/credential-store.js';

const router = Router();

router.get('/llm-provider', async (req, res) => {
  try {
    res.json(await readMaskedStatus());
  } catch (err) {
    console.error('[settings] GET /llm-provider failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to read credential status' });
  }
});

export default router;
