import { useCallback, useEffect, useRef, useState } from "react";
import {
  askOpenRouter,
  askPuter,
  askWebLLM,
  generateOneWithOpenRouter,
  generateOneWithPuter,
  generateOneWithWebLLM,
  getErrorMessage,
  getPuterUser,
  isWebLLMCached,
  loadWebLLM,
  WEBLLM_FAST_MODEL,
  webLLMReady,
  signInToPuter,
  signOutOfPuter,
  supportsWebGPU,
  WEBLLM_MODELS,
} from "../lib/ai";
import { fetchInternetResearch } from "../lib/internetResearch";
import {
  advanceToNext,
  bufferedCount,
  currentQuestion,
  nextQuestion,
  isGeneratingNext,
  pipelineStatus,
  resetRelayPipeline,
  seedRelayPipeline,
} from "../lib/questionPipeline";
import { loadAISettings, loadAskedPrompts, loadOpenRouterKey, loadSubjectFacts, recordPrompt, recordQuestionFact, saveAISettings, saveOpenRouterKey, loadQuestionHistory, saveQuestionHistory } from "../lib/storage";
import { QUESTION_ASPECTS, factKeyForQuestion } from "../lib/quizGeneration";
import type { AIProgress, AIProvider, AISettings, Difficulty, HintResult, Question, QuestionHistoryItem } from "../types";

interface NetworkInformation { saveData?: boolean; effectiveType?: string; }

export type GenerationType = "new" | "repeat";

export function useAI() {
  const [settings, setSettings] = useState<AISettings>(() => loadAISettings());
  const [apiKey, setApiKeyState] = useState(() => loadOpenRouterKey(loadAISettings().rememberKey));
  const [progress, setProgress] = useState<AIProgress>({
    status: supportsWebGPU() ? "idle" : "unsupported",
    progress: 0,
    text: supportsWebGPU() ? "Helper will warm up in the background" : "WebGPU unavailable · cloud and offline helpers still work",
    model: loadAISettings().webllmModel,
  });
  const [busy, setBusy] = useState(false);
  const [generationStage, setGenerationStage] = useState("");
  const [testing, setTesting] = useState(false);
  const [puterUser, setPuterUser] = useState<string | null>(null);
  const [puterChecked, setPuterChecked] = useState(false);
  const [error, setError] = useState("");
  const [generationType, setGenerationType] = useState<GenerationType>("new");
  const loadingRef = useRef(false);

  useEffect(() => { saveAISettings(settings); }, [settings]);

  const updateSettings = useCallback((patch: Partial<AISettings>) => {
    setSettings((current) => ({ ...current, ...patch, ...(patch.webllmModel ? { modelCustomized: true } : {}) }));
    setError("");
  }, []);

  const setGenerationTypeValue = useCallback((type: GenerationType) => {
    setGenerationType(type);
    setError("");
  }, []);

  const setApiKey = useCallback((key: string, remember = settings.rememberKey) => {
    setApiKeyState(key);
    saveOpenRouterKey(key, remember);
  }, [settings.rememberKey]);

  const refreshPuter = useCallback(async () => {
    try { setPuterUser(await getPuterUser()); } catch { setPuterUser(null); }
    setPuterChecked(true);
  }, []);

  const preload = useCallback(async (model = settings.webllmModel) => {
    if (!supportsWebGPU()) {
      const message = "WebGPU is unavailable on this device or browser. Use Puter, OpenRouter, or the offline hint bank instead.";
      setProgress({ status: "unsupported", progress: 0, text: message, model });
      throw new Error(message);
    }
    const models = settings.webllmDual && model === settings.webllmModel && model !== WEBLLM_FAST_MODEL ? [WEBLLM_FAST_MODEL, model] : [model];
    loadingRef.current = true;
    setError("");
    setProgress({ status: "loading", progress: 0, text: models.length > 1 ? `Checking cache for ${models.length} models…` : "Checking the local model cache…", model });
    try {
      await loadWebLLM(models, (value, text) => setProgress({ status: value >= 1 ? "ready" : "loading", progress: value, text, model }));
      setProgress({ status: "ready", progress: 1, text: models.length > 1 ? `Ready · ${models.length} models loaded (relay pipeline active)` : "Ready on this device · persistent cache active", model });
    } catch (caught) {
      const message = getErrorMessage(caught, "The local model could not be loaded.");
      setProgress({ status: "error", progress: 0, text: message, model });
      setError(message);
      throw new Error(message);
    } finally {
      loadingRef.current = false;
    }
  }, [settings.webllmModel, settings.webllmDual]);

  useEffect(() => {
    let active = true;
    void (async () => {
      void refreshPuter();
      if (!settings.autoPreload || !supportsWebGPU()) return;
      const connection = (navigator as Navigator & { connection?: NetworkInformation }).connection;
      if (connection?.saveData) {
        if (active) setProgress({ status: "idle", progress: 0, text: "Auto-download paused because Data Saver is on", model: settings.webllmModel });
        return;
      }
      try {
        const cached = await isWebLLMCached(settings.webllmModel);
        if (active && cached) setProgress({ status: "idle", progress: 0, text: "Model found in cache · loading into WebGPU…", model: settings.webllmModel });
      } catch { /* loadWebLLM will report any actual cache error */ }
      if (active) void preload(settings.webllmModel).catch(() => undefined);
    })();
    return () => { active = false; };
  }, []);

  const signIn = useCallback(async () => {
    setError("");
    try {
      const user = await signInToPuter();
      setPuterUser(user);
      setPuterChecked(true);
      return user;
    } catch (caught) {
      const message = getErrorMessage(caught, "Puter sign-in was not completed.");
      setError(message);
      throw new Error(message);
    }
  }, []);

  const signOut = useCallback(async () => {
    await signOutOfPuter();
    setPuterUser(null);
  }, []);

  const testConnection = useCallback(async () => {
    setTesting(true);
    setError("");
    try {
      const emptyQuestion: Question = { id: "test", category: "Logic", difficulty: 1, prompt: "Connection test", options: ["A", "B", "C", "D"], answer: 0, hint: "", explanation: "" };
      await askOpenRouter(apiKey, settings.openRouterModel, emptyQuestion, true);
      return true;
    } catch (caught) {
      const message = getErrorMessage(caught, "Connection test failed.");
      setError(message);
      throw new Error(message);
    } finally { setTesting(false); }
  }, [apiKey, settings.openRouterModel]);

  const getHint = useCallback(async (question: Question, override?: AIProvider): Promise<HintResult> => {
    const provider = override ?? settings.provider;
    setBusy(true);
    setError("");
    try {
      if (provider === "offline") {
        return question.category === "Custom"
          ? { text: question.hint, source: "Saved with AI-generated question · no new request", isAI: true }
          : { text: question.hint, source: "Offline hint bank", isAI: false };
      }
      if (provider === "webllm") {
        if (progress.model !== settings.webllmModel || progress.status !== "ready") await preload(settings.webllmModel);
        const text = await askWebLLM(settings.webllmModel, question);
        return { text, source: WEBLLM_MODELS.find((item) => item.id === settings.webllmModel)?.name ?? "WebLLM", isAI: true };
      }
      if (provider === "puter") {
        const text = await askPuter(question);
        return { text, source: "Puter · GPT-5.4 Nano", isAI: true };
      }
      const text = await askOpenRouter(apiKey, settings.openRouterModel, question);
      return { text, source: `OpenRouter · ${settings.openRouterModel.split("/").pop()}`, isAI: true };
    } catch (caught) {
      const message = getErrorMessage(caught, "The helper could not create a hint.");
      setError(message);
      throw new Error(message);
    } finally { setBusy(false); }
  }, [apiKey, preload, progress, settings]);

  /** Generate a brand-new question using the relay pipeline (Type 1). */
  const generateNewQuestion = useCallback(async (
    subject: string,
    difficulty: Difficulty,
    excludePrompts: string[] = [],
    facetIndex = 0
  ): Promise<Question> => {
    if (settings.provider === "webllm") {
      const buffered = currentQuestion();
      if (buffered) {
        // A question is already waiting — deliver it instantly and refill.
        const question = buffered;
        void advanceToNext();
        return question;
      }

      // No question ready yet — seed the pipeline with the first question.
      setBusy(true);
      setError("");
      setGenerationStage("Consulting curated sources (encyclopedia, dictionaries, atlas)…");
      try {
        const requireInternet = true;
        const persisted = loadAskedPrompts();
        const exclude = [...new Set([...excludePrompts, ...persisted])];
        let research = null;
        try {
          research = await fetchInternetResearch(subject);
          setGenerationStage(`Grounded in ${research.sources.length} sources · writing first question…`);
        } catch (caught) {
          if (requireInternet) throw caught;
        }

        if (settings.provider === "webllm") {
          if (!research) throw new Error("WebLLM needs live internet sources to avoid hallucinations. Check your connection.");
          const dualModels = settings.webllmDual && settings.webllmModel !== WEBLLM_FAST_MODEL ? [WEBLLM_FAST_MODEL, settings.webllmModel] : [settings.webllmModel];
          if (!webLLMReady(dualModels) || progress.status !== "ready") {
            setGenerationStage("Loading local WebLLM model…");
            await preload(settings.webllmModel);
          }

          const question = await seedRelayPipeline({
            subject,
            difficulty,
            excludePrompts: exclude,
            facetIndex,
            primaryModel: settings.webllmModel,
            research,
          });
          if (!question) throw new Error("The local model could not generate a question.");
          return question;
        }
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Generation failed.");
        throw caught;
      } finally {
        setGenerationStage("");
        setBusy(false);
      }
    }

    // Non-WebLLM providers (Puter, OpenRouter, offline) — direct generation.
    setBusy(true);
    setError("");
    setGenerationStage("Consulting curated sources (encyclopedia, dictionaries, atlas)…");
    try {
      const requireInternet = false;
      const persisted = loadAskedPrompts();
      const exclude = [...new Set([...excludePrompts, ...persisted])];
      const avoidFactKeys = [...new Set(loadSubjectFacts(subject))];
      let research = null;
      try {
        research = await fetchInternetResearch(subject);
        setGenerationStage(`Grounded in ${research.sources.length} sources · writing question…`);
      } catch (caught) {
        if (requireInternet) throw caught;
      }

      const shift = facetIndex;
      const aspect = QUESTION_ASPECTS[((shift % QUESTION_ASPECTS.length) + QUESTION_ASPECTS.length) % QUESTION_ASPECTS.length];
      const related = research?.relatedTerms.filter((term) => term.toLocaleLowerCase() !== subject.toLocaleLowerCase()) ?? [];
      const focus = related.length ? related[((shift % related.length) + related.length) % related.length] : undefined;
      const steer = {
        aspect,
        focus,
        answerHint: ((shift % 4) + 4) % 4,
        usedCorrectAnswers: avoidFactKeys.map((key) => key.split("|").slice(1).join("|")),
        avoidFactKeys,
      };

      if (settings.provider === "puter") {
        const generated = await generateOneWithPuter(subject, difficulty, research, exclude, shift, false, steer);
        recordPrompt(generated.prompt);
        const factKey = factKeyForQuestion(subject, generated.options[generated.answer]);
        generated.factKey = factKey;
        recordQuestionFact(subject, factKey);
        return generated;
      }
      return await generateOneWithOpenRouter(apiKey, settings.openRouterModel, subject, difficulty, research, exclude, shift, false, steer);
    } catch (caught) {
      const message = getErrorMessage(caught, "The provider could not generate this question.");
      setError(message);
      throw caught;
    } finally {
      setGenerationStage("");
      setBusy(false);
    }
  }, [apiKey, preload, progress, settings]);

  /** Re-generate a previous question from history with same subject/difficulty but different wording (Type 2). */
  const repeatPreviousQuestion = useCallback(async (
    previous: QuestionHistoryItem,
    difficulty: Difficulty,
    excludePrompts: string[] = []
  ): Promise<Question> => {
    setBusy(true);
    setError("");
    setGenerationStage("Re-generating previous question with fresh wording…");
    try {
      const subject = previous.subject;
      const research = await fetchInternetResearch(subject);
      const persisted = loadAskedPrompts();
      const exclude = [...new Set([...excludePrompts, ...persisted, previous.prompt])];
      const avoidFactKeys = [...new Set(loadSubjectFacts(subject))];

      // Use a different facet index to force a different angle/subtopic.
      const shift = 100 + Date.now() % QUESTION_ASPECTS.length;
      const aspect = QUESTION_ASPECTS[shift % QUESTION_ASPECTS.length];
      const related = research.relatedTerms.filter((term) => term.toLocaleLowerCase() !== subject.toLocaleLowerCase());
      const focus = related.length ? related[shift % related.length] : undefined;
      const steer = {
        aspect,
        focus,
        answerHint: shift % 4,
        usedCorrectAnswers: avoidFactKeys.map((key) => key.split("|").slice(1).join("|")),
        avoidFactKeys,
      } as const;

      let generated: Question;
      if (settings.provider === "webllm") {
        const dualModels = settings.webllmDual && settings.webllmModel !== WEBLLM_FAST_MODEL ? [WEBLLM_FAST_MODEL, settings.webllmModel] : [settings.webllmModel];
        if (!webLLMReady(dualModels) || progress.status !== "ready") {
          setGenerationStage("Loading local WebLLM model…");
          await preload(settings.webllmModel);
        }
        generated = await generateOneWithWebLLM(
          settings.webllmModel,
          subject,
          difficulty,
          research,
          exclude,
          shift,
          false,
          steer,
        );
      } else if (settings.provider === "puter") {
        generated = await generateOneWithPuter(subject, difficulty, research, exclude, shift, false, steer);
      } else {
        generated = await generateOneWithOpenRouter(apiKey, settings.openRouterModel, subject, difficulty, research, exclude, shift, false, steer);
      }

      recordPrompt(generated.prompt);
      const factKey = factKeyForQuestion(subject, generated.options[generated.answer]);
      generated.factKey = factKey;
      recordQuestionFact(subject, factKey);

      // Save this re-generated question to history too.
      const history = loadQuestionHistory();
      saveQuestionHistory([{
        id: generated.id,
        subject: generated.subject ?? subject,
        prompt: generated.prompt,
        options: generated.options,
        answer: generated.answer,
        explanation: generated.explanation,
        sources: generated.sources,
        createdAt: Date.now(),
      }, ...history]);

      return generated;
    } catch (caught) {
      const message = getErrorMessage(caught, "Could not re-generate the previous question.");
      setError(message);
      throw caught;
    } finally {
      setGenerationStage("");
      setBusy(false);
    }
  }, [apiKey, preload, progress, settings]);

  /** Main entry point used by App.tsx — dispatches based on generation type. */
  const generateSingleQuestion = useCallback(async (
    subject: string,
    difficulty: Difficulty,
    excludePrompts: string[] = [],
    facetIndex = 0
  ): Promise<Question> => {
    if (generationType === "repeat") {
      // For repeat mode, the caller must pass a previous question in excludePrompts[0] as a JSON string
      // or we look up from history. For now, fall back to new generation if no previous is available.
      const history = loadQuestionHistory();
      if (history.length > 0) {
        return repeatPreviousQuestion(history[0], difficulty, excludePrompts);
      }
      // No history — fall through to new generation.
    }
    return generateNewQuestion(subject, difficulty, excludePrompts, facetIndex);
  }, [generationType, generateNewQuestion, repeatPreviousQuestion]);

  /** Get the next pre-generated question from the relay pipeline (called after user answers). */
  const takeNextQuestion = useCallback((): Question | null => {
    if (settings.provider !== "webllm") return null;
    const question = advanceToNext();
    return question;
  }, []);

  return {
    settings,
    updateSettings,
    apiKey,
    setApiKey,
    progress,
    preload,
    busy,
    generationStage,
    generationType,
    setGenerationType: setGenerationTypeValue,
    testing,
    error,
    setError,
    puterUser,
    puterChecked,
    signIn,
    signOut,
    refreshPuter,
    testConnection,
    getHint,
    generateSingleQuestion,
    generateNewQuestion,
    repeatPreviousQuestion,
    takeNextQuestion,
    bufferedCount,
    currentQuestion,
    nextQuestion,
    isGeneratingNext,
    pipelineStatus,
    resetRelayPipeline,
  };
}
