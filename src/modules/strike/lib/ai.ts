import type { MLCEngine } from "@mlc-ai/web-llm";
import type { Difficulty, Question } from "../types";
import { fetchInternetResearch, type InternetResearch } from "./internetResearch";
import { createSingleQuestionMessages, parseSingleQuestion, SINGLE_QUESTION_SCHEMA, type QuestionSteer } from "./quizGeneration";
import { buildAppConfig, isBundledModel } from "@/shared/bundled";
import { ensurePuter } from "@/shared/puter";
import { openRouterChat } from "@/shared/openrouter";
export { signInToPuter, signOutOfPuter, getPuterUser } from "@/shared/puter";

export const WEBLLM_MODELS = [
  { id: "Qwen3.5-4B-q4f16_1-MLC", name: "Qwen3.5 4B", note: "Stronger reasoning · about 3.9 GB GPU memory", badge: "Strong" },
  { id: "Qwen3.5-2B-q4f16_1-MLC", name: "Qwen3.5 2B", note: "Balanced speed and quality · about 2.2 GB GPU memory", badge: "Balanced" },
  { id: "Qwen3.5-0.8B-q4f16_1-MLC", name: "Qwen3.5 0.8B", note: "Fastest · about 1.6 GB GPU memory", badge: "Low memory" },
  { id: "Llama-3.2-3B-Instruct-q4f16_1-MLC", name: "Llama 3.2 3B", note: "Smaller download · balanced speed and quality · about 2 GB GPU memory", badge: "New default" },
  { id: "Llama-3.1-8B-Instruct-q4f16_1-MLC", name: "Llama 3.1 8B", note: "High capability · about 5.0 GB GPU memory · 4K context", badge: "Large" },
];

// Fast companion model used together with the strong model in dual mode.
export const WEBLLM_FAST_MODEL = "Qwen3.5-0.8B-q4f16_1-MLC";

export const OPENROUTER_MODELS = [
  { id: "qwen/qwen3.5-9b", name: "Qwen3.5 9B", note: "Fast, low-latency helper" },
  { id: "meta-llama/llama-3.1-8b-instruct", name: "Llama 3.1 8B Instruct", note: "General-purpose hints" },
  { id: "qwen/qwen3.5-35b-a3b", name: "Qwen3.5 35B A3B", note: "More capable, uses more credits" },
];

let engine: MLCEngine | null = null;
let loadedModels: string[] = [];
let loadingModels: string[] = [];
let loadingPromise: Promise<void> | null = null;

export function getErrorMessage(caught: unknown, fallback: string): string {
  if (caught instanceof Error && caught.message.trim()) return caught.message;
  if (typeof caught === "string" && caught.trim()) return caught;
  if (caught && typeof caught === "object") {
    const candidate = caught as { message?: unknown; error?: unknown };
    if (typeof candidate.message === "string" && candidate.message.trim()) return candidate.message;
    if (typeof candidate.error === "string" && candidate.error.trim()) return candidate.error;
    if (candidate.error && typeof candidate.error === "object") {
      const nested = (candidate.error as { message?: unknown }).message;
      if (typeof nested === "string" && nested.trim()) return nested;
    }
  }
  return fallback;
}

let probedCacheBackend: "cache" | "indexeddb" | null = null;

// Probe with a real write; fall back to IndexedDB when the Cache API fails
// (some Android WebViews expose `caches` but throw "Unexpected internal
// error" on put). Hugging Face artifacts are CORS-enabled, not opaque, so
// Cache Storage works there — and unlike IndexedDB it has no ~128MB
// per-record limit, which the >190MB params shard requires.
export async function getCacheBackend(): Promise<"cache" | "indexeddb"> {
  if (probedCacheBackend) return probedCacheBackend;
  // Default to IndexedDB. The Cache Storage API can appear to work (probe put/
  // delete succeeds) but fail when caching real model binaries — opaque
  // cross-origin responses throw "Unexpected internal error" on cache.add().
  // IndexedDB is the reliable backend WebLLM's appConfig documents for this.
  if (typeof caches === "undefined") {
    probedCacheBackend = "indexeddb";
    return probedCacheBackend;
  }
  try {
    const probe = await caches.open("sagestrike-cache-probe");
    const request = new Request("https://sagestrike.invalid/probe");
    await probe.put(request, new Response("ok"));
    await probe.delete(request);
    // Prefer the Cache API: IndexedDB in Chromium aborts writes of records
    // larger than ~128MB (WebLLM models ship a >190MB params shard, and the
    // aborted transaction never settles, permanently stalling model load).
    // Cache API streams to disk with no per-record limit, and Hugging Face
    // serves CORS-enabled (non-opaque) artifacts, so cache.add/put work.
    // Engine creation falls back to IndexedDB automatically on failure.
    probedCacheBackend = "cache";
  } catch {
    probedCacheBackend = "indexeddb";
  }
  return probedCacheBackend;
}

export function supportsWebGPU() {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

export function webLLMReady(models: string[]) {
  return engine !== null && models.every((model) => loadedModels.includes(model));
}

/** Models currently resident in the engine (the pipeline rotates through these). */
export function loadedWebLLMModels(): string[] {
  return engine ? [...loadedModels] : [];
}

let activeWebLLMRequests = 0;

/** True while any WebLLM completion (question or hint) is running. */
export function webLLMBusy(): boolean {
  return activeWebLLMRequests > 0;
}

export async function isWebLLMCached(model: string) {
  // Shipped in the app bundle — no runtime download, always "cached".
  if (await isBundledModel(model)) return true;
  if (!supportsWebGPU()) return false;
  const { hasModelInCache, prebuiltAppConfig } = await import("@mlc-ai/web-llm");
  const backend = await getCacheBackend();
  try {
    return await hasModelInCache(model, { ...prebuiltAppConfig, cacheBackend: backend });
  } catch {
    if (backend === "cache") {
      probedCacheBackend = "indexeddb";
      return hasModelInCache(model, { ...prebuiltAppConfig, cacheBackend: "indexeddb" });
    }
    return false;
  }
}

function sameSet(a: string[], b: string[]) {
  return a.length === b.length && a.every((model) => b.includes(model));
}

// Loads one or more models into a single MLCEngine. WebLLM keeps a separate
// request lock per loaded model, so multiple models can generate concurrently.
/** Try creating/loading the engine with a given cache backend. */
async function createEngineWithBackend(
  wanted: string[],
  prebuiltAppConfig: any,
  cacheBackend: "cache" | "indexeddb",
  onProgress: (progress: number, text: string) => void,
): Promise<void> {
  const { CreateMLCEngine } = await import("@mlc-ai/web-llm");
  const appConfig = { ...(await buildAppConfig(prebuiltAppConfig)), cacheBackend };
  if (engine) {
    // Per WebLLM docs, reload() loads models into an existing engine instead of
    // recreating it. cacheBackend is an appConfig field set at engine creation,
    // so reload() doesn't need it repeated.
    await engine.reload(wanted);
  } else {
    engine = await CreateMLCEngine(wanted, {
      appConfig,
      initProgressCallback: (report) => onProgress(report.progress, report.text),
    });
  }
  loadedModels = wanted;
  onProgress(1, "Ready · model artifacts are stored in WebLLM's persistent cache");
}

export async function loadWebLLM(models: string | string[], onProgress: (progress: number, text: string) => void) {
  const wanted = Array.isArray(models) ? [...new Set(models)] : [models];
  if (!supportsWebGPU()) throw new Error("WebGPU is unavailable on this device or browser. Use Puter, OpenRouter, or the offline hint bank instead.");
  if (webLLMReady(wanted)) {
    onProgress(1, "Model is already loaded and ready");
    return;
  }
  if (loadingPromise) {
    if (sameSet(loadingModels, wanted)) {
      await loadingPromise;
      onProgress(1, "Ready · model artifacts are stored in WebLLM's persistent cache");
      return;
    }
    await loadingPromise.catch(() => undefined);
  }
  loadingModels = wanted;
  loadingPromise = (async () => {
    const { prebuiltAppConfig } = await import("@mlc-ai/web-llm");
    const cacheBackend = await getCacheBackend();
    onProgress(0, "Preparing WebGPU and checking the persistent model cache…");
    try {
      await createEngineWithBackend(wanted, prebuiltAppConfig, cacheBackend, onProgress);
    } catch (error) {
      // The Cache Storage API can fail on real model binaries even when a probe
      // passes. Retry once with IndexedDB, the documented reliable backend.
      if (cacheBackend === "cache" && /cache/i.test(String(error))) {
        onProgress(0, "Cache backend failed · retrying with IndexedDB…");
        try {
          await createEngineWithBackend(wanted, prebuiltAppConfig, "indexeddb", onProgress);
          return;
        } catch (retryError) {
          engine = null;
          loadedModels = [];
          throw retryError;
        }
      }
      engine = null;
      loadedModels = [];
      throw error;
    }
  })();
  try {
    await loadingPromise;
  } catch (error) {
    engine = null;
    loadedModels = [];
    throw error;
  } finally {
    loadingPromise = null;
    loadingModels = [];
  }
}

// Best-effort loader for the background question pipeline: grows the engine's
// model set (e.g. to fast 0.8B + strong 4B + 2B so three questions can be
// pre-generated in rotation). On any failure the previously loaded set is
// restored, so the app never ends up without a usable model.
export async function ensurePipelineModels(wanted: string[]): Promise<string[]> {
  if (!supportsWebGPU()) return loadedWebLLMModels();
  const uniqueWanted = [...new Set(wanted)];
  if (webLLMReady(uniqueWanted)) return loadedWebLLMModels().filter((model) => uniqueWanted.includes(model));
  const previous = loadedWebLLMModels();
  try {
    await loadWebLLM(uniqueWanted, () => undefined);
    return loadedWebLLMModels();
  } catch {
    if (previous.length > 0 && !webLLMReady(previous)) {
      try { await loadWebLLM(previous, () => undefined); } catch { /* engine stays empty; the user flow will reload it */ }
    }
    return loadedWebLLMModels();
  }
}

function hintMessages(question: Question) {
  const answers = question.options.map((option, index) => `${String.fromCharCode(65 + index)}. ${option}`).join("\n");
  return {
    system: "You are a concise quiz coach. Give one useful conceptual nudge in at most 35 words. Never state the correct answer, its letter, or eliminate specific answer choices. No preamble and no markdown.",
    user: `Category: ${question.subject ?? question.category}\nQuestion: ${question.prompt}\nChoices:\n${answers}\nGive a hint without revealing the answer.`,
  };
}

function cleanResponse(value: unknown): string {
  let text = "";
  if (typeof value === "string") text = value;
  else if (value && typeof value === "object") {
    const candidate = value as { message?: { content?: unknown }; content?: unknown; text?: unknown };
    const content = candidate.message?.content ?? candidate.content ?? candidate.text;
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) text = content.map((part) => typeof part === "string" ? part : (part as { text?: string })?.text ?? "").join("");
  }
  return text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "").replace(/^hint\s*:\s*/i, "").trim();
}

function validateHint(text: string, question: Question) {
  const normalized = text.toLocaleLowerCase();
  const solution = question.options[question.answer].toLocaleLowerCase();
  const namesLetter = /\b(?:answer|option|choice)\s*(?:is|:)?\s*[A-D]\b/.test(text) || /^\s*[A-D][).:]\s*/.test(text);
  if ((solution.length > 2 && normalized.includes(solution)) || namesLetter) {
    throw new Error("The model ignored hint safety and tried to reveal the answer. Retry or use the authored offline hint.");
  }
  return text;
}

export async function askOpenRouter(key: string, model: string, question: Question, testOnly = false) {
  if (!key.trim()) throw new Error("Add your OpenRouter API key first. It is sent only to OpenRouter.");
  const hint = hintMessages(question);
  const messages = testOnly
    ? [{ role: "user" as const, content: "Reply with exactly READY." }]
    : [hint.system ? { role: "system" as const, content: hint.system } : { role: "system" as const, content: "" }, { role: "user" as const, content: hint.user }];
  const raw = await openRouterChat(key, model, messages, { maxTokens: testOnly ? 12 : 140, temperature: 0.35, xTitle: "SageStrike Quiz Arena" });
  const text = cleanResponse(raw);
  if (!text) throw new Error("OpenRouter returned an empty response. Try another model.");
  return testOnly ? text : validateHint(text, question);
}

export async function askPuter(question: Question) {
  const puter = await ensurePuter();
  if (!puter.auth.isSignedIn()) throw new Error("Sign in with Puter before requesting a cloud hint.");
  const messages = hintMessages(question);
  const response = await puter.ai.chat(`${messages.system}\n\n${messages.user}`, { model: "openai/gpt-5.4-nano" });
  const text = cleanResponse(response);
  if (!text) throw new Error("Puter returned an empty hint. Please try again.");
  return validateHint(text, question);
}

export async function askWebLLM(model: string, question: Question) {
  if (!engine || !loadedModels.includes(model)) throw new Error("The local helper is not loaded yet.");
  activeWebLLMRequests += 1;
  try {
    const messages = hintMessages(question);
    const response = await engine.chat.completions.create({
      model,
      messages: [{ role: "system", content: messages.system }, { role: "user", content: messages.user }],
      temperature: 0.35,
      max_tokens: 140,
      extra_body: { enable_thinking: false },
    });
    const text = cleanResponse(response.choices[0]?.message);
    if (!text) throw new Error("The local model returned an empty hint. Please try again.");
    return validateHint(text, question);
  } finally {
    activeWebLLMRequests -= 1;
  }
}

async function webLLMQuestionOnce(
  model: string,
  subject: string,
  difficulty: Difficulty,
  research: InternetResearch,
  excludePrompts: string[],
  facetIndex: number,
  reinforceTopic: boolean,
  steer: QuestionSteer = {}
): Promise<Question> {
  if (!engine || !loadedModels.includes(model)) throw new Error(`The ${model} model is not loaded yet.`);
  activeWebLLMRequests += 1;
  try {
    const messages = createSingleQuestionMessages(subject, difficulty, research, excludePrompts, facetIndex, reinforceTopic, steer);
    const requestBase = {
      model,
      messages: [{ role: "system" as const, content: messages.system }, { role: "user" as const, content: messages.user }],
      // The fast companion model gets a slightly higher temperature for speed;
      // the strong model stays conservative for accuracy.
      temperature: model === WEBLLM_FAST_MODEL ? 0.35 : 0.2,
      top_p: 0.9,
      max_tokens: 520,
      extra_body: { enable_thinking: false },
    };

    let response;
    try {
      response = await engine.chat.completions.create({
        ...requestBase,
        response_format: { type: "json_object", schema: SINGLE_QUESTION_SCHEMA },
      });
    } catch {
      response = await engine.chat.completions.create({
        ...requestBase,
        response_format: { type: "json_object" },
      });
    }

    const text = cleanResponse(response.choices[0]?.message);
    if (!text) throw new Error(`The ${model} model returned an empty question.`);
    return parseSingleQuestion(text, subject, difficulty, research, excludePrompts, steer.avoidFactKeys ?? []);
  } finally {
    activeWebLLMRequests -= 1;
  }
}

export async function generateOneWithWebLLM(
  model: string,
  subject: string,
  difficulty: Difficulty,
  research: InternetResearch,
  excludePrompts: string[],
  facetIndex: number,
  reinforceTopic = false,
  steer: QuestionSteer = {}
) {
  return webLLMQuestionOnce(model, subject, difficulty, research, excludePrompts, facetIndex, reinforceTopic, steer);
}

// Dual-model mode: the fast 0.8B model and the strong selected model both
// generate the same grounded question at the same time (each loaded model has
// its own lock in WebLLM, so requests overlap). The first output that passes
// topic + anti-hallucination validation wins; the other is discarded.
export async function generateOneWithWebLLMDual(
  strongModel: string,
  subject: string,
  difficulty: Difficulty,
  research: InternetResearch,
  excludePrompts: string[],
  facetIndex: number,
  steer: QuestionSteer = {}
): Promise<Question> {
  const models = strongModel === WEBLLM_FAST_MODEL ? [WEBLLM_FAST_MODEL, "Qwen3.5-2B-q4f16_1-MLC"] : [WEBLLM_FAST_MODEL, strongModel];
  if (!webLLMReady(models)) throw new Error("Dual WebLLM models are not loaded yet.");

  const attempts = models.map((model) =>
    webLLMQuestionOnce(model, subject, difficulty, research, excludePrompts, facetIndex, false, steer)
      .then((question) => ({ question, model }))
  );

  const errors: string[] = [];
  const results = await Promise.allSettled(attempts);
  const fulfilled = results.filter((result): result is PromiseFulfilledResult<{ question: Question; model: string }> => result.status === "fulfilled");
  if (fulfilled.length > 0) {
    // Prefer the strong model when both finish valid; otherwise take whichever won the race.
    const strong = fulfilled.find((entry) => entry.value.model === strongModel) ?? fulfilled[0];
    return strong.value.question;
  }
  for (const result of results) {
    if (result.status === "rejected") errors.push(getErrorMessage(result.reason, "unknown error"));
  }
  throw new Error(`Both WebLLM models failed validation/generation: ${errors.join(" | ")}`);
}

export async function generateOneWithOpenRouter(
  key: string,
  model: string,
  subject: string,
  difficulty: Difficulty,
  research: InternetResearch | null,
  excludePrompts: string[],
  facetIndex: number,
  reinforceTopic = false,
  steer: QuestionSteer = {}
) {
  if (!key.trim()) throw new Error("Add your OpenRouter API key before generating a question.");
  const messages = createSingleQuestionMessages(subject, difficulty, research ?? await fetchInternetResearch(subject), excludePrompts, facetIndex, reinforceTopic, steer);
  const raw = await openRouterChat(key, model, [
    { role: "system", content: messages.system },
    { role: "user", content: messages.user },
  ], { maxTokens: 700, temperature: 0.3, xTitle: "SageStrike Question Forge" });
  const text = cleanResponse(raw);
  if (!text) throw new Error("OpenRouter returned an empty response. Please retry.");
  return parseSingleQuestion(text, subject, difficulty, research, excludePrompts, steer.avoidFactKeys ?? []);
}

export async function generateOneWithPuter(
  subject: string,
  difficulty: Difficulty,
  research: InternetResearch | null,
  excludePrompts: string[],
  facetIndex: number,
  reinforceTopic = false,
  steer: QuestionSteer = {}
) {
  const puter = await ensurePuter();
  if (!puter.auth.isSignedIn()) throw new Error("Sign in with Puter before generating a question.");
  const messages = createSingleQuestionMessages(subject, difficulty, research ?? await fetchInternetResearch(subject), excludePrompts, facetIndex, reinforceTopic, steer);
  const response = await puter.ai.chat(`${messages.system}\n\n${messages.user}`, { model: "openai/gpt-5.4-nano" });
  const text = cleanResponse(response);
  if (!text) throw new Error("Puter returned an empty response. Please retry.");
  return parseSingleQuestion(text, subject, difficulty, research, excludePrompts, steer.avoidFactKeys ?? []);
}
