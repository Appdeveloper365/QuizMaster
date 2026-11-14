import type { ChatMsg, ProviderId, Question } from "./types";
import { webllm } from "./webllm";
import { isSignedIn, puterChat } from "./puter";
import { openRouterChat } from "./openrouter";
import { fetchKnowledge, isGrounded, type Knowledge, type KnowledgeSource } from "./knowledge";
import { buildExtractiveQuestions } from "./extractive";
import {
  loadAskedPrompts,
  loadQuestionMemory,
  recordAskedPrompt,
  recordQuestion,
} from "./store";

/* Live search is performed by the app and passed to WebLLM as retrieval context.
   Model-created questions are accepted only when their answer is supported by an
   exact source quote; otherwise a deterministic source-extractive question is used. */

export interface AIContext {
  provider: ProviderId;
  openrouterKey: string;
  openrouterModel: string;
}

function topicLabel(category: string): string {
  return category.trim();
}

const DIFF_HINT: Record<string, string> = {
  easy: "beginner-friendly, well-known facts",
  medium: "moderately tricky, requires real familiarity",
  hard: "challenging, specific details an enthusiast would know",
  expert: "expert-level, obscure but verifiable facts",
};

/** Round-robined question angles so consecutive questions probe different
 *  facets of the topic instead of rewording the same salient fact. */
const QUESTION_ASPECTS = [
  "the underlying mechanism — how does it actually work, step by step",
  "a causal chain — what causes it, and what it causes in turn",
  "a concrete quantity, year, distance, or otherwise measurable fact",
  "a key person or group and the specific role they played",
  "a comparison or contrast between two things within the subject",
  "the order or timeline of events",
  "a precise term and what it actually denotes, as opposed to a common misreading",
  "a common misconception and what is actually true instead",
  "a real-world application, use case, or consequence",
  "a small but verifiable distinguishing detail that separates it from a related thing",
  "a boundary or edge case — when it breaks, fails, or does not apply",
  "its relationship to a neighbouring field or closely related subtopic",
];

function aspectFor(index: number): string {
  const count = QUESTION_ASPECTS.length;
  return QUESTION_ASPECTS[((index % count) + count) % count];
}

/* ── ONE question per request ── small JSON, fast on 1B–3B on-device models ── */
function buildSystemOne(topic: string, difficulty: string, k: Knowledge | null): string {
  const grounded = !!k?.context;
  return `You write ONE multiple-choice quiz question at a time about the topic: "${topic}".
${grounded ? `The app performed a live internet search and supplied the results below. Use the supplied related-topic sources as your search index. Do not answer from memory.` : ""}
STRICT RULES:
1. Write one clear question that probes the ideas behind the user's full subject or one of its related subtopics — ${DIFF_HINT[difficulty] ?? DIFF_HINT.medium}. Ask how/why/what-if: mechanisms, causes and effects, comparisons, assumptions, applications, or consequences.
2. Use only the selected article's source text. Exactly 4 options; exactly one is correct.
3. Do NOT quiz on verbatim wording. The correct option should be phrased in your OWN words, and the distractors should be plausible misunderstandings rather than random word swaps. The question should reward genuine understanding, not memorized or lifted text.
4. The correct option must appear in source_quote, which is the exact full source sentence that supports it. Copy the quote exactly from the source text; never invent or paraphrase the quote.
5. "answer" is the 0-based index (0,1,2,3); "explanation" is one short factual sentence.
6. No duplicate questions, no "all/none of the above". Output only compact JSON, no markdown or commentary.
Format: {"q":"...","options":["...","...","...","..."],"answer":0,"explanation":"...","source_quote":"exact sentence copied from source"}`;
}

type Runner = (sys: string, user: string) => Promise<string>;

function makeRunners(ctx: AIContext): Array<{ id: ProviderId; label: string; available: boolean; run: Runner }> {
  const or: Runner = (sys, user) =>
    openRouterChat(ctx.openrouterKey, ctx.openrouterModel, [{ role: "system", content: sys }, { role: "user", content: user }], { maxTokens: 400, temperature: 0.4 });
  const pu: Runner = (sys, user) => puterChat(`${sys}\n\n${user}`);
  const wl: Runner = (sys, user) =>
    webllm.chat([{ role: "system", content: sys }, { role: "user", content: user }], undefined, 360, 0.35);

  const all = [
    { id: "webllm" as const, label: "On-device AI", available: webllm.webgpu, run: wl },
    { id: "puter" as const, label: "Puter AI", available: isSignedIn(), run: pu },
    { id: "openrouter" as const, label: "OpenRouter AI", available: !!ctx.openrouterKey.trim(), run: or },
  ];
  // Selected provider first, then the rest as fallbacks.
  return [...all.filter((a) => a.id === ctx.provider), ...all.filter((a) => a.id !== ctx.provider)];
}

/* ─────────────────────────────────────────────────────────────
   On-demand, one-question session. Sources are fetched once; each
   call to nextQuestion() searches that source pack and generates only
   the next item. WebLLM receives the app's live search results as its
   retrieval context. Every model answer must cite an exact source quote.
   ───────────────────────────────────────────────────────────── */
export interface SessionEvents {
  onStatus?: (s: string) => void;
  onSources?: (sources: Array<{ title: string; url: string }>, grounded: boolean) => void;
  onBatchProgress?: (buffered: number, requested: number) => void;
}

/** How many questions to keep pre-buffered ahead of the player. */
export const PREBUFFER = 3;

/** Fire every available provider at once; the first verified answer wins. */
async function generateOneFast(
  ctx: AIContext,
  k: Knowledge,
  topic: string,
  difficulty: string,
  index: number,
  asked: string[],
  category: string
): Promise<Question | null> {
  const engines = makeRunners(ctx).filter(
    (r) => r.available && (r.id !== "webllm" || !!webllm.readyModelId)
  );
  if (!engines.length) return null;
  const sys = buildSystemOne(topic, difficulty, k);
  const focusSource = k.sources[index % k.sources.length];

  const results = await Promise.allSettled(
    engines.map(async (r) => {
      const prompt = buildOneQuestionPrompt(topic, difficulty, index, asked, focusSource);
      const raw = await r.run(sys, prompt);
      const parsed = parseOne(raw, category, difficulty);
      const verified = parsed && verifyGeneratedQuestion(parsed, k);
      if (verified) return verified;
      return null;
    })
  );
  for (const res of results) {
    if (res.status === "fulfilled" && res.value) return res.value;
  }
  return null;
}

function normalizeEvidence(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
}

function verifyGeneratedQuestion(q: Question, k: Knowledge): Question | null {
  const quote = q.sourceSentence?.trim();
  if (!quote || quote.length < 35) return null;
  const quoteN = normalizeEvidence(quote);
  const answerN = normalizeEvidence(q.options[q.answer] ?? "");
  if (answerN.length < 2 || !quoteN.includes(answerN)) return null;
  const source = k.sources.find((s) => normalizeEvidence(s.extract).includes(quoteN));
  if (!source) return null;
  if (!isGrounded(k, `${q.q} ${quote} ${q.options[q.answer]}`)) return null;
  return {
    ...q,
    verified: true,
    sourceSentence: quote,
    sourceTitle: source.title,
    sourceUrl: source.url,
  };
}

export class QuizSession {
  readonly questions: Question[] = [];
  readonly attempts: string[] = [];
  sources: Array<{ title: string; url: string }> = [];
  grounded = false;
  source = "";
  knowledge: Knowledge | null = null;
  error: string | null = null;
  private asked: string[] = [];
  private usedFacts = new Set<string>();
  // Pre-seeded from the persisted cross-session set so a topic never repeats a
  // previously generated question across app restarts or model switches.
  private usedQuestionKeys = new Set<string>([...loadAskedPrompts()].map(normalizeEvidence));
  /** Pre-generated questions awaiting the player (rolling window). */
  private buffer: Question[] = [];
  /** Idle promise for the in-flight batch refill, so two callers don't overlap. */
  private batchRefill: Promise<void> | null = null;
  private ctrl = new AbortController();
  private preparing: Promise<void> | null = null;
  private generating = false;

  constructor(
    private ctx: AIContext,
    readonly category: string,
    readonly difficulty: string,
    private ev: SessionEvents = {}
  ) {
    // Seed both dedup sets from the durable question memory so a fresh session
    // can't reuse a stale question or source fact after an app restart.
    for (const entry of loadQuestionMemory()) {
      this.usedQuestionKeys.add(normalizeEvidence(entry.q));
      this.usedFacts.add(entry.factKey);
    }
  }

  get signal() {
    return this.ctrl.signal;
  }

  cancel() {
    this.ctrl.abort();
  }

  async prepare(): Promise<void> {
    if (this.preparing) return this.preparing;
    this.preparing = (async () => {
      const onStatus = this.ev.onStatus;
      onStatus?.(`Searching the internet for “${this.category}” and related topics…`);
      const t0 = performance.now();
      this.knowledge = await fetchKnowledge(this.category, { signal: this.ctrl.signal, onStatus });
      if (this.ctrl.signal.aborted) throw new Error("Cancelled.");
      const k = this.knowledge;
      if (!k.context || !k.sources.length) {
        throw new Error(k.online
          ? `No useful internet sources were found for “${this.category}”. Try a more specific topic.`
          : "The internet search is unavailable. Connect to the internet and retry.");
      }
      this.grounded = true;
      this.sources = k.sources.map((s) => ({ title: s.title, url: s.url }));
      this.ev.onSources?.(this.sources, true);
      this.attempts.push(`Internet search: ${k.sources.length} related sources ready in ${Math.round(performance.now() - t0)} ms`);
      this.source = "Live web search · verified sources";
      onStatus?.(`Found ${k.sources.length} related sources. Ready to generate one question at a time.`);
    })();
    return this.preparing;
  }

  /** Pull up to `n` buffered questions (used by the single-question UI). */
  private pullFromBuffer(n: number): Question[] {
    const out: Question[] = [];
    while (out.length < n && this.buffer.length) {
      const q = this.buffer.shift()!;
      this.commit(q, `${q.sourceTitle ?? ""}|${normalizeEvidence(q.sourceSentence ?? "")}`);
      out.push(q);
    }
    return out;
  }

  /** Pull one question (the UI contract), pre-buffering the rest. */
  async nextQuestion(): Promise<Question | null> {
    if (this.ctrl.signal.aborted) return null;
    if (!this.knowledge) await this.prepare();
    const k = this.knowledge;
    if (!k?.context) return null;

    // Pull any already-buffered question first (the background batch fills this).
    const pulled = this.pullFromBuffer(1);
    if (pulled.length) {
      this.startBatchRefill(k);
      return pulled[0];
    }

    // Buffer is empty — generate one synchronously so the player always gets a
    // question. Only the UI decides to warm the buffer for faster play.
    const index = this.questions.length;
    const topic = topicLabel(this.category);
    if (!this.generating) {
      this.generating = true;
      try {
        const q = await this.generateOneSynchronous(k, topic, index);
        if (q) this.commit(q, `${q.sourceTitle ?? ""}|${normalizeEvidence(q.sourceSentence ?? "")}`);
        return q;
      } finally {
        this.generating = false;
      }
    }
    return null;
  }

  /**
   * Pre-generate a rolling buffer ahead of the player so play never stalls waiting
   * on the model. Only warm once the first question is in hand; the buffer is kept
   * at `PREBUFFER` questions. Idempotent — only one batch runs at a time.
   */
  startBatchRefill(k: Knowledge): void {
    if (this.batchRefill || this.buffer.length >= PREBUFFER) return;
    const topic = topicLabel(this.category);
    this.batchRefill = (async () => {
      await new Promise((r) => setTimeout(r, 0));
      try {
        while (this.buffer.length < PREBUFFER && !this.ctrl.signal.aborted) {
          const index = this.questions.length;
          const q = await generateOneFast(
            this.ctx, k, topic, this.difficulty, index, this.asked, this.category
          );
          console.error("[BATCH] iter", index, "buffer=", this.buffer.length, "q=", !!q, "dup=", q && this.isDuplicate(q));
          if (q && !this.isDuplicate(q)) {
            this.commit(q, `${q.sourceTitle ?? ""}|${normalizeEvidence(q.sourceSentence ?? "")}`);
          } else {
            const extracted = buildExtractiveQuestions(k, this.category, this.difficulty, 1, [...this.usedFacts]);
            console.error("[BATCH] extract=", !!(extracted && extracted[0]), "usedFacts=", this.usedFacts.size);
            if (extracted[0]) this.commit(extracted[0], `${extracted[0].sourceTitle}|${normalizeEvidence(extracted[0].sourceSentence ?? "")}`);
            else break;
          }
          this.ev.onBatchProgress?.(this.buffer.length, PREBUFFER);
        }
      } catch {
        /* cancelled */
      } finally {
        this.batchRefill = null;
      }
    })();
  }

  private async generateOneSynchronous(k: Knowledge, topic: string, index: number): Promise<Question | null> {
    const engines = makeRunners(this.ctx).filter(
      (r) => r.available && (r.id !== "webllm" || !!webllm.readyModelId)
    );
    if (!engines.length) return null;
    const focusSource = k.sources[index % k.sources.length];
    const sys = buildSystemOne(topic, this.difficulty, k);
    for (const r of engines) {
      if (this.ctrl.signal.aborted) return null;
      try {
        this.ev.onStatus?.(`${r.label} is generating question ${this.questions.length + 1} from “${focusSource.title}”…`);
        const prompt = buildOneQuestionPrompt(topic, this.difficulty, index, this.asked, focusSource);
        const raw = await r.run(sys, prompt);
        const parsed = parseOne(raw, this.category, this.difficulty);
        const verified = parsed && verifyGeneratedQuestion(parsed, k);
        if (verified) {
          if (this.isDuplicate(verified)) {
            this.attempts.push(`${r.label}: duplicate source fact rejected`);
            continue;
          }
          return verified;
        }
        this.attempts.push(`${r.label}: answer/source quote failed verification`);
      } catch (e: any) {
        this.attempts.push(`${r.label}: ${e?.message ?? "generation failed"}`);
        if (/key|sign in|unauthorized|401|403/i.test(String(e?.message))) continue;
      }
    }

    // Zero-latency verified fallback: blanks one fact directly from a fetched source.
    const extracted = buildExtractiveQuestions(k, this.category, this.difficulty, 1, [...this.usedFacts]);
    const q = extracted[0];
    if (!q) {
      this.error = `No more distinct verified facts were found for “${topic}”.`;
      this.ev.onStatus?.(this.error);
      return null;
    }
    return q;
  }

  private commit(q: Question, factKey: string) {
    this.questions.push(q);
    this.asked.push(q.q);
    this.usedFacts.add(factKey);
    this.usedQuestionKeys.add(normalizeEvidence(q.q));
    recordAskedPrompt(q.q);
    // Persist to the durable question memory so a fresh session never reuses
    // this question or its source fact, even after an app restart.
    recordQuestion({ topic: this.category, q: q.q, factKey });
    this.buffer.push(q);
  }

  /** True if this question repeats a prompt already asked (same question text or
      same source fact). Used to keep the model's "do not repeat" instruction
      enforced even when a small model ignores the prompt and returns a duplicate
      that still passes verification. */
  private isDuplicate(q: Question): boolean {
    const factKey = `${q.sourceTitle ?? ""}|${normalizeEvidence(q.sourceSentence ?? "")}`;
    return this.usedQuestionKeys.has(normalizeEvidence(q.q)) || this.usedFacts.has(factKey);
  }
}

function buildOneQuestionPrompt(topic: string, difficulty: string, index: number, asked: string[], source: KnowledgeSource): string {
  // Prompt window is capped (validation still checks the full dedup sets) so
  // long sessions don't bloat the context window of on-device models.
  const history = asked.length ? `Already asked — do not repeat (recently): ${asked.slice(-8).join(" | ")}\n\n` : "";
  return `REQUIRED ANGLE for this question — pick facts that fit it: ${aspectFor(index)}

LIVE WEB SEARCH RESULT (the app retrieved this article for the topic and related subtopics):
Article: ${source.title}
URL: ${source.url}
Source text:
${source.extract}

${history}TOPIC FRAMING: Treat "${topic}" as a subject to genuinely understand — its mechanisms, types, processes, causes, applications and effects — NOT as a vocabulary word to define. Never ask what the word means, how it is spelled, or its etymology. Generate exactly ONE ${difficulty} multiple-choice question about "${topic}" that is specifically supported by this article. Use a different fact from earlier questions. Probe the IDEAS behind the topic — mechanisms, causes/effects, comparisons, assumptions, applications, or consequences — rather than verbatim wording. Phrase the correct option in your OWN words (not a phrase lifted from the article) and make the distractors plausible misunderstandings. The correct answer must be supported by source_quote (the exact source sentence that supports it). Use four options and the 0-based correct answer index. Vary the answer position; preferred position ${index % 4}.
Return ONLY JSON: {"q":"...","options":["...","...","...","..."],"answer":0,"explanation":"...","source_quote":"exact source sentence"}`;
}

function parseOne(raw: string, category: string, difficulty: string): Question | null {
  const text = String(raw ?? "").replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```(?:json)?/gi, "").trim();
  const data = extractJson(text);
  if (!data || typeof data !== "object") return null;
  const item = Array.isArray(data) ? data[0] : Array.isArray(data.questions) ? data.questions[0] : data.question && typeof data.question === "object" ? data.question : data;
  if (!item || typeof item !== "object") return null;
  return parseQuestions(JSON.stringify({ questions: [item] }), category, difficulty, 1)[0] ?? null;
}

/* ── robust parser: handles fences, <think>, top-level arrays, letter answers, alt field names ── */
function parseQuestions(raw: string, category: string, difficulty: string, count: number): Question[] {
  let text = String(raw ?? "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:json)?/gi, "")
    .trim();

  const data = extractJson(text);
  if (!data) return [];
  const list: any[] = Array.isArray(data) ? data : Array.isArray(data.questions) ? data.questions : Array.isArray(data.quiz) ? data.quiz : Array.isArray(data.items) ? data.items : [];
  const seen = new Set<string>();
  const out: Question[] = [];

  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const qText = String(item.q ?? item.question ?? item.prompt ?? "").trim();
    let opts: string[] = (item.options ?? item.choices ?? item.answers ?? []) as any;
    if (!Array.isArray(opts)) {
      if (opts && typeof opts === "object") opts = Object.values(opts as Record<string, string>);
      else continue;
    }
    opts = opts.map((o) => String(o).replace(/^[A-Da-d][).:\-]\s*/, "").trim()).filter(Boolean);
    if (!qText || opts.length < 4) continue;
    opts = opts.slice(0, 4);

    let ans = resolveAnswer(item.answer ?? item.correct ?? item.correct_answer ?? item.correctIndex ?? item.answer_index, opts);
    if (ans < 0) continue;

    const key = qText.toLowerCase().replace(/\W+/g, " ").slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      q: qText,
      options: opts,
      answer: ans,
      explanation: String(item.explanation ?? item.why ?? "Nice one — keep going!").trim(),
      category,
      difficulty,
      sourceSentence: String(item.source_quote ?? item.source_sentence ?? item.sourceQuote ?? "").trim() || undefined,
    });
    if (out.length >= count) break;
  }
  return out;
}

function resolveAnswer(a: unknown, opts: string[]): number {
  if (typeof a === "number" && Number.isInteger(a)) {
    if (a >= 0 && a <= 3) return a;
    if (a >= 1 && a <= 4 && opts.length === 4) return a - 1; // 1-based
    return -1;
  }
  if (typeof a === "string") {
    const s = a.trim();
    if (/^[0-3]$/.test(s)) return Number(s);
    if (/^[A-Da-d]$/.test(s)) return s.toUpperCase().charCodeAt(0) - 65;
    const idx = opts.findIndex((o) => o.toLowerCase() === s.toLowerCase());
    if (idx >= 0) return idx;
    const m = s.match(/^[A-Da-d][).:\-]\s*(.+)$/);
    if (m) {
      const j = opts.findIndex((o) => o.toLowerCase() === m[1].trim().toLowerCase());
      if (j >= 0) return j;
      return s.toUpperCase().charCodeAt(0) - 65;
    }
  }
  return -1;
}

function extractJson(text: string): any | null {
  // Try whole string first.
  try {
    return JSON.parse(text);
  } catch {
    /* continue */
  }
  // Object or array slice.
  const candidates: Array<[number, number]> = [];
  const oS = text.indexOf("{");
  const oE = text.lastIndexOf("}");
  const aS = text.indexOf("[");
  const aE = text.lastIndexOf("]");
  if (oS >= 0 && oE > oS) candidates.push([oS, oE]);
  if (aS >= 0 && aE > aS) candidates.push([aS, aE]);
  candidates.sort((x, y) => x[0] - y[0]);
  for (const [s, e] of candidates) {
    const slice = text.slice(s, e + 1);
    try {
      return JSON.parse(slice);
    } catch {
      // Repair common small-model issues: trailing commas, smart quotes.
      try {
        return JSON.parse(slice.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/,\s*([}\]])/g, "$1"));
      } catch {
        /* next */
      }
    }
  }
  // Truncated output: salvage complete question objects.
  const objs = text.match(/\{[^{}]*"q(?:uestion)?"\s*:[^{}]*\}/g);
  if (objs) {
    const items: any[] = [];
    for (const o of objs) {
      try {
        items.push(JSON.parse(o.replace(/,\s*([}\]])/g, "$1")));
      } catch {
        /* skip */
      }
    }
    if (items.length) return { questions: items };
  }
  return null;
}

export async function getHint(ctx: AIContext, q: Question, used: number): Promise<string> {
  const prompt = `Quiz question (topic: ${q.category}): "${q.q}"\nOptions: ${q.options.map((o, i) => `${"ABCD"[i]}) ${o}`).join(", ")}\nGive a short hint (max 25 words) that nudges toward the answer WITHOUT stating it directly. Hint #${used + 1}.`;
  const sys = "You are a friendly quiz coach. Be brief and encouraging.";
  const tries: Array<() => Promise<string>> = [];
  if (ctx.provider === "webllm" && webllm.readyModelId) tries.push(() => webllm.chat([{ role: "system", content: sys }, { role: "user", content: prompt }], undefined, 120));
  if (ctx.provider === "puter" && isSignedIn()) tries.push(() => puterChat(`${sys}\n\n${prompt}`));
  if (ctx.provider === "openrouter" && ctx.openrouterKey) tries.push(() => openRouterChat(ctx.openrouterKey, ctx.openrouterModel, [{ role: "system", content: sys }, { role: "user", content: prompt }], { maxTokens: 120 }));
  if (webllm.readyModelId && ctx.provider !== "webllm") tries.push(() => webllm.chat([{ role: "system", content: sys }, { role: "user", content: prompt }], undefined, 120));
  if (isSignedIn() && ctx.provider !== "puter") tries.push(() => puterChat(`${sys}\n\n${prompt}`));
  if (ctx.openrouterKey && ctx.provider !== "openrouter") tries.push(() => openRouterChat(ctx.openrouterKey, ctx.openrouterModel, [{ role: "system", content: sys }, { role: "user", content: prompt }], { maxTokens: 120 }));

  for (const t of tries) {
    try {
      const r = (await t()).replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
      if (r) return r;
    } catch {
      /* next */
    }
  }
  const firstLetters = q.options.map((o) => o.trim()[0] ?? "?").join(", ");
  return `Think about ${q.category.toLowerCase()} — the answer starts with one of: ${firstLetters}.`;
}

export async function chatWithAI(
  ctx: AIContext,
  messages: ChatMsg[],
  onToken?: (t: string) => void
): Promise<string> {
  const sys: ChatMsg = { role: "system", content: "You are Forge, the BrainForge AI quiz coach. Helpful, concise, encouraging. Explain quiz concepts simply." };
  const full = [sys, ...messages];
  const order: ProviderId[] = [ctx.provider, "webllm", "puter", "openrouter"].filter((v, i, a) => a.indexOf(v) === i) as ProviderId[];
  let lastErr: unknown = null;
  for (const p of order) {
    try {
      if (p === "webllm") {
        if (!webllm.readyModelId) continue;
        return await webllm.chat(full, onToken, 700);
      }
      if (p === "puter") {
        if (!isSignedIn()) continue;
        const text = await puterChat(full.map((m) => `${m.role}: ${m.content}`).join("\n\n"));
        onToken?.(text);
        return text;
      }
      if (p === "openrouter") {
        if (!ctx.openrouterKey) continue;
        const text = await openRouterChat(ctx.openrouterKey, ctx.openrouterModel, full, { maxTokens: 700 });
        onToken?.(text);
        return text;
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("No AI provider available. Sign in with Puter, add an OpenRouter key, or wait for the on-device model.");
}
