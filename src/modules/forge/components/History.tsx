import { useMemo, useState } from "react";
import { ArrowLeft, BadgeCheck, ExternalLink, FileQuestion, Globe2 } from "lucide-react";
import type { QuestionHistoryEntry } from "../lib/types";
import { Card, Pill, SectionTitle } from "./ui";

interface Props {
  entries: QuestionHistoryEntry[];
  onBack: () => void;
}

export default function History({ entries, onBack }: Props) {
  const [tab, setTab] = useState<"questions" | "sources">("questions");
  const sources = useMemo(() => {
    const seen = new Set<string>();
    return entries.flatMap((e) => {
      const q = e.question;
      if (!q.sourceUrl || seen.has(q.sourceUrl)) return [];
      seen.add(q.sourceUrl);
      return [{ title: q.sourceTitle ?? "Source", url: q.sourceUrl, topic: e.topic }];
    });
  }, [entries]);

  return (
    <div className="mx-auto max-w-3xl px-3 pb-28 pt-4 sm:px-5">
      <button onClick={onBack} className="mb-4 inline-flex min-h-10 items-center gap-2 text-sm font-bold text-white/65 active:scale-95">
        <ArrowLeft className="h-4 w-4" /> Settings
      </button>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-white">Past questions</h1>
          <p className="mt-1 text-sm text-white/50">Only the two newest generated questions are kept. Older entries are removed automatically.</p>
        </div>
        <span className="rounded-full bg-violet-400/15 px-3 py-1.5 text-xs font-bold text-violet-200">{entries.length} / 2</span>
      </div>

      <div className="mb-3 flex gap-2">
        <Pill active={tab === "questions"} onClick={() => setTab("questions")}>
          <span className="inline-flex items-center gap-1.5"><FileQuestion className="h-4 w-4" /> Questions</span>
        </Pill>
        <Pill active={tab === "sources"} onClick={() => setTab("sources")}>
          <span className="inline-flex items-center gap-1.5"><Globe2 className="h-4 w-4" /> Sources</span>
        </Pill>
      </div>

      {tab === "questions" && (
        entries.length ? (
          <div className="space-y-3">
            {entries.map((entry, idx) => {
              const q = entry.question;
              return (
                <Card key={entry.id} className="p-4">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="rounded-full bg-violet-400/10 px-2.5 py-1 text-[11px] font-bold text-violet-200">{entry.topic}</span>
                    <span className="text-[11px] text-white/40">#{idx + 1} · {new Date(entry.generatedAt).toLocaleString()}</span>
                  </div>
                  <h2 className="font-display whitespace-pre-line text-base font-bold leading-snug text-white">{q.q}</h2>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    {q.options.map((option, i) => (
                      <div key={`${entry.id}-${i}`} className={`rounded-xl border px-3 py-2 text-sm ${i === q.answer ? "border-emerald-400/40 bg-emerald-400/10 font-bold text-emerald-200" : "border-white/8 bg-white/[0.03] text-white/55"}`}>
                        <span className="mr-2 text-xs font-bold opacity-60">{"ABCD"[i]}</span>{option}
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-white/45">
                    {q.verified && <BadgeCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-300" />}
                    <span className="min-w-0 flex-1">{q.explanation}</span>
                    {q.sourceUrl && <a href={q.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 font-bold text-emerald-300"><ExternalLink className="h-3 w-3" /> Source</a>}
                  </div>
                </Card>
              );
            })}
          </div>
        ) : (
          <Card className="py-10 text-center">
            <FileQuestion className="mx-auto h-8 w-8 text-white/30" />
            <p className="mt-3 text-sm font-semibold text-white/55">No generated questions yet.</p>
            <p className="mt-1 text-xs text-white/35">The newest two will appear here.</p>
          </Card>
        )
      )}

      {tab === "sources" && (
        sources.length ? (
          <Card>
            <SectionTitle>Sources from recent questions</SectionTitle>
            <div className="space-y-2">
              {sources.map((source) => (
                <a key={source.url} href={source.url} target="_blank" rel="noreferrer" className="flex items-center gap-3 rounded-2xl bg-white/[0.04] px-3 py-3 text-sm font-semibold text-white/75">
                  <Globe2 className="h-4 w-4 shrink-0 text-emerald-300" />
                  <span className="min-w-0 flex-1"><span className="block truncate">{source.title}</span><span className="block truncate text-[11px] font-normal text-white/40">Topic: {source.topic}</span></span>
                  <ExternalLink className="h-4 w-4 shrink-0 text-white/35" />
                </a>
              ))}
            </div>
          </Card>
        ) : (
          <Card className="py-10 text-center text-sm text-white/45">No saved sources yet.</Card>
        )
      )}
    </div>
  );
}