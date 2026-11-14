import { useRef, useState } from "react";
import { ArrowRight, Cpu, Settings2, Sparkles, Trash2 } from "lucide-react";
import type { Settings } from "../lib/types";
import { prefetchKnowledge } from "../lib/knowledge";
import { beep } from "./ui";

export interface QuizConfig {
  category: string;
  difficulty: string;
}

interface Props {
  settings: Settings;
  helperReady: boolean;
  onStart: (config: QuizConfig) => void;
  onOpenSettings: () => void;
}

const DIFFICULTIES = [
  { id: "easy", label: "Simple" },
  { id: "medium", label: "Medium" },
  { id: "hard", label: "Hard" },
  { id: "expert", label: "Expert" },
];

export default function Home(p: Props) {
  const [subject, setSubject] = useState("");
  const [difficulty, setDifficulty] = useState("medium");
  const searchTimer = useRef<number | null>(null);
  const hasSubject = subject.trim().length >= 2;

  function updateSubject(value: string) {
    const next = value.slice(0, 80);
    setSubject(next);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const query = next.trim().replace(/\s+/g, " ");
    if (query.length >= 3) searchTimer.current = window.setTimeout(() => prefetchKnowledge(query), 500);
  }

  function start() {
    const topic = subject.trim().replace(/\s+/g, " ");
    if (topic.length < 2) return;
    beep("click", p.settings.sound);
    prefetchKnowledge(topic);
    p.onStart({ category: topic, difficulty });
  }

  const engineName = p.settings.provider === "webllm"
    ? p.helperReady ? "WebLLM ready" : "WebLLM optional · source fallback"
    : p.settings.provider === "puter"
      ? "Puter AI"
      : p.settings.provider === "openrouter"
        ? "OpenRouter"
        : "Verified sources";

  return (
    <div className="mx-auto max-w-5xl px-3 pb-28 pt-4 sm:px-5 sm:pt-8">
      <section className="rounded-[30px] border border-[#d8dcd2] bg-[#f7f8f3] p-5 text-[#252a22] shadow-[0_22px_70px_rgba(0,0,0,0.22)] sm:p-10">
        <p className="mb-4 text-sm font-extrabold uppercase tracking-[0.12em] text-[#697064]">What should your quiz be about?</p>
        <form onSubmit={(e) => { e.preventDefault(); start(); }}>
          <div className="flex min-h-[76px] items-center gap-3 rounded-[22px] border-2 border-[#dedfdc] bg-white px-4 sm:px-6">
            <Sparkles className="h-7 w-7 shrink-0 text-[#859379]" />
            <input
              value={subject}
              onChange={(e) => updateSubject(e.target.value)}
              placeholder="Type any topic: chemistry, astronomy, jazz..."
              aria-label="Quiz topic"
              required
              minLength={2}
              maxLength={80}
              autoComplete="off"
              autoCorrect="off"
              className="min-w-0 flex-1 bg-transparent text-lg font-bold text-[#252a22] placeholder:font-medium placeholder:text-[#9b9f96] sm:text-xl"
            />
            {subject && (
              <button type="button" onClick={() => setSubject("")} className="min-h-11 shrink-0 px-2 text-xs font-extrabold uppercase text-[#92978d]">
                <Trash2 className="h-4 w-4 sm:hidden" />
                <span className="hidden sm:inline">Clear</span>
              </button>
            )}
          </div>
          <p className="mt-3 text-sm text-[#858a80]">Your exact typed text is the topic. Related facts are searched live before question one.</p>

          <div className="mt-8">
            <p className="mb-3 text-sm font-extrabold uppercase tracking-[0.1em] text-[#747a70]">Difficulty</p>
            <div className="grid grid-cols-2 gap-2 rounded-[22px] bg-[#eceee7] p-2 sm:grid-cols-4">
              {DIFFICULTIES.map((item) => {
                const active = difficulty === item.id;
                return (
                  <button
                    type="button"
                    key={item.id}
                    onClick={() => { setDifficulty(item.id); beep("click", p.settings.sound); }}
                    aria-pressed={active}
                    className={`min-h-[54px] rounded-[16px] px-3 text-sm font-extrabold transition active:scale-[0.98] ${active ? "bg-white text-[#263024] shadow-[0_3px_12px_rgba(31,39,28,0.10)]" : "text-[#888e83] hover:text-[#464d42]"}`}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
          </div>

          <button
            type="submit"
            disabled={!hasSubject}
            className="mt-8 flex min-h-[82px] w-full items-center justify-center gap-3 rounded-[24px] bg-[#d4ff65] px-4 font-display text-lg font-bold text-[#182016] shadow-[0_9px_0_#a8c953] transition hover:bg-[#dcff80] active:translate-y-1 active:shadow-[0_5px_0_#a8c953] disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none sm:text-xl"
          >
            <Cpu className="h-6 w-6" />
            <span>{hasSubject ? "Search internet & start quiz" : "Enter a topic to start"}</span>
            <ArrowRight className="h-6 w-6" />
          </button>
        </form>

        <div className="mt-7 flex flex-wrap items-center justify-between gap-3 text-sm font-semibold text-[#73796e]">
          <div className="flex items-center gap-2"><Cpu className="h-5 w-5" /><span>Using {engineName}</span></div>
          <span className="text-xs font-medium text-[#989d93]">Untimed · answer to continue · finish any time</span>
          <button type="button" onClick={p.onOpenSettings} aria-label="AI settings" className="flex h-10 w-10 items-center justify-center rounded-xl text-[#73796e] hover:bg-[#e9ece3]">
            <Settings2 className="h-5 w-5" />
          </button>
        </div>
      </section>
    </div>
  );
}