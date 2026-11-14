import { useEffect, useState } from "react";
import { BadgeCheck, Check, ExternalLink, Flag, Flame, Globe, Lightbulb, Loader2, X } from "lucide-react";
import type { Question, Settings } from "../lib/types";
import { getHint } from "../lib/ai";
import { beep } from "./ui";
import { cn } from "@/utils/cn";
import type { QuizConfig } from "./Home";

export interface AnswerLog {
  q: Question;
  picked: number; // -1 = skipped
  skipped?: boolean;
}

interface Props {
  questions: Question[];
  config: QuizConfig;
  source: string;
  sources: Array<{ title: string; url: string }>;
  grounded: boolean;
  settings: Settings;
  generatingNext: boolean;
  hasMore: boolean;
  genStatus: string;
  onNextQuestion: () => Promise<void> | void;
  onFinish: (score: number, correct: number, bestStreak: number, logs: AnswerLog[]) => void;
  onQuit: () => void;
}

const DIFF_MULT: Record<string, number> = { easy: 1, medium: 1.5, hard: 2, expert: 3 };
const HINT_LIMIT = 3;

export default function Quiz(p: Props) {
  const loaded = p.questions.length;
  const [idx, setIdx] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [score, setScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [bestStreak, setBestStreak] = useState(0);
  const [correct, setCorrect] = useState(0);
  const [logs, setLogs] = useState<AnswerLog[]>([]);
  const [eliminated, setEliminated] = useState<number[]>([]);
  const [fiftyUsed, setFiftyUsed] = useState(false);
  const [hintUsed, setHintUsed] = useState(0);
  const [hintText, setHintText] = useState<string | null>(null);
  const [hintBusy, setHintBusy] = useState(false);
  const [shake, setShake] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [waiting, setWaiting] = useState(false); // answered last loaded question, next still generating

  const q = p.questions[idx];

  // Generate only after the player asks for the next question.
  useEffect(() => {
    if (waiting && idx + 1 < loaded) {
      setWaiting(false);
      setIdx(idx + 1);
      setPicked(null);
      setEliminated([]);
      setFiftyUsed(false);
      setHintUsed(0);
      setHintText(null);
    } else if (waiting && !p.hasMore && !p.generatingNext) {
      // No additional verified source facts remain.
      setWaiting(false);
      p.onFinish(score, correct, bestStreak, logs);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, p.hasMore, p.generatingNext, waiting]);
  const revealed = picked !== null;
  const hintsLeft = HINT_LIMIT - hintUsed;

  function advance(nextLogs: AnswerLog[], nextScore: number, nextCorrect: number, nextBest: number) {
    if (idx + 1 < loaded) {
      setIdx(idx + 1);
      setPicked(null);
      setEliminated([]);
      setFiftyUsed(false);
      setHintUsed(0);
      setHintText(null);
    } else if (p.hasMore) {
      // Ask the session for exactly one more question; it never pre-generates a pack.
      setLogs(nextLogs);
      setScore(nextScore);
      setCorrect(nextCorrect);
      setBestStreak(nextBest);
      setWaiting(true);
      void p.onNextQuestion();
    } else {
      p.onFinish(nextScore, nextCorrect, nextBest, nextLogs);
    }
  }

  function reveal(choice: number) {
    if (picked !== null) return;
    const isRight = choice === q.answer;
    let gained = 0;
    let nextStreak = streak;
    let nextCorrect = correct;
    if (isRight) {
      nextStreak = streak + 1;
      nextCorrect = correct + 1;
      gained = Math.round(100 * (DIFF_MULT[p.config.difficulty] ?? 1.5) * (1 + streak * 0.1));
      beep("good", p.settings.sound);
    } else {
      nextStreak = 0;
      beep("bad", p.settings.sound);
      setShake(true);
      setTimeout(() => setShake(false), 450);
    }
    setPicked(choice);
    setScore(score + gained);
    setStreak(nextStreak);
    setCorrect(nextCorrect);
    setBestStreak(Math.max(bestStreak, nextStreak));
    setLogs([...logs, { q, picked: choice }]);
  }

  function useFifty() {
    if (fiftyUsed || revealed) return;
    const wrong = q.options.map((_, i) => i).filter((i) => i !== q.answer).sort(() => Math.random() - 0.5).slice(0, 2);
    setEliminated(wrong);
    setFiftyUsed(true);
    beep("click", p.settings.sound);
  }

  async function useHint() {
    if (hintBusy || revealed || hintsLeft <= 0) return;
    setHintBusy(true);
    beep("click", p.settings.sound);
    try {
      const h = await getHint({ provider: p.settings.provider, openrouterKey: p.settings.openrouterKey, openrouterModel: p.settings.openrouterModel }, q, hintUsed);
      setHintText(h);
      setHintUsed(hintUsed + 1);
    } catch {
      setHintText("No AI available right now — trust your gut!");
    } finally {
      setHintBusy(false);
    }
  }

  const letters = ["A", "B", "C", "D"];
  function finishSession() {
    p.onFinish(score, correct, bestStreak, logs);
  }

  // The current question remains visible until answered. After answer feedback, fetch the next one.
  useEffect(() => {
    if (picked === null || waiting) return;
    const timer = window.setTimeout(() => advance(logs, score, correct, bestStreak), 1100);
    return () => clearTimeout(timer);
    // The current answer is a deliberate one-shot transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked, idx, waiting]);

  if (!q) return null;

  return (
    <div className="mx-auto max-w-3xl px-3 pb-28 pt-4 sm:px-5">
      {/* HUD — no countdown, take your time */}
      <div className="mb-3 flex items-center gap-3">
        <div className="font-display flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-2xl bg-white/5 ring-1 ring-white/10">
          <span className="text-lg font-bold leading-none text-white">{idx + 1}</span>
          <span className="text-[10px] font-semibold uppercase tracking-wider text-white/45">Question</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between text-xs font-bold text-white/55">
            <span className="truncate"><span className="text-violet-300">{p.config.category}</span> · <span className="capitalize">{p.config.difficulty === "easy" ? "Simple" : p.config.difficulty}</span></span>
            {p.generatingNext ? (
              <span className="inline-flex shrink-0 items-center gap-1 text-cyan-300"><Loader2 className="h-3 w-3 animate-spin" /> writing next</span>
            ) : (
              <span className="shrink-0">No timer</span>
            )}
          </div>
          <button onClick={() => setShowSources((s) => !s)} className="mt-1 flex items-center gap-1 text-[11px] text-white/45 active:scale-95">
            {p.grounded ? <Globe className="h-3 w-3 text-emerald-300" /> : null}
            <span className="truncate">{p.source}{p.grounded ? ` · fact-checked from ${p.sources.length} internet source${p.sources.length === 1 ? "" : "s"}` : ""}</span>
          </button>
        </div>
        <div className="text-right">
          <div className="font-display text-xl font-bold text-white">{score}</div>
          <div className="flex items-center justify-end gap-1 text-[11px] font-bold text-amber-300">
            <Flame className={cn("h-3.5 w-3.5", streak >= 3 && "fill-amber-300")} /> ×{streak}
          </div>
        </div>
        <button onClick={() => logs.length ? finishSession() : p.onQuit()} className="flex min-h-10 shrink-0 items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 text-xs font-bold text-white/70 active:scale-95" aria-label="Finish quiz">
          {logs.length ? <Flag className="h-4 w-4" /> : <X className="h-4 w-4" />}
          {logs.length ? "Finish" : "Exit"}
        </button>
      </div>

      {showSources && p.sources.length > 0 && (
        <div className="anim-slide-up mb-3 flex flex-wrap gap-1.5">
          {p.sources.map((s) => (
            <a key={s.url} href={s.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-full bg-emerald-400/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-200 ring-1 ring-emerald-400/25">
              <ExternalLink className="h-3 w-3" /> {s.title}
            </a>
          ))}
        </div>
      )}

      {/* Waiting for next streamed question */}
      {waiting && (
        <div className="glass anim-pop mb-3 rounded-[28px] p-6 text-center">
          <span className="anim-spin-slow mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-violet-500/20 ring-1 ring-violet-400/40">
            <Loader2 className="h-6 w-6 text-violet-300" />
          </span>
          <h3 className="font-display mt-3 text-lg font-bold text-white">Writing question {idx + 2}…</h3>
          <p className="mt-1 text-xs text-white/50">{p.genStatus}</p>
          <p className="mt-3 text-[12px] text-white/40">The next question is generated automatically after each answer.</p>
        </div>
      )}

      {/* Question */}
      <div className={cn("glass anim-pop rounded-[28px] p-5 sm:p-6", shake && "anim-shake", waiting && "hidden")} key={idx}>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-2 rounded-full bg-cyan-400/10 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-cyan-300">{q.category}</span>
          {q.verified && (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-400/10 px-2.5 py-1 text-[11px] font-bold text-emerald-300 ring-1 ring-emerald-400/25">
              <BadgeCheck className="h-3.5 w-3.5" /> Verified · {q.sourceTitle ?? "Wikipedia"}
            </span>
          )}
        </div>
        <h2 className="font-display whitespace-pre-line text-xl font-bold leading-snug text-white sm:text-2xl">{q.q}</h2>

        {hintText && (
          <div className="anim-slide-up mt-3 flex items-start gap-2 rounded-2xl bg-amber-400/10 px-3 py-2.5 text-sm text-amber-200 ring-1 ring-amber-400/25">
            <Lightbulb className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{hintText}</span>
          </div>
        )}

        <div className="mt-4 grid gap-2.5 sm:grid-cols-2">
          {q.options.map((opt, i) => {
            const isElim = eliminated.includes(i);
            const isPicked = picked === i;
            const isAnswer = revealed && i === q.answer;
            const isWrongPick = revealed && isPicked && !isAnswer;
            return (
              <button
                key={i}
                disabled={revealed || isElim}
                onClick={() => reveal(i)}
                className={cn(
                  "flex min-h-[56px] items-center gap-3 rounded-2xl border px-4 py-3 text-left transition active:scale-[0.98]",
                  isElim && "border-white/5 bg-white/[0.02] text-white/25 line-through",
                  !revealed && !isElim && "border-white/10 bg-white/[0.05] text-white hover:border-violet-400/50 hover:bg-violet-500/10",
                  isAnswer && "border-emerald-400/70 bg-emerald-400/15 text-white shadow-[0_0_18px_rgba(52,211,153,0.3)]",
                  isWrongPick && "border-rose-400/70 bg-rose-400/15 text-white"
                )}
              >
                <span
                  className={cn(
                    "font-display flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-sm font-bold",
                    isAnswer ? "bg-emerald-400 text-emerald-950" : isWrongPick ? "bg-rose-400 text-rose-950" : "bg-white/10 text-white/70"
                  )}
                >
                  {isAnswer ? <Check className="h-4 w-4" /> : isWrongPick ? <X className="h-4 w-4" /> : letters[i]}
                </span>
                <span className="text-sm font-semibold leading-snug">{opt}</span>
              </button>
            );
          })}
        </div>

        {revealed && (
          <div className="anim-slide-up mt-4 flex items-start gap-2 rounded-2xl bg-white/[0.05] px-3 py-2.5 text-sm text-white/70 ring-1 ring-white/10">
            <span className={cn("font-display mt-0.5 shrink-0 text-xs font-bold uppercase", picked === q.answer ? "text-emerald-300" : "text-rose-300")}>
              {picked === q.answer ? "Correct!" : "Not quite"}
            </span>
            <span className="min-w-0">
              {q.explanation}
              {q.sourceUrl && (
                <a href={q.sourceUrl} target="_blank" rel="noreferrer" className="ml-1.5 inline-flex items-center gap-1 text-[12px] font-bold text-emerald-300">
                  <ExternalLink className="h-3 w-3" /> source
                </a>
              )}
            </span>
          </div>
        )}
      </div>

      {/* Lifelines */}
      <div className={cn("mt-3 grid grid-cols-2 gap-2", waiting && "hidden")}>
        <button
          onClick={useFifty}
          disabled={fiftyUsed || revealed}
          className="flex min-h-[48px] flex-col items-center justify-center gap-0.5 rounded-2xl border border-white/10 bg-white/[0.05] text-xs font-bold text-white/80 transition active:scale-95 disabled:opacity-35"
        >
          <span className="font-display text-sm">50:50</span>
          <span className="text-[10px] text-white/45">Remove two options</span>
        </button>
        <button
          onClick={useHint}
          disabled={hintBusy || revealed || hintsLeft <= 0}
          className="flex min-h-[48px] flex-col items-center justify-center gap-0.5 rounded-2xl border border-amber-400/30 bg-amber-400/10 text-xs font-bold text-amber-200 transition active:scale-95 disabled:opacity-35"
        >
          <Lightbulb className="h-4 w-4" />
          <span className="text-[10px]">{hintBusy ? "Thinking…" : `AI hint · ${Math.max(0, hintsLeft)} left`}</span>
        </button>
      </div>

      {revealed && !waiting && <p className="mt-3 text-center text-xs font-semibold text-white/45">Next question starts automatically…</p>}
    </div>
  );
}
