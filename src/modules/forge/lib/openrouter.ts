/* OpenRouter — OpenAI-compatible chat completions.
   Docs: https://openrouter.ai/api/v1/chat/completions
   The shared request client lives in src/shared/openrouter.ts; this module
   keeps the BrainForge-specific free-model list and re-exports the client. */

export { looksLikeOpenRouterKey, openRouterChat } from "@/shared/openrouter";

export const OPENROUTER_MODELS = [
  { id: "openrouter/free", label: "Auto · Free router", hint: "Picks a free model for you" },
  { id: "meta-llama/llama-3.3-70b-instruct:free", label: "Llama 3.3 70B · Free", hint: "Strong general chat" },
  { id: "qwen/qwen3-4b:free", label: "Qwen 3 4B · Free", hint: "Fast + smart" },
  { id: "meta-llama/llama-3.2-3b-instruct:free", label: "Llama 3.2 3B · Free", hint: "Lightweight" },
  { id: "google/gemma-3-27b-it:free", label: "Gemma 3 27B · Free", hint: "Multimodal family" },
  { id: "deepseek/deepseek-chat-v3-0324:free", label: "DeepSeek V3 · Free", hint: "Great reasoning" },
  { id: "mistralai/mistral-7b-instruct:free", label: "Mistral 7B · Free", hint: "Classic fast" },
];