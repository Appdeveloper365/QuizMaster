import { useEffect, useRef, useState } from "react";
import { Bot, Cpu, Loader2, Send, X } from "lucide-react";
import type { ChatMsg, Settings } from "../lib/types";
import { chatWithAI } from "../lib/ai";
import { webllm } from "../lib/webllm";
import { beep } from "./ui";
import { cn } from "@/utils/cn";

interface Props {
  open: boolean;
  settings: Settings;
  onClose: () => void;
}

const SUGGESTIONS = [
  "Give me a hint for this quiz",
  "Explain photosynthesis simply",
  "Teach me a memory trick",
  "Quiz me with one question",
];

export default function AIHelper(p: Props) {
  const [msgs, setMsgs] = useState<Array<{ role: "user" | "assistant"; content: string }>>([
    { role: "assistant", content: "Hi! I'm Forge, your quiz coach. Ask me for hints, explanations, or a practice question — I run on-device when the model is ready." },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [, force] = useState(0);

  useEffect(() => {
    const unsub = webllm.subscribe(() => force((x) => x + 1));
    return () => { unsub(); };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, streaming, p.open]);

  if (!p.open) return null;

  const readyId = webllm.readyModelId;
  const activeModel = readyId ? webllm.snapshot().find((m) => m.spec.id === readyId)?.spec.label : null;

  async function send(text: string) {
    const content = text.trim();
    if (!content || busy) return;
    setErr(null);
    setBusy(true);
    setStreaming("");
    setInput("");
    setMsgs((m) => [...m, { role: "user", content }]);
    beep("click", p.settings.sound);
    const history: ChatMsg[] = [...msgs, { role: "user" as const, content }].map((m) => ({ role: m.role, content: m.content }));
    try {
      const reply = await chatWithAI(
        { provider: p.settings.provider, openrouterKey: p.settings.openrouterKey, openrouterModel: p.settings.openrouterModel },
        history,
        (tok) => setStreaming((s) => s + tok)
      );
      setMsgs((m) => [...m, { role: "assistant", content: reply }]);
      setStreaming("");
      beep("good", p.settings.sound);
    } catch (e: any) {
      setErr(e?.message ?? "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={p.onClose} />
      <div className="anim-slide-up relative flex h-[82dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-[28px] border border-white/10 bg-[#0d0d1f] sm:h-[640px] sm:rounded-[28px]">
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-white/8 px-4 py-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-cyan-400/15 ring-1 ring-cyan-400/30">
            <Bot className="h-5 w-5 text-cyan-300" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-display text-base font-bold text-white">Forge · AI Helper</div>
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-white/50">
              <Cpu className="h-3 w-3" />
              {activeModel ? `${activeModel} · on-device` : readyId ? "On-device ready" : "Cloud fallback · precaching…"}
            </div>
          </div>
          <button onClick={p.onClose} className="flex h-10 w-10 items-center justify-center rounded-full bg-white/5 text-white/70 active:scale-95" aria-label="Close helper">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Messages */}
        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {msgs.map((m, i) => (
            <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
              <div
                className={cn(
                  "max-w-[85%] rounded-3xl px-4 py-2.5 text-sm leading-relaxed",
                  m.role === "user"
                    ? "rounded-br-md bg-violet-500/80 text-white"
                    : "rounded-bl-md bg-white/[0.07] text-white/85 ring-1 ring-white/10"
                )}
              >
                {m.content}
              </div>
            </div>
          ))}
          {streaming && (
            <div className="flex justify-start">
              <div className="max-w-[85%] rounded-3xl rounded-bl-md bg-white/[0.07] px-4 py-2.5 text-sm leading-relaxed text-white/85 ring-1 ring-white/10">
                {streaming}
                <span className="ml-1 inline-block h-3.5 w-1.5 animate-pulse bg-cyan-300" />
              </div>
            </div>
          )}
          {busy && !streaming && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 rounded-3xl rounded-bl-md bg-white/[0.07] px-4 py-3 text-sm text-white/60 ring-1 ring-white/10">
                <Loader2 className="h-4 w-4 animate-spin text-cyan-300" /> Forge is thinking…
              </div>
            </div>
          )}
          {err && <div className="rounded-2xl bg-rose-400/10 px-3 py-2 text-xs font-semibold text-rose-300 ring-1 ring-rose-400/25">{err}</div>}
          <div ref={bottomRef} />
        </div>

        {/* Suggestions */}
        <div className="no-scrollbar flex gap-2 overflow-x-auto px-4 pb-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              onClick={() => send(s)}
              disabled={busy}
              className="shrink-0 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-white/70 active:scale-95 disabled:opacity-40"
            >
              {s}
            </button>
          ))}
        </div>

        {/* Input */}
        <div className="safe-b flex items-center gap-2 border-t border-white/8 px-3 py-3">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send(input)}
            placeholder="Ask for a hint or explanation…"
            className="min-h-[48px] flex-1 rounded-full border border-white/10 bg-white/5 px-4 text-sm text-white placeholder:text-white/35"
          />
          <button
            onClick={() => send(input)}
            disabled={busy || !input.trim()}
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-cyan-400 text-cyan-950 shadow-[0_0_18px_rgba(34,211,238,0.4)] transition active:scale-95 disabled:opacity-40"
            aria-label="Send message"
          >
            <Send className="h-5 w-5" />
          </button>
        </div>
      </div>
    </div>
  );
}
