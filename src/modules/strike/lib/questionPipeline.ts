/* Relay question pipeline ("strict two-slot pipeline").
 *
 * Instead of two LLMs racing to generate the same question, models alternate
 * in a strict relay:
 *
 *   Model A generates Q1 → shown to the user immediately
 *   While the user answers Q1, Model B generates Q2 behind the scenes
 *   When Q1 is answered, Q2 is shown immediately, and Model A generates Q3
 *   Models alternate: A → B → A → B, never competing, always one generating ahead
 *
 * The pipeline keeps exactly two slots:
 *   • `current` — the question on screen being answered right now
 *   • `next`    — the question being generated behind the scenes
 *
 * When the player submits an answer, `next` is promoted to `current` and the
 * other model starts generating the following question. If `next` isn't ready
 * yet, the player briefly sees a loading state while it finishes.
 *
 * Every generated question passes through the same validation, prompt
 * persistence (recordPrompt) and fact memory (recordQuestionFact) as the
 * online path, so cross-path dedup stays airtight.
 */
import type { Difficulty, Question } from "../types";
import {
  ensurePipelineModels,
  generateOneWithWebLLM,
  loadedWebLLMModels,
  webLLMReady,
  WEBLLM_FAST_MODEL,
} from "./ai";
import type { InternetResearch } from "./internetResearch";
import { QUESTION_ASPECTS, factKeyForQuestion, type QuestionSteer } from "./quizGeneration";
import { loadAskedPrompts, loadSubjectFacts, recordPrompt, recordQuestionFact } from "./storage";

/** Third rotation model beyond the user's pick and the fast 0.8B companion. */
export const PIPELINE_THIRD_MODEL = "Qwen3.5-2B-q4f16_1-MLC";

/** Maximum number of questions pre-generated ahead (2-slot: current + next). */
export const PIPELINE_DEPTH = 2;

export interface RelayParams {
  subject: string;
  difficulty: Difficulty;
  excludePrompts: string[];
  facetIndex: number;
  primaryModel: string;
  research: InternetResearch | null;
}

/** Two pipeline slots: the question being answered and the one being pre-generated. */
export interface RelaySlot {
  question: Question | null;
  model: string;
  status: "empty" | "generating" | "ready";
  error: string | null;
}

let currentSlot: RelaySlot = { question: null, model: "", status: "empty", error: null };
let nextSlot: RelaySlot = { question: null, model: "", status: "empty", error: null };

let pipelineSubject = "";
let pipelineDifficulty: Difficulty | null = null;
let pipelinePrimaryModel = ""; // user-selected model for pipeline generation
let cachedResearch: InternetResearch | null = null;
let excludePrompts: string[] = [];
let facetIndex = 0;
let modelTurn = 0; // 0 = primary model, 1 = alternate model

let generationInFlight = false;

/** How many questions are ready in the pipeline (0–2). */
export function bufferedCount(): number {
  let count = 0;
  if (currentSlot.status === "ready" && currentSlot.question) count += 1;
  if (nextSlot.status === "ready" && nextSlot.question) count += 1;
  return count;
}

/** The question currently on screen, or null if none is ready yet. */
export function currentQuestion(): Question | null {
  return currentSlot.status === "ready" ? currentSlot.question : null;
}

/** The pre-generated next question, or null if still generating. */
export function nextQuestion(): Question | null {
  return nextSlot.status === "ready" ? nextSlot.question : null;
}

/** Whether a model is currently generating the next question. */
export function isGeneratingNext(): boolean {
  return nextSlot.status === "generating" || generationInFlight;
}

/** Drop everything buffered (new session started elsewhere). */
export function resetRelayPipeline(): void {
  currentSlot = { question: null, model: "", status: "empty", error: null };
  nextSlot = { question: null, model: "", status: "empty", error: null };
  pipelineSubject = "";
  pipelineDifficulty = null;
  cachedResearch = null;
  excludePrompts = [];
  facetIndex = 0;
  modelTurn = 0;
  generationInFlight = false;
}

/** Configure the pipeline for a new subject/difficulty. */
export function configureRelayPipeline(params: Omit<RelayParams, "research"> & { research?: InternetResearch | null }): void {
  const key = params.subject.trim().toLocaleLowerCase();
  const isSameTopic = pipelineSubject === key && pipelineDifficulty === params.difficulty;
  if (!isSameTopic) {
    resetRelayPipeline();
    pipelineSubject = key;
    pipelineDifficulty = params.difficulty;
    pipelinePrimaryModel = params.primaryModel;
    cachedResearch = params.research ?? null;
    excludePrompts = [...new Set([...params.excludePrompts, ...loadAskedPrompts()])];
    facetIndex = 0;
    modelTurn = 0;
  } else {
    cachedResearch = params.research ?? cachedResearch;
    pipelinePrimaryModel = params.primaryModel ?? pipelinePrimaryModel;
    // Merge in any new excludes without losing existing ones.
    excludePrompts = [...new Set([...excludePrompts, ...params.excludePrompts])];
  }
}

/** Promote the next question to current and start generating the one after it.
 *  Call this when the player submits an answer. Returns the promoted question
 *  (ready to show immediately) or null if the pipeline is empty. */
export function advanceToNext(): Question | null {
  if (nextSlot.status !== "ready" || !nextSlot.question) return null;

  // Promote next → current.
  currentSlot = nextSlot;
  nextSlot = { question: null, model: "", status: "empty", error: null };

  // Persist the promoted question's prompt + fact for dedup.
  const promoted = currentSlot.question!;
  recordPrompt(promoted.prompt);
  const factKey = factKeyForQuestion(pipelineSubject, promoted.options[promoted.answer]);
  promoted.factKey = factKey;
  recordQuestionFact(pipelineSubject, factKey);

  // Start generating the following question with the other model.
  void generateNextSlot();

  return promoted;
}

/** Generate the next question in the `next` slot using the other model.
 *  This runs in the background while the player answers the current question. */
async function generateNextSlot(): Promise<void> {
  if (generationInFlight) return;
  if (!cachedResearch) return;

  generationInFlight = true;

  try {
    // Determine which model generates this slot (strict alternation).
    const models = await resolvePipelineModels();
    if (models.length === 0) {
      nextSlot = { question: null, model: "", status: "empty", error: "No WebLLM models loaded" };
      return;
    }

    const model = models[modelTurn % models.length];
    modelTurn += 1;

    nextSlot = { question: null, model, status: "generating", error: null };

    // Build steering for this slot.
    const shift = facetIndex + modelTurn;
    facetIndex += 1;
    const aspect = QUESTION_ASPECTS[shift % QUESTION_ASPECTS.length];
    const related = cachedResearch.relatedTerms.filter((term) => term.toLocaleLowerCase() !== pipelineSubject.toLocaleLowerCase());
    const focus = related.length ? related[shift % related.length] : undefined;

    const queuedPrompts = [currentSlot.question?.prompt, nextSlot.question?.prompt].filter(Boolean) as string[];
    const exclude = [...new Set([...excludePrompts, ...loadAskedPrompts(), ...queuedPrompts])];
    const avoidFactKeys = [...new Set([...loadSubjectFacts(pipelineSubject)])];

    const steer: QuestionSteer = {
      aspect,
      focus,
      answerHint: shift % 4,
      usedCorrectAnswers: avoidFactKeys.map((key) => key.split("|").slice(1).join("|")),
      avoidFactKeys,
    };

    // Two quiet attempts, then give up silently — a slow background worker
    // must never surface an error to the player.
    let question: Question | null = null;
    for (let attemptIndex = 0; attemptIndex < 2 && !question; attemptIndex += 1) {
      try {
        const generated = await generateOneWithWebLLM(
          model,
          pipelineSubject,
          pipelineDifficulty!,
          cachedResearch,
          exclude,
          shift + attemptIndex,
          false,
          { ...steer, answerHint: (shift + attemptIndex) % 4 },
        );
        question = generated;
      } catch { /* try again, then give up silently */ }
    }

    if (question) {
      recordPrompt(question.prompt);
      const factKey = factKeyForQuestion(pipelineSubject, question.options[question.answer]);
      question.factKey = factKey;
      recordQuestionFact(pipelineSubject, factKey);
      nextSlot = { question, model, status: "ready", error: null };
    } else {
      nextSlot = { question: null, model, status: "empty", error: "Generation failed silently" };
    }
  } catch {
    nextSlot = { question: null, model: "", status: "empty", error: "Generation failed" };
  } finally {
    generationInFlight = false;
  }
}

/** Resolve the model set for the pipeline (primary + fast companion + optional third). */
async function resolvePipelineModels(): Promise<string[]> {
  const wanted = [...new Set([pipelinePrimaryModel, WEBLLM_FAST_MODEL, PIPELINE_THIRD_MODEL])].filter(Boolean);
  const loaded = loadedWebLLMModels();
  const available = wanted.filter((m) => loaded.includes(m));
  // If only one model is loaded, just use it for both slots (strict alternation
  // still works — same model, different slot).
  return available.length > 0 ? available : loaded;
}

/** Seed the pipeline: generate the first question immediately with the primary model.
 *  Call this when starting a new subject. Returns the first question. */
export async function seedRelayPipeline(params: RelayParams): Promise<Question> {
  configureRelayPipeline(params);

  const models = await resolvePipelineModels();
  if (models.length === 0) throw new Error("No WebLLM models loaded.");

  const primaryModel = params.primaryModel;
  const model = models.includes(primaryModel) ? primaryModel : models[0];

  // Ensure models are loaded.
  if (!webLLMReady([model])) {
    await ensurePipelineModels([model, ...models.filter((m) => m !== model)]);
  }

  // Generate the first question directly (not via background slot).
  const shift = facetIndex;
  facetIndex += 1;
  const aspect = QUESTION_ASPECTS[shift % QUESTION_ASPECTS.length];
  const related = cachedResearch?.relatedTerms.filter((term) => term.toLocaleLowerCase() !== params.subject.toLocaleLowerCase()) ?? [];
  const focus = related.length ? related[shift % related.length] : undefined;

  const exclude = [...new Set([...params.excludePrompts, ...loadAskedPrompts()])];
  const avoidFactKeys = [...new Set(loadSubjectFacts(params.subject))];

  const steer: QuestionSteer = {
    aspect,
    focus,
    answerHint: shift % 4,
    usedCorrectAnswers: avoidFactKeys.map((key) => key.split("|").slice(1).join("|")),
    avoidFactKeys,
  };

  let question: Question | null = null;
  let lastError: Error | null = null;
  for (let attemptIndex = 0; attemptIndex < 2 && !question; attemptIndex += 1) {
    try {
      const generated = await generateOneWithWebLLM(
        model,
        params.subject,
        params.difficulty,
        cachedResearch!,
        exclude,
        shift + attemptIndex,
        attemptIndex === 1, // reinforceTopic on the second attempt — tell the model to self-correct
        { ...steer, answerHint: (shift + attemptIndex) % 4 },
      );
      question = generated;
    } catch (caught) {
      lastError = caught instanceof Error ? caught : new Error(String(caught));
    }
  }

  if (!question) {
    throw lastError ?? new Error("The local model could not generate a question.");
  }

  recordPrompt(question.prompt);
  const factKey = factKeyForQuestion(params.subject, question.options[question.answer]);
  question.factKey = factKey;
  recordQuestionFact(params.subject, factKey);

  currentSlot = { question, model, status: "ready", error: null };

  // Immediately start generating the next question with the other model.
  void generateNextSlot();

  return question;
}

/** Status summary for UI display. */
export function pipelineStatus(): {
  currentModel: string | null;
  nextModel: string | null;
  nextStatus: RelaySlot["status"];
  nextError: string | null;
} {
  return {
    currentModel: currentSlot.question ? currentSlot.model : null,
    nextModel: nextSlot.question || nextSlot.status === "generating" ? nextSlot.model : null,
    nextStatus: nextSlot.status,
    nextError: nextSlot.error,
  };
}