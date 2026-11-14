import { useEffect, useState } from "react";
import { Bot, CheckCircle2, Cpu, Download, HardDrive, Pause, Play, RefreshCw, ShieldCheck, Wifi, Zap } from "lucide-react";
import { webllm } from "../lib/webllm";
import type { ModelState } from "../lib/types";
import { Card, ProgressBar, SectionTitle } from "./ui";
import { cn } from "@/utils/cn";

function statusChip(s: ModelState) {
  const map: Record<string, { label: string; cls: string }> = {
    idle: { label: "Not downloaded", cls: "bg-white/10 text-white/60" },
    checking: { label: "Checking cache", cls: "bg-cyan-400/15 text-cyan-300" },
    queued: { label: s.cached ? "Precached" : "Queued", cls: "bg-violet-400/15 text-violet-300" },
    downloading: { label: "Downloading", cls: "bg-amber-400/15 text-amber-300" },
    loading: { label: "Loading on GPU", cls: "bg-amber-400/15 text-amber-300" },
    ready: { label: "Helper ready", cls: "bg-emerald-400/15 text-emerald-300" },
    error: { label: "Failed", cls: "bg-rose-400/15 text-rose-300" },
    unsupported: { label: "WebGPU needed", cls: "bg-white/10 text-white/50" },
    paused: { label: "Paused", cls: "bg-white/10 text-white/60" },
  };
  const m = map[s.status] ?? map.idle;
  return <span className={cn("rounded-full px-2.5 py-1 text-[11px] font-bold", m.cls)}>{m.label}</span>;
}

export default function PrecachePanel({ compact = false, onChanged }: { compact?: boolean; onChanged?: () => void }) {
  const [, force] = useState(0);
  const [storage, setStorage] = useState<{ usageMB: number; quotaMB: number } | null>(null);

  useEffect(() => {
    const unsub = webllm.subscribe(() => force((x) => x + 1));
    return () => { unsub(); };
  }, []);
  useEffect(() => {
    webllm.storageEstimate().then(setStorage).catch(() => {});
  }, []);

  const models = webllm.snapshot();
  const overall = webllm.overallProgress();
  const ready = models.filter((m) => m.status === "ready").length;
  const cached = models.filter((m) => m.cached).length;
  const anyActive = models.some((m) => m.status === "downloading" || m.status === "loading" || m.status === "checking");
  const paused = models.some((m) => m.status === "paused");

  return (
    <Card className={cn(compact && "p-4")}>
      <SectionTitle
        right={
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-400/10 px-2.5 py-1 text-[11px] font-bold text-emerald-300">
            <ShieldCheck className="h-3.5 w-3.5" /> Optional
          </span>
        }
      >
        <span className="inline-flex items-center gap-2">
          <Bot className="h-4 w-4 text-violet-300" /> On-device AI models
        </span>
      </SectionTitle>

      <p className="mb-3 text-[13px] leading-relaxed text-white/55">
        WebLLM downloads are manual and optional. Questions still work from live sources if a model cannot fit in browser storage. {ready > 0 ? `${ready} model${ready > 1 ? "s are" : " is"} ready.` : cached > 0 ? `${cached} precached.` : "No model download is running."}
      </p>

      <div className="mb-4 flex items-center gap-3">
        <ProgressBar value={overall} color="#34d399" className="flex-1" />
        <span className="font-display text-sm font-bold text-white">{Math.round(overall * 100)}%</span>
      </div>

      <div className="space-y-2.5">
        {models.map((m) => (
          <div key={m.spec.id} className="rounded-2xl border border-white/8 bg-white/[0.04] p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-display text-sm font-bold text-white">{m.spec.label}</span>
                  {m.spec.tier === "primary" && <Zap className="h-3.5 w-3.5 shrink-0 text-amber-300" />}
                  {m.spec.tier === "strong" && <span className="shrink-0 rounded-full bg-amber-400/15 px-2 py-0.5 text-[10px] font-bold text-amber-300">STRONG</span>}
                </div>
                <div className="mt-0.5 truncate text-[11px] text-white/40">{m.spec.id}</div>
              </div>
              {statusChip(m)}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <ProgressBar value={m.progress} color={m.status === "ready" ? "#34d399" : m.status === "error" ? "#fb7185" : "#a78bfa"} className="flex-1" />
              <span className="w-16 text-right text-[11px] font-semibold text-white/50">
                {m.status === "ready" || m.status === "queued" && m.cached ? `${m.spec.sizeMB} MB` : `${m.downloadedMB}/${m.spec.sizeMB} MB`}
              </span>
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-2">
              <span className="truncate text-[11px] text-white/45">{m.detail}</span>
              {((m.status === "paused" || m.status === "error" || m.status === "idle") || (m.spec.tier === "strong" && m.status === "queued")) && m.spec.tier !== "pro" && (
                <button
                  onClick={() => { webllm.resume(m.spec.id); onChanged?.(); }}
                  className="inline-flex shrink-0 items-center gap-1 rounded-full bg-violet-500/20 px-2.5 py-1 text-[11px] font-bold text-violet-200 active:scale-95"
                >
                  <Play className="h-3 w-3" /> {m.status === "paused" ? "Resume" : "Download"}
                </button>
              )}
              {m.spec.tier === "pro" && m.status === "idle" && (
                <button
                  onClick={() => { webllm.resume(m.spec.id); onChanged?.(); }}
                  className="inline-flex shrink-0 items-center gap-1 rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-bold text-white/70 active:scale-95"
                >
                  <Download className="h-3 w-3" /> 4.7 GB
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 text-[11px] text-white/45">
        <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-semibold", webllm.webgpu ? "bg-emerald-400/10 text-emerald-300" : "bg-rose-400/10 text-rose-300")}>
          <Cpu className="h-3.5 w-3.5" /> WebGPU {webllm.webgpu ? "supported" : "not supported"}
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-white/5 px-2.5 py-1 font-semibold">
          <Wifi className="h-3.5 w-3.5" /> {webllm.saveData ? "Data Saver on" : webllm.slowNetwork ? "Slow network" : "Fast network"}
        </span>
        {storage && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white/5 px-2.5 py-1 font-semibold">
            <HardDrive className="h-3.5 w-3.5" /> {storage.usageMB} MB used
          </span>
        )}
        {anyActive && (
          <button onClick={() => webllm.cancel()} className="inline-flex items-center gap-1.5 rounded-full bg-white/5 px-2.5 py-1 font-semibold text-white/70 active:scale-95">
            <Pause className="h-3.5 w-3.5" /> Pause
          </button>
        )}
        {(paused || !anyActive) && (
          <button onClick={() => { webllm.resume(); onChanged?.(); }} className="inline-flex items-center gap-1.5 rounded-full bg-white/5 px-2.5 py-1 font-semibold text-white/70 active:scale-95">
            <RefreshCw className="h-3.5 w-3.5" /> Resume all
          </button>
        )}
        <span className="inline-flex items-center gap-1.5">
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-300" /> {cached}/{models.length} cached
        </span>
      </div>
    </Card>
  );
}
