/**
 * Voice Copilot — dedicated Node.js server (spec.md §14, plan.md §4).
 *
 * Deliberately separate from the Live2D project's app.js: no shared routes, no shared
 * node_modules, no runtime dependency in either direction (plan.md §4.1). Two jobs only
 * (plan.md §4.2): proxy the Chinese -> English LLM streaming call (Phase 10) and hold the
 * Translation/LLM Provider Credential store behind a small settings API (Phase 12). It
 * also serves this directory's own static frontend, so `node server/index.js` alone is a
 * fully independent way to run Voice Copilot (plan.md §4.3) — the same files app.js's
 * existing express.static('public') already serves at /voice-copilot/*, reachable here at
 * / with zero other process required.
 *
 * Listening/CORS boundaries are intentionally narrow, not permissive-by-default
 * (plan.md §4.6): binds to VOICE_COPILOT_SERVER_HOST (default 127.0.0.1, not 0.0.0.0) and
 * only accepts cross-origin requests from VOICE_COPILOT_ALLOWED_ORIGIN — this server holds
 * Provider Credential material and should not be reachable beyond this machine, or from an
 * arbitrary origin, without an explicit override.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

import settingsRouter from './routes/settings.js';
import translateRouter from './routes/translate.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.VOICE_COPILOT_SERVER_PORT || 4100;
const HOST = process.env.VOICE_COPILOT_SERVER_HOST || '127.0.0.1';
const ALLOWED_ORIGIN = process.env.VOICE_COPILOT_ALLOWED_ORIGIN || 'http://localhost:3000';

const app = express();

app.use(express.json({ limit: '64kb' }));
app.use(cors({ origin: ALLOWED_ORIGIN }));

app.use('/api/settings', settingsRouter);
app.use('/api', translateRouter);

// Static frontend — index.html/css/js/config one level up from server/. This is what
// makes running only `node server/index.js` a fully independent way to use Voice Copilot
// (plan.md §4.3) — no app.js, no Live2D project files required.
app.use(express.static(path.join(__dirname, '..')));

app.listen(PORT, HOST, () => {
  console.log(`[voice-copilot-server] listening on http://${HOST}:${PORT}`);
});
