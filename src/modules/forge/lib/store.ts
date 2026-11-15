import type { GameResult, Question, QuestionHistoryEntry, Settings } from "./types";
import { kvGet, kvSet } from "./puter";

// NOTE: Settings are stored in localStorage, but the OpenRouter key is
// intentionally excluded — it must live only in memory for the session and
// be re-entered on reload, so a key never persists to disk unencrypted.
const S_KEY = "bf_settings_v1";
const R_KEY = "bf_results_v1";
const QH_KEY = "bf_question_history_v1";

export const DEFAULT_SETTINGS: Settings = {
  provider: "webllm",
  openrouterKey: "",
  openrouterModel: "openrouter/free",
  webllmModel: "Llama-3.2-3B-Instruct-q4f16_1-MLC",
  sound: true,
};

export function loadSettings(): Settings {
  try {
    const stored = JSON.parse(localStorage.getItem(S_KEY) ?? "{}") as Partial<Settings>;
    // Never restore a persisted OpenRouter key — it lives in memory only.
    const { openrouterKey, ...rest } = stored;
    // Migrate the old 4.4 GB non-bundled default left in returning users'
    // settings — bundled models load instantly instead.
    if (rest.webllmModel === "Qwen2.5-7B-Instruct-q4f16_1-MLC") {
      rest.webllmModel = DEFAULT_SETTINGS.webllmModel;
    }
    return { ...DEFAULT_SETTINGS, ...rest, openrouterKey: "" };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(s: Settings) {
  try {
    // Drop the OpenRouter key before persisting — it must not be written to disk.
    const { openrouterKey, ...rest } = s;
    localStorage.setItem(S_KEY, JSON.stringify(rest));
  } catch {
    /* noop */
  }
}

export function loadResults(): GameResult[] {
  try {
    return JSON.parse(localStorage.getItem(R_KEY) ?? "[]") as GameResult[];
  } catch {
    return [];
  }
}

export function saveResult(r: GameResult) {
  const all = [...loadResults(), r].slice(-60);
  try {
    localStorage.setItem(R_KEY, JSON.stringify(all));
  } catch {
    /* noop */
  }
  // Cloud backup via Puter KV when signed in (best-effort).
  void kvSet("brainforge:results", JSON.stringify(all)).catch(() => {});
}

export function loadQuestionHistory(): QuestionHistoryEntry[] {
  try {
    const rows = JSON.parse(localStorage.getItem(QH_KEY) ?? "[]") as QuestionHistoryEntry[];
    const latest = rows
      .filter((row) => row && row.question && typeof row.generatedAt === "number")
      .sort((a, b) => b.generatedAt - a.generatedAt)
      .slice(0, 2);
    if (JSON.stringify(latest) !== JSON.stringify(rows)) {
      try {
        localStorage.setItem(QH_KEY, JSON.stringify(latest));
      } catch {
        /* return the newest entries even when storage is read-only */
      }
    }
    return latest;
  } catch {
    return [];
  }
}

/** Keep only the two most recently generated individual questions. */
export function saveGeneratedQuestion(topic: string, question: Question): QuestionHistoryEntry[] {
  const entry: QuestionHistoryEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    topic,
    question,
    generatedAt: Date.now(),
  };
  const next = [entry, ...loadQuestionHistory()].slice(0, 2);
  try {
    localStorage.setItem(QH_KEY, JSON.stringify(next));
  } catch {
    /* keep the current session usable if storage is full */
  }
  return next;
}

export function clearQuestionHistory() {
  try {
    localStorage.removeItem(QH_KEY);
  } catch {
    /* noop */
  }
}

// ── Cross-session question dedup ──────────────────────────────────
// Records each generated prompt so a topic never asks the same
// question again across app restarts (all models share one set).
const DEDUP_KEY = "bf_asked_prompts_v1";
export const DEDUP_LIMIT = 50;

export function loadAskedPrompts(): Set<string> {
  try {
    const raw = localStorage.getItem(DEDUP_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as string[];
    return new Set(Array.isArray(arr) ? arr.filter((p) => typeof p === "string" && p.trim()) : []);
  } catch {
    return new Set();
  }
}

export function recordAskedPrompt(prompt: string): string[] {
  try {
    const trimmed = prompt.trim();
    if (!trimmed) return [];
    const raw = localStorage.getItem(DEDUP_KEY);
    const existing = (raw ? JSON.parse(raw) : []) as string[];
    if (existing.includes(trimmed)) return existing;
    const next = [...existing, trimmed].slice(-DEDUP_LIMIT);
    localStorage.setItem(DEDUP_KEY, JSON.stringify(next));
    return next;
  } catch {
    return [];
  }
}

// ── Durable question memory — prevents the AI from reusing stale questions ──
// The prompt dedup above only remembers question *wording*, and a fresh session
// builds `usedQuestionKeys` from it — but source facts were never remembered.
// That meant after an app restart the model would happily reuse a stale source
// fact under new wording that still passed verification, surfacing it as a
// repeated "stale" question. This memory records each committed question's text
// AND its fact-key so cross-session generation excludes the same question or
// source fact before ever asking the model. Small and keyed to a unique key so
// it never collides with the prompt dedup set.
export const QMEM_LIMIT = 100;
export const QMEM_KEY = "bf_question_memory_v1";

export interface QuestionMemoryEntry {
  topic: string;
  /** Normalized question text (matches the AI's `normalizeEvidence`). */
  q: string;
  /** Fact-key the AI uses to detect duplicate source facts. */
  factKey: string;
  /** Milliseconds-since-epoch when the question was generated. */
  at: number;
}

/** Append a committed question to the durable memory, keeping only the newest `QMEM_LIMIT`. */
export function recordQuestion(entry: Omit<QuestionMemoryEntry, "at">): void {
  try {
    const trimmed = entry.q.trim();
    if (!trimmed) return;
    const raw = localStorage.getItem(QMEM_KEY);
    const existing: QuestionMemoryEntry[] = raw
      ? (JSON.parse(raw) as QuestionMemoryEntry[]).filter((r) => r && typeof r.q === "string" && typeof r.factKey === "string")
      : [];
    const at = Date.now();
    const next = [{ topic: entry.topic, q: trimmed, factKey: entry.factKey, at }, ...existing]
      .slice(0, QMEM_LIMIT);
    localStorage.setItem(QMEM_KEY, JSON.stringify(next));
  } catch {
    /* storage full — the current session stays usable */
  }
}

/** Load the durable question memory. Returns entries newest-first. */
export function loadQuestionMemory(): QuestionMemoryEntry[] {
  try {
    const raw = localStorage.getItem(QMEM_KEY);
    if (!raw) return [];
    const rows = JSON.parse(raw) as QuestionMemoryEntry[];
    if (!Array.isArray(rows)) return [];
    return rows
      .filter((r) => r && typeof r.q === "string" && typeof r.factKey === "string")
      .sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

export async function syncResultsFromCloud(): Promise<GameResult[]> {
  try {
    const raw = await kvGet("brainforge:results");
    if (!raw) return loadResults();
    const cloud = JSON.parse(raw) as GameResult[];
    const local = loadResults();
    const merged = [...local, ...cloud.filter((c) => !local.some((l) => l.id === c.id))];
    try {
      localStorage.setItem(R_KEY, JSON.stringify(merged.slice(-60)));
    } catch {
      /* noop */
    }
    return merged;
  } catch {
    return loadResults();
  }
}

export function gradeFor(pct: number): { grade: string; label: string; color: string } {
  if (pct >= 0.9) return { grade: "S", label: "Legendary", color: "#fbbf24" };
  if (pct >= 0.75) return { grade: "A", label: "Excellent", color: "#34d399" };
  if (pct >= 0.6) return { grade: "B", label: "Great", color: "#22d3ee" };
  if (pct >= 0.45) return { grade: "C", label: "Good", color: "#a78bfa" };
  if (pct >= 0.3) return { grade: "D", label: "Keep going", color: "#fb923c" };
  return { grade: "F", label: "Warm up", color: "#fb7185" };
}
