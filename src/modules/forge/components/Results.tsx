import { Check, ChevronDown, ChevronUp, Home, RotateCcw, Share2, X } from "lucide-react";
import { useState } from "react";
import type { GameResult } from "../lib/types";
import { gradeFor } from "../lib/store";
import { Card, Confetti, Stat, beep } from "./ui";
import type { AnswerLog } from "./Quiz";
import { cn } from "@/utils/cn";

interface Props {
  result: GameResult;
  logs: AnswerLog[];
  sound: boolean;
  onHome: () => void;
  onAgain: () => void;
}

export default function Results(p: Props) {
  const [showReview, setShowReview] = useState(false);
  const [shared, setShared] = useState(false);
  const pct = p.result.total ? p.result.correct / p.result.total : 0;
  const g = gradeFor(pct);
  const difficulty = p.result.difficulty === "easy" ? "Simple" : p.result.difficulty;

  async function share() {
    const text = `I scored ${p.result.score} in BrainForge (${p.result.correct}/${p.result.total} correct, Grade ${g.grade})! Can you beat me?`;
    try {
      if (navigator.share) {
        await navigator.share({ title: "BrainForge Quiz", text });
      } else {
        await navigator.clipboard.writeText(text);
      }
      setShared(true);
      beep("good", p.sound);
      setTimeout(() => setShared(false), 2000);
    } catch {
      /* dismissed */
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-3 pb-28 pt-4 sm:px-5">
      <Confetti show={pct >= 0.6} />
      <div className="anim-pop glass relative overflow-hidden rounded-[28px] p-6 text-center sm:p-8">
        <div className="glow-amber pointer-events-none absolute -top-20 left-1/2 h-56 w-56 -translate-x-1/2" />
        <div className="relative">
          <div className="mx-auto mb-3 flex h-24 w-24 items-center justify-center rounded-full ring-4" style={{ background: `${g.color}22`, ["--tw-ring-color" as any]: `${g.color}66`, boxShadow: `0 0 40px ${g.color}44` }}>
            <span className="font-display text-5xl font-bold" style={{ color: g.color }}>{g.grade}</span>
          </div>
          <h2 className="font-display text-2xl font-bold text-white">{g.label}!</h2>
          <p className="mt-1 text-sm text-white/55">
            {p.result.correct} of {p.result.total} correct · {p.result.category} · {difficulty}
          </p>
          <div className="mt-5 grid grid-cols-3 gap-2">
            <Stat label="Score" value={String(p.result.score)} />
            <Stat label="Correct" value={`${p.result.correct}/${p.result.total}`} />
            <Stat label="Best streak" value={`×${p.result.bestStreak}`} />
          </div>

          <div className="mt-5 flex gap-2">
            <button onClick={p.onAgain} className="flex min-h-[52px] flex-1 items-center justify-center gap-2 rounded-3xl bg-emerald-400 font-display text-base font-bold text-emerald-950 transition active:scale-[0.98]">
              <RotateCcw className="h-5 w-5" /> Play again
            </button>
            <button onClick={share} className="flex min-h-[52px] items-center justify-center gap-2 rounded-3xl bg-white/10 px-5 font-display text-base font-bold text-white ring-1 ring-white/15 transition active:scale-[0.98]">
              <Share2 className="h-5 w-5" /> {shared ? "Copied!" : "Share"}
            </button>
            <button onClick={p.onHome} className="flex min-h-[52px] items-center justify-center gap-2 rounded-3xl bg-white/10 px-5 font-display text-base font-bold text-white ring-1 ring-white/15 transition active:scale-[0.98]">
              <Home className="h-5 w-5" />
            </button>
          </div>
        </div>
      </div>

      <button
        onClick={() => setShowReview(!showReview)}
        className="mt-3 flex min-h-[48px] w-full items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/[0.05] text-sm font-bold text-white/80 active:scale-[0.99]"
      >
        {showReview ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />} Review answers
      </button>

      {showReview && (
        <div className="mt-3 space-y-2.5">
          {p.logs.map((l, i) => {
            const right = l.picked === l.q.answer;
            return (
              <Card key={i} className="p-4">
                <div className="flex items-start gap-2.5">
                  <span className={cn("mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full", right ? "bg-emerald-400/20 text-emerald-300" : "bg-rose-400/20 text-rose-300")}>
                    {right ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm font-bold text-white">{l.q.q}</div>
                    <div className="mt-1 text-[13px] text-white/55">
                      Your answer: <b className={right ? "text-emerald-300" : "text-rose-300"}>{l.picked >= 0 ? l.q.options[l.picked] : "Skipped"}</b>
                      {!right && <> · Correct: <b className="text-emerald-300">{l.q.options[l.q.answer]}</b></>}
                    </div>
                    <div className="mt-0.5 text-[12px] text-white/40">{l.q.explanation}</div>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
