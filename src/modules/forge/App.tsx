import { useEffect, useRef, useState } from "react";
import { ArrowRight, ExternalLink, Home, LoaderCircle, Sparkles } from "lucide-react";
import { QuizSession } from "./lib/ai";
import { waitForPuter, signInWithPuter, isSignedIn, getUser } from "./lib/puter";
import { webllm } from "./lib/webllm";
import { prefetchKnowledge } from "./lib/knowledge";
import { loadSettings, saveGeneratedQuestion, saveSettings } from "./lib/store";
import type { ProviderId, PuterUser, Question, Settings } from "./lib/types";
import "./index.css";
import { beep } from "./components/ui";
import { cn } from "@/utils/cn";

// One-time startup guard — StrictMode double-invokes effects in development.
let booted = false;

interface SessionSlot {
  session: QuizSession;
  topic: string;
  difficulty: string;
  provider: ProviderId;
  openrouterKey: string;
}

const LEVELS = [
  { id: "easy", label: "Simple" },
  { id: "medium", label: "Medium" },
  { id: "hard", label: "Hard" },
  { id: "expert", label: "Expert" },
];

export default function App({ onBack }: { onBack?: () => void }) {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const [subject, setSubject] = useState("");
  const subjectRef = useRef(subject);
  subjectRef.current = subject;
  const [difficulty, setDifficulty] = useState("medium");

  const difficultyRef = useRef(difficulty);
  difficultyRef.current = difficulty;

  const [question, setQuestion] = useState<Question | null>(null);
  const [questionNumber, setQuestionNumber] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [correctAnswer, setCorrectAnswer] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const [sessionActive, setSessionActive] = useState(false);
  const [puterReady, setPuterReady] = useState(false);
  const [puterUser, setPuterUser] = useState<PuterUser | null>(null);
  const [showOpenRouterKey, setShowOpenRouterKey] = useState(settings.provider === "openrouter");
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const sessionRef = useRef<SessionSlot | null>(null);
  const answerTimer = useRef<number | null>(null);
  const searchTimer = useRef<number | null>(null);

  useEffect(() => {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
    // Guard one-time startup side effects (StrictMode double-invokes effects in dev).
    if (!booted) {
      booted = true;
      void webllm.initBundled();
      // Pre-fetch the strong on-device model in the background after first paint.
      void webllm.startBackgroundPrecache();
    }
    let alive = true;
    void waitForPuter(7000).then(async (ready) => {
      if (!alive) return;
      setPuterReady(ready);
      if (ready && isSignedIn()) setPuterUser(await getUser());
    });
    return () => {
      alive = false;
      if (answerTimer.current) clearTimeout(answerTimer.current);
      sessionRef.current?.session.cancel();
    };
  }, []);

  function updateSettings(next: Settings) {
    settingsRef.current = next;
    setSettings(next);
    saveSettings(next);
  }

  function typeSubject(value: string) {
    setSubject(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const topic = value.trim().replace(/\s+/g, " ");
    if (topic.length >= 3) searchTimer.current = window.setTimeout(() => prefetchKnowledge(topic), 450);
  }

  function startNewSession(topicValue = subjectRef.current, level = difficultyRef.current) {
    const topic = topicValue.trim().replace(/\s+/g, " ");
    if (topic.length < 2) {
      setError("Type a subject first.");
      return;
    }
    sessionRef.current?.session.cancel();
    const selectedSettings = settingsRef.current;
    let slot: SessionSlot;
    const session = new QuizSession(
      {
        provider: selectedSettings.provider,
        openrouterKey: selectedSettings.openrouterKey,
        openrouterModel: selectedSettings.openrouterModel,
      },
      topic,
      level,
      {
        onStatus: (nextStatus) => {
          if (sessionRef.current?.session === session) setStatus(nextStatus);
        },
      }
    );
    slot = { session, topic, difficulty: level, provider: selectedSettings.provider, openrouterKey: selectedSettings.openrouterKey };
    sessionRef.current = slot;
    setSessionActive(true);
    setQuestion(null);
    setQuestionNumber(0);
    setSelected(null);
    setCorrectAnswer(null);
    setError(null);
    setNotice(null);
    setBusy(true);
    setStatus(`Searching live sources for “${topic}”…`);

    void (async () => {
      try {
        await session.prepare();
        if (sessionRef.current !== slot) return;
        await requestQuestion(slot);
      } catch (e: any) {
        if (sessionRef.current !== slot || session.signal.aborted) return;
        sessionRef.current = null;
        setSessionActive(false);
        setError(e?.message ?? "Could not search this topic. Check your internet connection and retry.");
        setStatus("");
      } finally {
        if (sessionRef.current === slot) setBusy(false);
      }
    })();
  }

  async function requestQuestion(slot: SessionSlot) {
    setBusy(true);
    setStatus(`Preparing question ${slot.session.questions.length + 1}…`);
    setQuestion(null);
    setSelected(null);
    setCorrectAnswer(null);
    try {
      const next = await slot.session.nextQuestion();
      if (sessionRef.current !== slot || slot.session.signal.aborted) return;
      if (!next) {
        sessionRef.current = null;
        setSessionActive(false);
        setError(slot.session.error ?? "No more verified source facts were found. Edit the topic to continue.");
        setStatus("");
        return;
      }
      setQuestion(next);
      setQuestionNumber((n) => n + 1);
      saveGeneratedQuestion(slot.topic, next);
      setError(null);
      setStatus("");
    } catch (e: any) {
      if (sessionRef.current !== slot || slot.session.signal.aborted) return;
      sessionRef.current = null;
      setSessionActive(false);
      setError(e?.message ?? "Could not generate a question. Retry to continue.");
      setStatus("");
    } finally {
      if (sessionRef.current === slot) setBusy(false);
    }
  }

  function answer(index: number) {
    if (!question || selected !== null) return;
    const isCorrect = index === question.answer;
    setSelected(index);
    setCorrectAnswer(isCorrect);
    beep(isCorrect ? "good" : "bad", settings.sound);
    if (answerTimer.current) clearTimeout(answerTimer.current);
    // Keep the answered question visible briefly, then continue automatically.
    answerTimer.current = window.setTimeout(() => {
      const current = sessionRef.current;
      const nextTopic = subjectRef.current.trim().replace(/\s+/g, " ");
      const nextSettings = settingsRef.current;
      const nextDifficulty = difficultyRef.current;
      if (!nextTopic) {
        current?.session.cancel();
        sessionRef.current = null;
        setSessionActive(false);
        setQuestion(null);
        setError("Type a subject to continue.");
        return;
      }
      if (!current || current.topic !== nextTopic || current.difficulty !== nextDifficulty || current.provider !== nextSettings.provider || current.openrouterKey !== nextSettings.openrouterKey) {
        current?.session.cancel();
        sessionRef.current = null;
        startNewSession(nextTopic, nextDifficulty);
        return;
      }
      void requestQuestion(current);
    }, 1100);
  }

  async function chooseWebLLM() {
    updateSettings({ ...settingsRef.current, provider: "webllm" });
    if (webllm.readyModelId) {
      setNotice("WebLLM is ready.");
      return;
    }
    setModelBusy(true);
    setNotice("Loading WebLLM on this device. You can still generate verified source questions while it loads.");
    try {
      await webllm.ensureModel(settingsRef.current.webllmModel);
      setNotice("WebLLM is ready.");
    } catch (e: any) {
      setNotice(e?.message ?? "WebLLM could not load. Verified source questions remain available.");
    } finally {
      setModelBusy(false);
    }
  }

  async function choosePuter() {
    updateSettings({ ...settingsRef.current, provider: "puter" });
    if (isSignedIn()) {
      setPuterUser(await getUser());
      setNotice("Puter is signed in.");
      return;
    }
    if (!puterReady) {
      setNotice("Puter is still loading. Try again in a moment.");
      return;
    }
    setNotice(null);
    try {
      setPuterUser(await signInWithPuter());
      setNotice("Puter is signed in.");
    } catch (e: any) {
      setNotice(e?.msg ?? e?.message ?? "Puter sign-in was not completed.");
    }
  }

  function chooseOpenRouter() {
    updateSettings({ ...settingsRef.current, provider: "openrouter" });
    setShowOpenRouterKey(true);
    setNotice("Sign in to OpenRouter, create an API key, then paste it below.");
    window.open("https://openrouter.ai/keys", "_blank", "noopener,noreferrer");
  }

  const canStart = subject.trim().length >= 2 && !busy && !sessionActive;

  return (
    <div className="forge-app">
      <main className="min-h-dvh bg-[#171b16] px-3 py-5 text-[#252a22] sm:px-6 sm:py-8">
      <section className="mx-auto max-w-3xl rounded-[30px] border border-[#d8dcd2] bg-[#f7f8f3] p-5 shadow-[0_22px_70px_rgba(0,0,0,0.22)] sm:p-9">
        <h1 className="font-display mb-5 text-xl font-extrabold uppercase tracking-[0.1em] text-[#697064]">BrainForge quiz</h1>

        {onBack && (
          <button type="button" onClick={onBack} className="mb-4 inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-[#737a6c] transition hover:text-[#4a5148]">
            <Home className="h-4 w-4" /> Home
          </button>
        )}

        <label htmlFor="quiz-topic" className="mb-3 block text-sm font-extrabold uppercase tracking-[0.1em] text-[#697064]">Subject</label>
        <div className="flex min-h-[68px] items-center gap-3 rounded-[20px] border-2 border-[#dedfdc] bg-white px-4">
          <Sparkles className="h-6 w-6 shrink-0 text-[#859379]" />
          <input
            id="quiz-topic"
            value={subject}
            onChange={(e) => typeSubject(e.target.value)}
            placeholder="Type any subject..."
            maxLength={80}
            disabled={busy && !question}
            className="min-w-0 flex-1 bg-transparent text-lg font-bold text-[#252a22] placeholder:font-medium placeholder:text-[#9b9f96] disabled:opacity-60"
          />
          {subject && !sessionActive && (
            <button type="button" onClick={() => setSubject("")} className="px-2 text-xs font-extrabold uppercase text-[#92978d]">Clear</button>
          )}
        </div>

        <div className="mt-5 grid grid-cols-1 gap-2 min-[420px]:grid-cols-3">
          <button onClick={chooseWebLLM} disabled={modelBusy} className={cn("min-h-12 rounded-2xl border px-2 text-sm font-bold transition active:scale-[0.98] disabled:opacity-60", settings.provider === "webllm" ? "border-[#89987d] bg-white text-[#263024]" : "border-[#dedfdc] bg-[#eceee7] text-[#777d73]")}>
            {modelBusy ? "Loading WebLLM..." : "WebLLM"}
          </button>
          <button onClick={choosePuter} className={cn("min-h-12 rounded-2xl border px-2 text-sm font-bold transition active:scale-[0.98]", settings.provider === "puter" ? "border-[#89987d] bg-white text-[#263024]" : "border-[#dedfdc] bg-[#eceee7] text-[#777d73]")}>
            {puterUser?.username ? `Puter · ${puterUser.username}` : "Puter sign in"}
          </button>
          <button onClick={chooseOpenRouter} className={cn("min-h-12 rounded-2xl border px-2 text-sm font-bold transition active:scale-[0.98]", settings.provider === "openrouter" ? "border-[#89987d] bg-white text-[#263024]" : "border-[#dedfdc] bg-[#eceee7] text-[#777d73]")}>
            OpenRouter sign in
          </button>
        </div>

        {showOpenRouterKey && (
          <input
            type="password"
            value={settings.openrouterKey}
            onChange={(e) => updateSettings({ ...settingsRef.current, openrouterKey: e.target.value.trim(), provider: "openrouter" })}
            placeholder="Paste OpenRouter API key"
            autoComplete="off"
            className="mt-3 min-h-12 w-full rounded-2xl border border-[#dedfdc] bg-white px-4 text-base text-[#252a22] placeholder:text-[#9b9f96]"
          />
        )}

        <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {LEVELS.map((item) => (
            <button
              key={item.id}
              onClick={() => setDifficulty(item.id)}
              aria-pressed={difficulty === item.id}
              className={cn("min-h-12 rounded-2xl px-3 text-sm font-extrabold transition active:scale-[0.98]", difficulty === item.id ? "bg-[#dce6d2] text-[#263024]" : "bg-[#eceee7] text-[#888e83]")}
            >
              {item.label}
            </button>
          ))}
        </div>

        {busy && (
          <div className="mt-5" role="status" aria-live="polite">
            <div
              className="h-2 overflow-hidden rounded-full bg-[#e5e9de]"
              role="progressbar"
              aria-label="Generating question"
              aria-valuetext={status || "Generating a question"}
            >
              <span className="quiz-progress-segment block h-full w-[34%] rounded-full bg-[#829574]" />
            </div>
            <p className="mt-3 text-sm font-semibold text-[#747a70]">{status || "Generating a source-verified question…"}</p>
          </div>
        )}

        {!sessionActive && (
          <button
            onClick={() => startNewSession()}
            disabled={!canStart}
            className="mt-6 flex min-h-[68px] w-full items-center justify-center gap-3 rounded-[22px] bg-[#d4ff65] px-4 font-display text-lg font-extrabold text-[#182016] shadow-[0_7px_0_#a8c953] transition active:translate-y-1 active:shadow-[0_3px_0_#a8c953] disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none"
          >
            {busy ? <LoaderCircle className="h-5 w-5 animate-spin" /> : <ArrowRight className="h-5 w-5" />}
            Generate question
          </button>
        )}

        {status && <p className="mt-4 text-sm font-medium text-[#747a70]">{status}</p>}
        {notice && <p className="mt-3 rounded-2xl bg-[#eceee7] px-3 py-2.5 text-sm text-[#666d61]">{notice}</p>}
        {error && <p role="alert" className="mt-3 rounded-2xl bg-[#fff0ed] px-3 py-2.5 text-sm font-semibold text-[#9f4d43]">{error}</p>}

        {question && (
          <section className="mt-6 rounded-[24px] border border-[#dedfdc] bg-white p-4 sm:p-6">
            <div className="mb-3 flex items-center justify-between gap-2 text-xs font-bold uppercase tracking-wider text-[#788074]">
              <span>Question {questionNumber}</span>
              <span>{question.verified ? "Source verified" : "Live source"}</span>
            </div>
            <h2 className="whitespace-pre-line text-lg font-extrabold leading-snug text-[#252a22] sm:text-xl">{question.q}</h2>
            <div className="mt-4 grid gap-2">
              {question.options.map((option, index) => {
                const isChosen = selected === index;
                const isRight = index === question.answer;
                return (
                  <button
                    key={`${questionNumber}-${index}`}
                    onClick={() => answer(index)}
                    disabled={selected !== null}
                    className={cn(
                      "min-h-[52px] rounded-2xl border px-4 py-3 text-left text-sm font-bold transition disabled:cursor-default",
                      selected === null ? "border-[#dedfdc] bg-[#f7f8f3] text-[#333a30] hover:border-[#a8b49d]" :
                        isRight ? "border-[#8dc26e] bg-[#edf7e7] text-[#30462a]" :
                          isChosen ? "border-[#de9387] bg-[#fff0ed] text-[#8e443c]" : "border-[#e5e6e2] bg-[#fafaf8] text-[#a2a69e]"
                    )}
                  >
                    <span className="mr-2 inline-flex h-7 w-7 items-center justify-center rounded-lg bg-black/5 text-xs">{"ABCD"[index]}</span>
                    {option}
                  </button>
                );
              })}
            </div>
            {selected !== null && (
              <div className="mt-4 rounded-2xl bg-[#f1f3ed] p-3 text-sm text-[#596052]">
                <strong className={correctAnswer ? "text-[#47733c]" : "text-[#9f4d43]"}>{correctAnswer ? "Correct." : "Not quite."}</strong> {question.explanation}
                {question.sourceUrl && <a href={question.sourceUrl} target="_blank" rel="noopener noreferrer" className="ml-2 inline-flex items-center gap-1 font-bold text-[#66785a]"><ExternalLink className="h-3 w-3" /> Source</a>}
                <p className="mt-2 text-xs text-[#858a80]">The next question starts automatically after this answer.</p>
              </div>
            )}
          </section>
        )}
      </section>
    </main>
    </div>
  );
}