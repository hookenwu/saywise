/**
 * SayWise Teams Web Microphone Injector — Isolated World WebSocket Relay (docs/teams-web-audio-injection-spec.md §3.2.1).
 *
 * Runs in the Chrome Extension's ISOLATED world content script where extension host_permissions
 * ("http://127.0.0.1/*", "http://localhost/*") apply, bypassing Teams Web's CSP connect-src restrictions.
 * Relays control messages and audio binary chunks between the extension and the page's MAIN world via window.postMessage.
 */
(() => {
  'use strict';

  const RELAY_KEY = '__saywiseRelay';
  const sockets = new Map();

  function postToPage(msg, transfer = []) {
    window.postMessage({ [RELAY_KEY]: 'from-relay', ...msg }, '*', transfer);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data[RELAY_KEY] !== 'to-relay') return;
    const msg = event.data;

    if (msg.op === 'probe') {
      postToPage({ op: 'ready' });
      return;
    }

    if (msg.op === 'connect') {
      const { id, url } = msg;
      try {
        const ws = new WebSocket(url);
        ws.binaryType = 'arraybuffer';
        sockets.set(id, ws);

        ws.onopen = () => {
          postToPage({ op: 'open', id });
        };

        ws.onmessage = (e) => {
          if (e.data instanceof ArrayBuffer) {
            postToPage({ op: 'message', id, data: e.data }, [e.data]);
          } else {
            postToPage({ op: 'message', id, data: e.data });
          }
        };

        ws.onerror = () => {
          postToPage({ op: 'error', id });
        };

        ws.onclose = (e) => {
          sockets.delete(id);
          postToPage({ op: 'close', id, code: e.code });
        };
      } catch (err) {
        postToPage({ op: 'error', id });
        postToPage({ op: 'close', id, code: 1006 });
      }
      return;
    }

    if (msg.op === 'close') {
      const ws = sockets.get(msg.id);
      if (ws) {
        sockets.delete(msg.id);
        try {
          ws.close();
        } catch {}
      }
    }
  });

  // Announce ready in case the MAIN world script was already initialized
  postToPage({ op: 'ready' });
})();
