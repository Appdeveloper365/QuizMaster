/* Shared OpenRouter client — OpenAI-compatible chat completions.
 * Docs: https://openrouter.ai/api/v1/chat/completions
 *
 * Both modules share this client so referer / key validation / error handling
 * stay consistent. Model lists remain per-module (they differ on purpose).
 */

export interface OpenRouterChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
}

export function looksLikeOpenRouterKey(k: string): boolean {
  return /^sk-or-v1-[A-Za-z0-9_-]{20,}$/.test(k.trim());
}

/** HTTP-Referer is optional (OpenRouter's recommended opt-in attribution header).
 *  Only send it when the origin is a real http(s) origin (Capacitor serves via
 *  https://localhost; sandboxed iframes may expose `null`). */
function refererHeader(): Record<string, string> {
  try {
    const origin = typeof window !== "undefined" ? window.location?.origin : "";
    if (origin && /^https?:\/\//.test(origin)) return { "HTTP-Referer": origin };
  } catch {
    /* sandboxed origin */
  }
  return {};
}

/** Default ceiling on how long an OpenRouter request may run before aborting.
 *  Without this a stalled model response can hang the UI indefinitely. */
const DEFAULT_OPENROUTER_TIMEOUT_MS = 30_000;

export async function openRouterChat(
  apiKey: string,
  model: string,
  messages: OpenRouterChatMsg[],
  opts: { maxTokens?: number; temperature?: number; signal?: AbortSignal; xTitle?: string; timeoutMs?: number } = {},
): Promise<string> {
  const key = apiKey.trim();
  if (!key) throw new Error("Add your OpenRouter API key in Settings (openrouter.ai → Keys).");
  if (!looksLikeOpenRouterKey(key)) throw new Error("That doesn't look like an OpenRouter key (starts with sk-or-v1-).");

  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener("abort", onAbort);

  // Hard timeout so a slow or hung model response cannot block the caller forever.
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_OPENROUTER_TIMEOUT_MS;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`OpenRouter request timed out after ${timeoutMs} ms.`));
      ctrl.abort();
    }, timeoutMs);
  });

  try {
    const res = await Promise.race([
      fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
          ...refererHeader(),
          "X-Title": opts.xTitle ?? "QuizMaster",
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: opts.maxTokens ?? 900,
          temperature: opts.temperature ?? 0.7,
        }),
      }),
      timeoutPromise,
    ]);
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = data?.error?.message ?? `OpenRouter error ${res.status}`;
      throw new Error(msg);
    }
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error("OpenRouter returned an empty reply. Try another model.");
    return String(text);
  } catch (e) {
    if ((e as { name?: string })?.name === "AbortError") throw new Error("Cancelled.");
    throw e;
  } finally {
    if (timeout) clearTimeout(timeout);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}