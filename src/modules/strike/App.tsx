import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, Check, Cloud, Cpu, Eye, EyeOff, Home, KeyRound, LoaderCircle, LogOut, Play, RotateCcw, UserRound, X } from "lucide-react";
import "./index.css";
import { advanceSession, applyAnswer, createCustomSession, currentQuestion } from "./game/engine";
import { useAI } from "./hooks/useAI";
import { haptic } from "@/shared/haptics";
import type { AIProvider, Difficulty, GameSession } from "./types";

const PROVIDERS: { id: AIProvider; label: string; icon: typeof Cpu }[] = [
  { id: "webllm", label: "WebLLM", icon: Cpu },
  { id: "puter", label: "Puter", icon: UserRound },
  { id: "openrouter", label: "OpenRouter", icon: Cloud },
];

const GENERATION_STAGES = [
  "Searching the live internet for sources…",
  "Grounding facts in verified passages…",
  "Writing your question…",
  "Checking topic & blocking hallucinations…",
];

interface AppProps {
  onBack?: () => void;
}

export default function App({ onBack }: AppProps) {
  const ai = useAI();
  const [subject, setSubject] = useState("");
  const [session, setSession] = useState<GameSession | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [stageIndex, setStageIndex] = useState(0);
  const [showHistory, setShowHistory] = useState(false);
  const sessionRef = useRef<GameSession | null>(null);
  const inFlightRef = useRef(false);
  sessionRef.current = session;

  const valid = subject.trim().length >= 2;

  useEffect(() => {
    if (!busy) { setStageIndex(0); return; }
    const timer = window.setInterval(() => setStageIndex((value) => (value + 1) % GENERATION_STAGES.length), 1600);
    return () => window.clearInterval(timer);
  }, [busy]);

  const generate = useCallback(async () => {
    if (inFlightRef.current || !valid) return;
    inFlightRef.current = true;
    setBusy(true);
    setError("");
    try {
      const difficulty: Difficulty = 2;
      const current = sessionRef.current;
      const exclude = current?.mode === "custom" ? current.deck.map((q) => q.prompt) : [];
      const question = await ai.generateSingleQuestion(subject.trim(), difficulty, exclude, current?.answeredCount ?? 0);
      setSession((active) => {
        if (active && active.awaitingQuestion) {
          return { ...active, deck: [...active.deck, question], awaitingQuestion: false, event: "Next question ready" };
        }
        return createCustomSession(subject.trim(), [question], difficulty);
      });
      // Relay pipeline refill is handled by the awaitingQuestion effect below.
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not generate a question.");
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  }, [ai, subject, valid]);

  const answer = useCallback((option: number) => {
    const active = sessionRef.current;
    if (!active || active.status !== "playing") return;
    const next = applyAnswer(active, option);
    haptic(next.wasCorrect ? "good" : "bad");
    setSession(next);
  }, []);

  const next = useCallback(() => {
    haptic("click");
    setSession((current) => (current ? advanceSession(current) : current));
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).tagName === "INPUT") return;
      const current = sessionRef.current;
      if (!current || current.awaitingQuestion) return;
      if (event.key === "Enter" && current.status === "feedback") { event.preventDefault(); next(); return; }
      if (current.status !== "playing") return;
      const position = Number(event.key) - 1;
      if (position >= 0 && position < 4) answer(current.optionOrder[position]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [answer, next]);

  // When the session advances and needs a new question, try the pipeline first.
  useEffect(() => {
    if (session?.awaitingQuestion && ai.settings.provider === "webllm") {
      // Try to get a pre-generated question instantly.
      const pregenerated = ai.takeNextQuestion();
      if (pregenerated) {
        setSession((active) => {
          if (active && active.awaitingQuestion) {
            return { ...active, deck: [...active.deck, pregenerated], awaitingQuestion: false, event: "Next question ready (pre-generated)" };
          }
          return active;
        });
      } else {
        // Pipeline empty — fall through to normal generation.
        void generate();
      }
    }
  }, [session?.awaitingQuestion, session?.questionIndex, session?.startedAt, generate, ai.takeNextQuestion]);

  const question = session ? currentQuestion(session) : null;
  const feedback = session?.status === "feedback";
  const lost = session?.status === "lost";
  const provider = ai.settings.provider;
  const { currentModel, nextModel, nextStatus, nextError } = ai.pipelineStatus();

  return (
    <div className="mini-app sage-app">
      <main className="mini-shell">
        <header className="mini-header">
          <div className="mini-brand"><Bot size={20} /> SageStrike</div>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            {onBack && <button type="button" className="mini-link" onClick={onBack}><Home size={12} /> Home</button>}
            {session && <div className="mini-score">Score {session.score.toLocaleString()} · Shields {"♥".repeat(session.hearts)}</div>}
          </div>
        </header>

        {!session || lost ? (
          <section className="mini-card">
            <h1 className="mini-title">What should your quiz be about?</h1>
            <input
              className="mini-input"
              value={subject}
              maxLength={80}
              placeholder="Type a subject — e.g. Chemistry, Ancient Rome, Docker…"
              onChange={(event) => setSubject(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void generate(); }}
            />


            {/* ── Generation type toggle ── */}
            <div className="mini-gen-type">
              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "#94a3b8", marginBottom: "8px" }}>
                <span>Generation mode:</span>
                <button
                  onClick={() => ai.setGenerationType("new")}
                  className={`mini-gen-btn ${ai.generationType === "new" ? "mini-gen-btn-active" : ""}`}
                >
                  New question
                </button>
                <button
                  onClick={() => { ai.setGenerationType("repeat"); setShowHistory(true); }}
                  className={`mini-gen-btn ${ai.generationType === "repeat" ? "mini-gen-btn-active" : ""}`}
                >
                  Repeat previous
                </button>
              </label>
            </div>

            {/* ── Previous questions history (repeat mode) ── */}
            {ai.generationType === "repeat" && showHistory && (
              <section className="mini-card mini-history">
                <h2 style={{ fontSize: "14px", marginBottom: "8px", color: "#94a3b8" }}>Previously generated questions</h2>
                {ai.bufferedCount() > 0 && (
                  <div style={{ fontSize: "12px", color: "#64748b", marginBottom: "8px" }}>
                    {ai.bufferedCount()} pre-generated question(s) ready in pipeline
                  </div>
                )}
                <div style={{ maxHeight: "200px", overflowY: "auto", border: "1px solid #334155", borderRadius: "6px", padding: "8px", background: "#0f172a" }}>
                  {(() => {
                    const history = [];
                    try {
                      const raw = localStorage.getItem("sagestrike.questionHistory.v1");
                      if (raw) {
                        const parsed = JSON.parse(raw);
                        if (Array.isArray(parsed)) history.push(...parsed);
                      }
                    } catch { /* noop */ }
                    return history.slice(0, 10).map((item: any, idx: number) => (
                      <button
                        key={idx}
                        onClick={() => {
                          ai.setGenerationType("repeat");
                          setShowHistory(false);
                          // Temporarily override generateSingleQuestion to use this history item
                          void ai.repeatPreviousQuestion(item, 2, sessionRef.current?.mode === "custom" ? sessionRef.current.deck.map((q) => q.prompt) : []).then((q) => {
                            setSession((active) => {
                              if (active && active.awaitingQuestion) {
                                return { ...active, deck: [...active.deck, q], awaitingQuestion: false, event: "Repeated question ready" };
                              }
                              return createCustomSession(item.subject, [q], 2);
                            });
                          }).catch((err) => setError(err instanceof Error ? err.message : "Repeat failed"));
                        }}
                        className="mini-history-item"
                      >
                        <div style={{ fontWeight: "600", fontSize: "13px" }}>{item.subject}</div>
                        <div style={{ fontSize: "12px", color: "#94a3b8", marginTop: "2px" }}>{item.prompt}</div>
                      </button>
                    ));
                  })()}
                </div>
              </section>
            )}

            <div className="mini-providers" role="group" aria-label="Choose AI provider">
              {PROVIDERS.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    className={`mini-prov ${provider === item.id ? "mini-prov-active" : ""}`}
                    onClick={() => { ai.updateSettings({ provider: item.id }); setShowHistory(false); }}
                  >
                    <Icon size={15} /> {item.label}
                  </button>
                );
              })}
            </div>

            {provider === "webllm" && (
              <div className="mini-prov-panel">
                {ai.progress.status === "ready" ? (
                  <p className="mini-ok">WebLLM ready · {ai.progress.model.split("-")[0]} {ai.progress.model.split("-")[1]}</p>
                ) : ai.progress.status === "loading" ? (
                  <p className="mini-note"><LoaderCircle size={13} className="animate-spin inline" /> Downloading & caching model… {Math.round(ai.progress.progress * 100)}%</p>
                ) : ai.progress.status === "unsupported" ? (
                  <p className="mini-note">WebGPU unavailable here — use Puter or OpenRouter instead.</p>
                ) : (
                  <button className="mini-btn" onClick={() => void ai.preload(ai.settings.webllmModel).catch(() => undefined)}>Load WebLLM model</button>
                )}
                <label className="mini-dual">
                  <input
                    type="checkbox"
                    checked={ai.settings.webllmDual}
                    onChange={(event) => {
                      ai.updateSettings({ webllmDual: event.target.checked });
                      void ai.preload(ai.settings.webllmModel).catch(() => undefined);
                    }}
                  />
                  Dual-model rapid generation (fast 0.8B + strong model race each other)
                </label>
                {/* Relay pipeline status */}
                <div className="mini-pipeline-status">
                  <div style={{ fontSize: "11px", color: "#64748b", marginBottom: "4px" }}>Relay pipeline</div>
                  <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "12px" }}>
                      <span style={{ color: currentModel ? "#34d399" : "#94a3b8" }}>{currentModel ? "●" : "○"}</span>
                      <span>Current: {currentModel ?? "—"}</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "12px" }}>
                      <span style={{ color: nextModel ? "#34d399" : nextStatus === "generating" ? "#fbbf24" : "#94a3b8" }}>
                        {nextStatus === "generating" ? "↻" : nextModel ? "●" : "○"}
                      </span>
                      <span>Next: {nextModel ?? "—"} ({nextStatus})</span>
                    </div>
                    {nextError && <span style={{ fontSize: "11px", color: "#f87171" }}>{nextError}</span>}
                  </div>
                </div>
                <p className="mini-note">Relay pipeline: Model A generates Q1 → shown now · Model B generates Q2 behind the scenes → shown when Q1 is answered · models alternate, never compete.</p>
              </div>
            )}

            {provider === "puter" && (
              <div className="mini-prov-panel">
                {ai.puterUser ? (
                  <p className="mini-ok">Signed in as {ai.puterUser} <button className="mini-link" onClick={() => void ai.signOut()}><LogOut size={12} /> Sign out</button></p>
                ) : (
                  <button className="mini-btn" onClick={() => void ai.signIn().catch(() => undefined)}>Sign in with Puter</button>
                )}
              </div>
            )}

            {provider === "openrouter" && (
              <div className="mini-prov-panel">
                <div className="mini-keyfield">
                  <KeyRound size={14} />
                  <input
                    type={showKey ? "text" : "password"}
                    placeholder="OpenRouter API key (sk-or-…)"
                    value={ai.apiKey}
                    onChange={(event) => ai.setApiKey(event.target.value)}
                  />
                  <button onClick={() => setShowKey((v) => !v)} aria-label="Toggle key visibility">{showKey ? <EyeOff size={14} /> : <Eye size={14} />}</button>
                </div>
                <p className="mini-note">Key is sent only to OpenRouter. Model: {ai.settings.openRouterModel}</p>
              </div>
            )}

            {error && <p className="mini-error">{error}</p>}

            <button className="mini-generate" disabled={!valid || busy || (provider === "webllm" && ai.progress.status !== "ready" && ai.progress.status !== "loading") || (provider === "puter" && !ai.puterUser) || (provider === "openrouter" && !ai.apiKey.trim())} onClick={() => void generate()}>
              {busy ? <LoaderCircle size={17} className="animate-spin" /> : <Play size={16} fill="currentColor" />}
              {busy ? ai.generationStage || "Generating…" : lost ? "Start again" : "Generate question"}
            </button>
          </section>
        ) : (
          <section className="mini-card mini-question">
            {session.awaitingQuestion ? (
              <div className="mini-loading" aria-live="polite">
                <div className="mini-progress">
                  <div className="mini-progress-bar"><div className="mini-progress-fill" /></div>
                  <div className="mini-progress-row">
                    <strong key={stageIndex} className="mini-stage">{ai.generationStage || GENERATION_STAGES[stageIndex]}</strong>
                    <span className="mini-dots" aria-hidden="true"><i /><i /><i /></span>
                  </div>
                  <span className="mini-progress-sub">Question {session.answeredCount + 1} · untimed · no timeout · grounded in live sources</span>
                </div>
              </div>
            ) : question && (
              <>
                <div className="mini-qmeta"><span>{question.subject}</span><span>Q{session.answeredCount + (feedback ? 0 : 1)}</span></div>
                <h2 className="mini-qprompt">{question.prompt}</h2>
                <div className="mini-options">
                  {session.optionOrder.map((optionIndex, position) => {
                    const isCorrect = feedback && optionIndex === question.answer;
                    const isWrong = feedback && optionIndex === session.selected && optionIndex !== question.answer;
                    const dimmed = feedback && !isCorrect && !isWrong;
                    return (
                      <button
                        key={optionIndex}
                        disabled={session.status !== "playing"}
                        onClick={() => answer(optionIndex)}
                        className={`mini-opt ${isCorrect ? "mini-opt-correct" : ""} ${isWrong ? "mini-opt-wrong" : ""} ${dimmed ? "mini-opt-dim" : ""}`}
                      >
                        <span className="mini-opt-letter">{isCorrect ? <Check size={15} /> : isWrong ? <X size={15} /> : String.fromCharCode(65 + position)}</span>
                        {question.options[optionIndex]}
                      </button>
                    );
                  })}
                </div>
                {feedback && (
                  <div className="mini-explanation">
                    <strong>{session.wasCorrect ? "Correct" : <>Answer: {question.options[question.answer]}</>}</strong>
                    <p>{question.explanation}</p>
                    <button className="mini-btn" onClick={next}>Next question →</button>
                  </div>
                )}
              </>
            )}
          </section>
        )}

        {session && !lost && <button className="mini-link mini-exit" onClick={() => { setSession(null); setShowHistory(false); }}><RotateCcw size={12} /> New subject</button>}
      </main>
    </div>
  );
}
