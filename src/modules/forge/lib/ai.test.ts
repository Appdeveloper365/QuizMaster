import { describe, it, expect, beforeEach, vi } from "vitest";
import { PREBUFFER } from "./ai";
import { loadAskedPrompts, clearQuestionHistory, DEDUP_LIMIT, recordAskedPrompt } from "./store";
import { buildKeywords } from "./knowledge";

const ctx: any = { provider: "webllm", openrouterKey: "", openrouterModel: "" };

// Every question below is grounded in one of these sentences. The answer text
// must be a verbatim substring of its `source_quote` — that is what
// verifyGeneratedQuestion() checks — otherwise the engine silently falls back to
// an extractive question and the model-generated prompt is never recorded. Each
// distinct question is grounded in a *different* source sentence so its
// fact-key differs from the others (the fact-key dedup rejects same-quote
// questions), which is required for the "new question" branch to fire.
const SOURCE_EXTRACT =
  "The study found that photosynthesis produces about 500 liters of oxygen per hectare each year, based on data collected in 2019.";

const SOURCE_EXTRACT_2 =
  "The plant cell uses chlorophyll to absorb sunlight and turns it into chemical energy during the day, according to the 2020 field study.";

const SOURCE_EXTRACT_3 =
  "Starch is the main way plants store the chemical energy they make from sunlight through photosynthesis.";

const knowledge: any = {
  topic: "Photosynthesis",
  online: true,
  keywords: buildKeywords(SOURCE_EXTRACT + " " + SOURCE_EXTRACT_2 + " " + SOURCE_EXTRACT_3, "Photosynthesis"),
  sources: [
    { title: "Photosynthesis", url: "https://example.com/phot", extract: SOURCE_EXTRACT },
    { title: "Photosynthesis II", url: "https://example.com/phot2", extract: SOURCE_EXTRACT_2 },
    { title: "Photosynthesis III", url: "https://example.com/phot3", extract: SOURCE_EXTRACT_3 },
  ],
  context: `### Photosynthesis\nSOURCE_URL: https://example.com/phot\n${SOURCE_EXTRACT}\n\n### Photosynthesis II\nSOURCE_URL: https://example.com/phot2\n${SOURCE_EXTRACT_2}\n\n### Photosynthesis III\nSOURCE_URL: https://example.com/phot3\n${SOURCE_EXTRACT_3}`,
};

// A verified-style question. `answer` must be a verbatim substring of `quote`.
function verified(prompt: string, answer: string, quote = SOURCE_EXTRACT) {
  return JSON.stringify({
    q: prompt,
    options: [answer, "Chlorophyll is a green pigment found in plants.", "Mitochondria power the plant's cells.", "Roots draw water from the soil.", "The flower attracts insects for pollination."],
    answer: 0,
    explanation: "Because that is what the passage supports.",
    source_quote: quote,
  });
}

// The queue that the mocked chat pulls from. Defined here (module scope) so
// tests can push into it between sessions.
const CHAT_QUEUE: string[] = [];

// Everything the mocked WebLLM engine needs. vi.hoisted runs before the rest of
// the module body, so the chat mock must be created here, not referenced below.
const webllmMock = vi.hoisted(() => ({
  webgpu: true,
  readyModelId: "qwen",
  chat: vi.fn(async () => CHAT_QUEUE.shift() ?? ""),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  CHAT_QUEUE.length = 0;
  localStorage.clear();
  clearQuestionHistory();

  vi.doMock("./webllm", () => ({ webllm: webllmMock, __esModule: true }));
  vi.doMock("./puter", () => ({
    isSignedIn: () => false,
    puterChat: vi.fn(),
    __esModule: true,
  }));
  vi.doMock("./openrouter", () => ({
    openRouterChat: vi.fn(async () => ""),
    __esModule: true,
  }));
});

async function makeSession() {
  await vi.importActual("./knowledge");
  vi.doMock("./knowledge", async () => {
    const real = await vi.importActual<typeof import("./knowledge")>("./knowledge");
    return { ...real, fetchKnowledge: async () => knowledge };
  });
  const { QuizSession } = await import("./ai");
  const session = new QuizSession(ctx, "Photosynthesis", "medium");
  await session.prepare();
  return session;
}

describe("Forge: cross-session no-repeat — end to end", () => {
  it("returns a model question and persists its prompt so a later session can see it", async () => {
    CHAT_QUEUE.push(
      verified(
        "How much oxygen does a hectare of plants produce via photosynthesis each year?",
        "About 500 liters of oxygen per hectare each year",
      ),
    );
    const session = await makeSession();
    const q = await session.nextQuestion();
    expect(q).not.toBeNull();
    expect(q!.q).toBe("How much oxygen does a hectare of plants produce via photosynthesis each year?");
    expect(loadAskedPrompts().has("How much oxygen does a hectare of plants produce via photosynthesis each year?")).toBe(true);
  });

  it("a fresh session never surfaces a prompt recorded by an earlier session, even if the model repeats it", async () => {
    // Session A records the first prompt.
    CHAT_QUEUE.push(
      verified(
        "How much oxygen does a hectare of plants produce via photosynthesis each year?",
        "About 500 liters of oxygen per hectare each year",
      ),
    );
    const a = await makeSession();
    const aQ = await a.nextQuestion();
    expect(aQ!.q).toBe("How much oxygen does a hectare of plants produce via photosynthesis each year?");
    expect(loadAskedPrompts().size).toBe(1);

    // Session B (a fresh QuizSession whose dedup set is re-seeded from storage):
    // the model AGAIN returns Q1 — an uncooperative model ignoring the dedup. The
    // engine must not surface Q1; it falls back to a fresh extractive question
    // instead, and that new prompt gets recorded.
    CHAT_QUEUE.push(
      verified(
        "How much oxygen does a hectare of plants produce via photosynthesis each year?",
        "About 500 liters of oxygen per hectare each year",
      ),
    );
    const b = await makeSession();
    const bQ = await b.nextQuestion();
    expect(bQ).not.toBeNull();
    // The repeated prompt is never surfaced.
    expect(bQ!.q).not.toBe("How much oxygen does a hectare of plants produce via photosynthesis each year?");
    // A genuinely new prompt is recorded rather than the old one repeating.
    expect(loadAskedPrompts().size).toBe(2);
  });

  it("persists up to the dedup limit without overflowing storage", async () => {
    for (let i = 0; i < DEDUP_LIMIT + 20; i++) recordAskedPrompt(`Prompt ${i}`);
    expect(loadAskedPrompts().size).toBeLessThanOrEqual(DEDUP_LIMIT);
  });
});

describe("Forge: batch buffer (startBatchRefill)", () => {
  // Distinct questions — each has its own prompt AND its own source quote, so
  // neither the prompt nor the fact-key collides (which is what keeps the
  // batch's no-repeat guard from kicking in).
  function uniqueVerified(q: string, answer: string, quote: string) {
    return JSON.stringify({
      q,
      options: [answer, "A distractor idea", "Another distractor", "A competing view"],
      answer: 0,
      explanation: "Supported by the source.",
      source_quote: quote,
    });
  }

  const UNIQUE_QUESTIONS = [
    uniqueVerified(
      "How does photosynthesis store energy from sunlight?",
      "store the chemical energy",
      "Starch is the main way plants store the chemical energy they make from sunlight through photosynthesis.",
    ),
    uniqueVerified(
      "How much oxygen does a hectare of plants produce via photosynthesis each year?",
      "about 500 liters of oxygen",
      "The study found that photosynthesis produces about 500 liters of oxygen per hectare each year, based on data collected in 2019.",
    ),
    uniqueVerified(
      "When does the plant turn sunlight into chemical energy?",
      "during the day",
      "The plant cell uses chlorophyll to absorb sunlight and turns it into chemical energy during the day, according to the 2020 field study.",
    ),
  ];

  /** Poll until `predicate()` is true or the call rejects. */
  async function waitFor(predicate: () => boolean, timeoutMs = 1000) {
    const start = Date.now();
    while (!predicate()) {
      await new Promise((r) => setTimeout(r, 5));
      if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    }
  }

  it("fills a rolling buffer of PREBUFFER distinct questions without repeating prompts", async () => {
    // Queue ahead of playback so the batch can pre-fill without pausing.
    for (const payload of UNIQUE_QUESTIONS) CHAT_QUEUE.push(payload);

    const session = await makeSession();
    (session as any).startBatchRefill((session as any).knowledge);

    await waitFor(() => (session as any).buffer.length >= PREBUFFER);

    const buffer = (session as any).buffer as any[];
    expect(buffer.length).toBe(PREBUFFER);

    // No prompt repeats across the buffer — the no-repeat contract holds in-batch.
    const prompts = buffer.map((q) => q.q).map((p) => p.toLowerCase().replace(/\W+/g, " "));
    expect(new Set(prompts).size).toBe(PREBUFFER);

    // Every generated prompt is remembered so later sessions never repeat it.
    for (const q of buffer) expect(loadAskedPrompts().has(q.q)).toBe(true);
  });

  it("stops the batch cleanly when sources run dry instead of looping forever", async () => {
    // Only one model answer queued — the buffer should fill with that one and
    // then terminate rather than spinning waiting for more.
    CHAT_QUEUE.push(
      uniqueVerified(
        "How much oxygen does a hectare of plants produce via photosynthesis each year?",
        "about 500 liters of oxygen",
        "The study found that photosynthesis produces about 500 liters of oxygen per hectare each year, based on data collected in 2019.",
      ),
    );
    const session = await makeSession();
    (session as any).startBatchRefill((session as any).knowledge);

    await waitFor(() => !((session as any).batchRefill));
    const buffer = (session as any).buffer as any[];
    expect(buffer.length).toBeLessThanOrEqual(PREBUFFER);
  });
});
