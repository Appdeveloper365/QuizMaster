import type { AISettings, Profile, QuestionHistoryItem } from "../types";

const PROFILE_KEY = "sagestrike.profile.v1";
const SETTINGS_KEY = "sagestrike.ai.v1";
// NOTE: the OpenRouter key is stored unencrypted in local/session storage
// (app-scoped on the Android WebView). It is sent only to OpenRouter.
const KEY_KEY = "sagestrike.openrouter.key";

export const DEFAULT_PROFILE: Profile = {
  xp: 0,
  unlockedLevel: 1,
  completed: {},
  games: 0,
  totalCorrect: 0,
  totalAnswered: 0,
  bestCombo: 0,
  bestBlitz: 0,
  bestGauntlet: 0,
  recentQuestions: [],
};

export const DEFAULT_AI_SETTINGS: AISettings = {
  provider: "webllm",
  webllmModel: "Qwen3.5-4B-q4f16_1-MLC",
  openRouterModel: "qwen/qwen3.5-9b",
  autoPreload: true,
  rememberKey: false,
  modelCustomized: false,
  webllmDual: false,
};

export function loadProfile(): Profile {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    return raw ? { ...DEFAULT_PROFILE, ...JSON.parse(raw) } : DEFAULT_PROFILE;
  } catch {
    return DEFAULT_PROFILE;
  }
}

export function saveProfile(profile: Profile) {
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); } catch { /* storage can be unavailable in private contexts */ }
}

export function loadAISettings(): AISettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_AI_SETTINGS;
    const saved = { ...DEFAULT_AI_SETTINGS, ...JSON.parse(raw) } as AISettings;
    if (!saved.modelCustomized && saved.webllmModel === "Qwen3.5-0.8B-q4f16_1-MLC") saved.webllmModel = DEFAULT_AI_SETTINGS.webllmModel;
    if (saved.webllmModel === "Llama-3.1-8B-Instruct-q4f16_1-MLC-1k") saved.webllmModel = "Llama-3.1-8B-Instruct-q4f16_1-MLC";
    return saved;
  } catch {
    return DEFAULT_AI_SETTINGS;
  }
}

export function saveAISettings(settings: AISettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    if (!settings.rememberKey) localStorage.removeItem(KEY_KEY);
  } catch { /* settings simply remain session-only */ }
}

export function loadOpenRouterKey(remember: boolean) {
  try { return (remember ? localStorage : sessionStorage).getItem(KEY_KEY) ?? ""; } catch { return ""; }
}

export function saveOpenRouterKey(key: string, remember: boolean) {
  try {
    localStorage.removeItem(KEY_KEY);
    sessionStorage.removeItem(KEY_KEY);
    if (key) (remember ? localStorage : sessionStorage).setItem(KEY_KEY, key);
  } catch { /* key remains in React state */ }
}

const HISTORY_KEY = "sagestrike.questionHistory.v1";
export const HISTORY_LIMIT = 2;

export function loadQuestionHistory(): QuestionHistoryItem[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.slice(0, HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

export function saveQuestionHistory(items: QuestionHistoryItem[]) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, HISTORY_LIMIT))); } catch { /* history is optional */ }
}

/* ── Cross-session question dedup ──
   Persists every generated prompt so a topic never repeats a question it
   has already made, across games and app restarts (all models share one set). */
const PROMPT_DEDUP_KEY = "sagestrike.askedPrompts.v1";
export function loadAskedPrompts(): string[] {
  try {
    const raw = localStorage.getItem(PROMPT_DEDUP_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter((p): p is string => typeof p === "string").slice(-50);
  } catch {
    return [];
  }
}

export function recordPrompt(prompt: string): void {
  try {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    const raw = localStorage.getItem(PROMPT_DEDUP_KEY);
    const existing = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(existing)) return;
    if (existing.some((p) => p === trimmed)) return;
    const next = [...existing, trimmed].slice(-50);
    localStorage.setItem(PROMPT_DEDUP_KEY, JSON.stringify(next));
  } catch {
    /* noop — dedup is best-effort */
  }
}

/* ── Cross-session fact memory ──
   Persists the *fact behind each question* (subject + normalized correct
   answer), not its wording, for the subject it was asked under. The model is
   told which facts are spent and validation rejects the same fact reworded. */
const FACT_MEMORY_KEY = "sagestrike.questionFacts.v1";
export const FACT_MEMORY_LIMIT = 200;

interface QuestionFactRecord {
  subject: string;
  key: string;
  at: number;
}

export function loadSubjectFacts(subject: string): string[] {
  try {
    const raw = localStorage.getItem(FACT_MEMORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const normalizedSubject = subject.trim().toLocaleLowerCase();
    const records = parsed
      .filter((entry): entry is QuestionFactRecord => !!entry && typeof entry === "object" && typeof (entry as QuestionFactRecord).key === "string" && typeof (entry as QuestionFactRecord).subject === "string")
      .filter((entry) => entry.subject.toLocaleLowerCase() === normalizedSubject && entry.key.trim());
    // Newest first so the freshest facts feed the exclusion prompt first.
    records.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    return records.slice(0, 40).map((record) => record.key);
  } catch {
    return [];
  }
}

export function recordQuestionFact(subject: string, key: string): void {
  try {
    const cleanSubject = subject.trim();
    const cleanKey = key.trim();
    if (!cleanSubject || !cleanKey) return;
    const raw = localStorage.getItem(FACT_MEMORY_KEY);
    const existing: QuestionFactRecord[] = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(existing) || existing.some((entry) => entry?.subject === cleanSubject && entry?.key === cleanKey)) return;
    const next = [{ subject: cleanSubject, key: cleanKey, at: Date.now() }, ...existing].slice(0, FACT_MEMORY_LIMIT);
    localStorage.setItem(FACT_MEMORY_KEY, JSON.stringify(next));
  } catch {
    /* noop — dedup is best-effort */
  }
}
