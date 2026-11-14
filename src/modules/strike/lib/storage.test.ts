import { describe, it, expect, beforeEach } from "vitest";
import { HISTORY_LIMIT, loadQuestionHistory, loadAskedPrompts, recordPrompt } from "./storage";

// A minimal QuestionHistoryItem shape is enough for storage round-trips.
const makeItem = (prompt: string, at = Date.now()) =>
  ({
    id: `h-${prompt}`,
    topic: "T",
    subject: "T",
    difficulty: 2,
    prompt,
    options: ["A", "B", "C", "D"],
    answer: 0,
    hint: "hint",
    explanation: "an explanation",
    generatedAt: at,
  }) as any;

beforeEach(() => {
  localStorage.clear();
});

describe("SageStrike: storage", () => {
  it("history limit is two", () => {
    expect(HISTORY_LIMIT).toBe(2);
  });

  it("loadQuestionHistory caps at the first two entries", () => {
    const items = [1, 2, 3, 4, 5].map((n) => makeItem(`Q${n}`));
    localStorage.setItem("sagestrike.questionHistory.v1", JSON.stringify(items));
    const loaded = loadQuestionHistory();
    expect(loaded.length).toBe(2);
    expect(loaded.map((i) => i.prompt)).toEqual(["Q1", "Q2"]);
  });

  it("loadQuestionHistory returns [] with empty storage", () => {
    expect(loadQuestionHistory().length).toBe(0);
  });
});

describe("SageStrike: cross-session dedup", () => {
  it("starts empty", () => {
    expect(loadAskedPrompts()).toEqual([]);
  });

  it("records prompts and persists them across a simulated restart", () => {
    recordPrompt("What is osmosis?");
    const afterRestart = loadAskedPrompts();
    expect(afterRestart).toContain("What is osmosis?");
  });

  it("is unique — recording twice keeps one copy", () => {
    recordPrompt("Identical question");
    recordPrompt("Identical question");
    expect(loadAskedPrompts().filter((p) => p === "Identical question").length).toBe(1);
  });

  it("caps at 50 stored prompts", () => {
    for (let i = 0; i < 80; i++) recordPrompt(`Prompt ${i}`);
    const seen = loadAskedPrompts();
    expect(seen.length).toBeLessThanOrEqual(50);
    expect(seen.includes("Prompt 79")).toBe(true);
  });
});
