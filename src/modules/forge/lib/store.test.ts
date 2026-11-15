import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_SETTINGS,
  loadAskedPrompts,
  recordAskedPrompt,
  loadQuestionHistory,
  saveGeneratedQuestion,
  clearQuestionHistory,
} from "./store";
import type { Question } from "./types";

const blankQuestion = (q: string): Question =>
  ({
    id: `t-${q}`,
    q,
    options: ["A", "B", "C", "D"],
    answer: 0,
    explanation: "Because.",
    category: "Test",
    difficulty: "medium",
  }) as Question;

beforeEach(() => {
  localStorage.clear();
});

describe("Forge: default model is the strong ~4GB on-device model", () => {
  it("defaults to Qwen2.5-7B (the strong, heavier model)", () => {
    expect(DEFAULT_SETTINGS.webllmModel).toBe("Llama-3.2-3B-Instruct-q4f16_1-MLC");
    // The weak 1B model must no longer be the default.
    expect(DEFAULT_SETTINGS.webllmModel).not.toBe("Llama-3.2-1B-Instruct-q4f16_1-MLC");
  });
});

describe("Forge: cross-session dedup (loadAskedPrompts / recordAskedPrompt)", () => {
  it("starts empty when nothing has been recorded", () => {
    expect(loadAskedPrompts().size).toBe(0);
  });

  it("records a prompt so a later session sees it (persists across restarts)", () => {
    recordAskedPrompt("What causes eclipses?");
    // Simulate an app restart: new call, same storage.
    const seen = loadAskedPrompts();
    expect(seen.size).toBe(1);
    expect([...seen].includes("What causes eclipses?")).toBe(true);
  });

  it("ignores blank / whitespace prompts", () => {
    recordAskedPrompt("   ");
    expect(loadAskedPrompts().size).toBe(0);
  });

  it("keeps prompts unique (recording twice = one entry)", () => {
    recordAskedPrompt("Same question");
    recordAskedPrompt("Same question");
    expect(loadAskedPrompts().size).toBe(1);
  });

  it("caps the stored set so it cannot grow without bound", () => {
    for (let i = 0; i < 120; i++) recordAskedPrompt(`Prompt number ${i}`);
    const seen = loadAskedPrompts();
    expect(seen.size).toBeLessThanOrEqual(50);
    // The most recent prompts survive; the oldest have been evicted.
    expect([...seen].includes("Prompt number 119")).toBe(true);
    expect([...seen].includes("Prompt number 0")).toBe(false);
  });
});

describe("Forge: history retention capped at the last two questions", () => {
  it("loadQuestionHistory never returns more than two", () => {
    const now = Date.now();
    localStorage.setItem(
      "bf_question_history_v1",
      JSON.stringify(
        [1, 2, 3, 4].map((n) => ({
          id: `h${n}`,
          topic: "T",
          question: blankQuestion(`Q${n}`),
          generatedAt: now + n,
        })),
      ),
    );
    expect(loadQuestionHistory().length).toBe(2);
  });

  it("saveGeneratedQuestion keeps only the two most recent", () => {
    const first = saveGeneratedQuestion("T", blankQuestion("first"));
    expect(first.length).toBe(1);
    saveGeneratedQuestion("T", blankQuestion("second"));
    const two = saveGeneratedQuestion("T", blankQuestion("third"));
    expect(two.length).toBe(2);
    // Newest wins: "third" present, "first" gone.
    const lastQ = two[0].question.q;
    expect(lastQ).toBe("third");
  });

  it("clearQuestionHistory empties the archive", () => {
    saveGeneratedQuestion("T", blankQuestion("only"));
    clearQuestionHistory();
    expect(loadQuestionHistory().length).toBe(0);
  });
});
