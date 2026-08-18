/**
 * settings-page.js — entry script for settings.html (spec.md §13).
 *
 * Settings/Credential decoupling: Settings is a separate page, not an inline panel on the
 * main workspace, so the main workspace (index.html/app.js) stays focused — settings.html
 * is reached via a plain link, no modal/overlay machinery, fitting a zero-build static site
 * with no client-side router.
 *
 * Voice/TTS Provider Credential + Voice Profile: this page shows ONLY configuration the
 * user has explicitly saved through Settings before (via getSavedConfiguration(),
 * localStorage-only, no file fallback) — never config/voice-config.local.js, never the
 * example config, never any other code-level default. If nothing has been saved yet, every
 * field starts empty and the status line reads "Not Configured." The running app
 * (index.html) may still be operating via a file-based dev fallback in the background —
 * that's a legitimate, separate mechanism — but this page must never blur it with "the user
 * configured this."
 *
 * Chinese -> English / Translation Provider: not on this page at all. The toggle itself
 * lives only on the main workspace (index.html's #translation-toggle), which persists its
 * own state directly on change (app.js) — there's nothing for Settings to duplicate. The
 * Translation/LLM Provider Credential is a server-held deployment secret configured via the
 * server's GEMINI_API_KEY env var, not something a Settings form collects or displays.
 */

import { getSavedConfiguration, saveLocalConfiguration } from './voice-profiles.js';

const ttsStatusEl = document.getElementById('settings-tts-status');
const ttsAppIdEl = document.getElementById('settings-tts-app-id');
const ttsAccessTokenEl = document.getElementById('settings-tts-access-token');
const ttsSecretKeyEl = document.getElementById('settings-tts-secret-key');

const voiceNameEl = document.getElementById('settings-voice-name');
const voiceSpeakerIdEl = document.getElementById('settings-voice-speaker-id');
const voiceLangEnEl = document.getElementById('settings-voice-lang-en');
const voiceLangZhEl = document.getElementById('settings-voice-lang-zh');
const voiceSpeedEl = document.getElementById('settings-voice-speed');
const voiceVolumeEl = document.getElementById('settings-voice-volume');

const saveBtn = document.getElementById('settings-save-btn');

function setStatus(el, configured) {
  el.textContent = configured ? 'Configured' : 'Not Configured';
  el.classList.toggle('settings-status-configured', configured);
  el.classList.toggle('settings-status-not-configured', !configured);
}

function populate() {
  // Strictly the saved-only read (never the file-fallback-including loadConfiguration()
  // result) — this is the actual fix this revision makes.
  const saved = getSavedConfiguration();
  const providerConfiguration = saved?.providerConfiguration || null;
  const profile = saved?.voiceProfiles?.[0] || null;

  setStatus(ttsStatusEl, saved !== null);
  ttsAppIdEl.value = providerConfiguration?.appKey || '';
  ttsAccessTokenEl.value = providerConfiguration?.accessToken || '';
  ttsSecretKeyEl.value = providerConfiguration?.secretKey || '';

  voiceNameEl.value = profile?.name || '';
  voiceSpeakerIdEl.value = profile?.speakerId || '';
  voiceLangEnEl.checked = profile?.languageCapability?.includes('en') ?? false;
  voiceLangZhEl.checked = profile?.languageCapability?.includes('zh') ?? false;
  voiceSpeedEl.value = profile?.speed ?? '';
  voiceVolumeEl.value = profile?.volume ?? '';
}

populate();

saveBtn.addEventListener('click', () => {
  const languageCapability = [];
  if (voiceLangEnEl.checked) languageCapability.push('en');
  if (voiceLangZhEl.checked) languageCapability.push('zh');

  const providerConfiguration = {
    provider: 'volcengine',
    appKey: ttsAppIdEl.value.trim(),
    accessToken: ttsAccessTokenEl.value.trim(),
    // Present per spec §13.1's generic 3-field UI even though tts-client.js doesn't
    // currently read it (Volcengine's bidirectional WS only uses appKey/accessToken).
    secretKey: ttsSecretKeyEl.value.trim(),
  };
  const voiceProfiles = [
    {
      id: 'my-voice',
      name: voiceNameEl.value.trim() || 'My Voice',
      speakerId: voiceSpeakerIdEl.value.trim(),
      languageCapability: languageCapability.length ? languageCapability : ['en', 'zh'],
      speed: parseFloat(voiceSpeedEl.value) || 1.0,
      volume: parseFloat(voiceVolumeEl.value) || 1.0,
    },
  ];

  saveLocalConfiguration(providerConfiguration, voiceProfiles);

  // Back to the workspace so it re-runs its normal startup path (loadConfiguration(), TTS
  // client construction, etc.) and picks up the newly saved values — simpler and more
  // robust than duplicating that resolution logic on this page to hot-apply the change.
  location.href = 'index.html';
});
