# SayWise Teams Web Microphone Injector — Chrome Extension

An unpacked Manifest V3 Chrome Extension that injects SayWises low-latency Streaming TTS into Microsoft Teams Webs microphone audio track.

## Installation in Chrome / Edge / Brave

1. Open `chrome://extensions/` in your browser.
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked** (top-left).
4. Select this directory (`injector/extension/`).
5. Open Teams Web (`https://teams.microsoft.com/`) and SayWise (`http://localhost:4100/`).
6. You will see a small, non-intrusive status widget in the bottom-right corner of Teams showing the connection to the SayWise Audio Bridge.

## How it works
- Injects at `document_start` into the `MAIN` page context.
- Proxies `navigator.mediaDevices.getUserMedia`: when audio is requested, it mixes your physical microphone with the SayWise audio bridge output using Web Audio API.
- Supports Ducking (automatically lowers real mic by -18dB while TTS speaks).
