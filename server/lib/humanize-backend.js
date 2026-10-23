/**
 * Humanize inference backend (specs/voice-copilot-humanize-gateway, plan.md §1).
 *
 * When HUMANIZE_LLM_BASE_URL is set, Humanize rewrites (`mode: "rewrite"`) go to an
 * OpenAI-compatible gateway (the local Antigravity Manager) instead of the Gemini API.
 * Unset = rollback: rewrite uses the Gemini path in translate.js exactly as before.
 * The key lives only in this server process's environment — never sent to the browser,
 * never logged.
 */

const DEFAULT_MODEL = 'gemini-3.8-flash';
// The gateway's gemini-3.8-flash reasons by default (first content token at 5-7 s);
// 'none' turns that off without rerouting to another model (plan.md §2).
const DEFAULT_REASONING_EFFORT = 'none';

/** @returns {{ baseUrl: string, apiKey: string, model: string, reasoningEffort: string } | null} */
export function humanizeBackend(env = process.env) {
  const baseUrl = env.HUMANIZE_LLM_BASE_URL?.trim();
  if (!baseUrl) return null;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey: env.HUMANIZE_LLM_API_KEY?.trim() || '',
    model: env.HUMANIZE_LLM_MODEL?.trim() || DEFAULT_MODEL,
    reasoningEffort: env.HUMANIZE_LLM_REASONING_EFFORT?.trim() || DEFAULT_REASONING_EFFORT,
  };
}

/** Error carrying the upstream HTTP status, so translate.js's transient-retry rule applies. */
class GatewayError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * Streams one chat completion from an OpenAI-compatible endpoint.
 * Yields `{ content, model }` per content delta; `reasoning_content` deltas are dropped.
 */
export async function* streamChatCompletions({ baseUrl, apiKey, model, reasoningEffort, systemInstruction, text, signal }) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      stream: true,
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: text },
      ],
    }),
    signal,
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new GatewayError(`Humanize gateway HTTP ${res.status}${detail ? `: ${detail}` : ''}`, res.status);
  }

  const decoder = new TextDecoder();
  let buffer = '';
  for await (const bytes of res.body) {
    buffer += decoder.decode(bytes, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue; // blank lines, ": ping" comments
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      let event;
      try {
        event = JSON.parse(payload);
      } catch {
        continue;
      }
      if (event.error) throw new GatewayError(`Humanize gateway: ${event.error.message || JSON.stringify(event.error)}`, event.error.code);
      const content = event.choices?.[0]?.delta?.content;
      if (content) yield { content, model: event.model };
    }
  }
}
