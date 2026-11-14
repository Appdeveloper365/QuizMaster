import { useState } from "react";
import {
  Check, Cloud, Cpu, Download, Eye, EyeOff, FileQuestion, KeyRound, Loader2, LockKeyhole, Smartphone, Trash2, Volume2, Zap,
} from "lucide-react";
import type { ProviderId, Settings as SettingsT } from "../lib/types";
import { OPENROUTER_MODELS, looksLikeOpenRouterKey, openRouterChat } from "../lib/openrouter";
import { MODELS, webllm } from "../lib/webllm";
import { Card, SectionTitle, beep } from "./ui";
import PrecachePanel from "./PrecachePanel";
import { cn } from "@/utils/cn";

interface Props {
  settings: SettingsT;
  onSettings: (s: SettingsT) => void;
  onInstall: () => void;
  canInstall: boolean;
  onToast: (m: string) => void;
  questionHistoryCount: number;
  onOpenQuestionHistory: () => void;
}

function Toggle({ on, onClick, label, hint }: { on: boolean; onClick: () => void; label: string; hint: string }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-3 rounded-2xl bg-white/[0.04] px-3 py-3 text-left active:scale-[0.99]">
      <span className={cn("relative h-7 w-12 shrink-0 rounded-full transition", on ? "bg-emerald-400" : "bg-white/15")}>
        <span className={cn("absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all", on ? "left-6" : "left-1")} />
      </span>
      <span>
        <span className="block text-sm font-bold text-white">{label}</span>
        <span className="block text-[12px] text-white/45">{hint}</span>
      </span>
    </button>
  );
}

export default function Settings(p: Props) {
  const s = p.settings;
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [loadingModel, setLoadingModel] = useState<string | null>(null);

  async function testKey() {
    setTesting(true);
    setTestMsg(null);
    try {
      const r = await openRouterChat(s.openrouterKey, s.openrouterModel, [{ role: "user", content: "Reply with just: OK" }], { maxTokens: 10 });
      setTestMsg(`Connected — model replied: "${r.slice(0, 40)}"`);
      beep("good", s.sound);
    } catch (e: any) {
      setTestMsg(e?.message ?? "Connection failed.");
    } finally {
      setTesting(false);
    }
  }

  async function pickWebllmModel(id: string) {
    p.onSettings({ ...s, webllmModel: id });
    setLoadingModel(id);
    try {
      await webllm.ensureModel(id);
      p.onToast("Helper model loaded");
    } catch (e: any) {
      p.onToast(e?.message ?? "Could not load model");
    } finally {
      setLoadingModel(null);
    }
  }

  async function clearCache() {
    setClearing(true);
    try {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => /llm|mlc|webllm/i.test(k)).map((k) => caches.delete(k)));
      // WebLLM can park weights in IndexedDB when the Cache API is unavailable
      // (some Android WebViews). Purge those too, or this button would report
      // success while leaving gigabytes of model files behind.
      const idb = indexedDB as IDBFactory & { databases?: () => Promise<{ name?: string }[]> };
      if (typeof idb.databases === "function") {
        const all = await idb.databases();
        await Promise.all(
          all
            .filter((db) => db.name && /llm|mlc|webllm/i.test(db.name))
            .map((db) => new Promise<void>((resolve) => {
              const request = indexedDB.deleteDatabase(db.name!);
              request.onsuccess = () => resolve();
              request.onerror = () => resolve();
              request.onblocked = () => resolve();
            })),
        );
      }
      localStorage.removeItem("bf_precache_v1");
      p.onToast("Model cache cleared — models will re-download");
      setTimeout(() => window.location.reload(), 900);
    } catch {
      p.onToast("Could not clear cache");
      setClearing(false);
    }
  }

  const keyOk = looksLikeOpenRouterKey(s.openrouterKey);

  return (
    <div className="mx-auto max-w-3xl px-3 pb-28 pt-4 sm:px-5">
      <h1 className="font-display mb-4 text-2xl font-bold text-white">Settings</h1>

      <div className="space-y-4">
        <Card>
          <SectionTitle>Question engine</SectionTitle>
          <select
            value={s.provider}
            onChange={(e) => p.onSettings({ ...s, provider: e.target.value as ProviderId })}
            className="min-h-[48px] w-full rounded-2xl border border-white/10 bg-[#14142b] px-3 text-sm text-white"
          >
            <option value="webllm">WebLLM · on-device when available</option>
            <option value="puter">Puter AI · signed-in cloud</option>
            <option value="openrouter">OpenRouter · API key</option>
            <option value="offline">Verified source-only · no model</option>
          </select>
          <p className="mt-2 text-[12px] text-white/45">If the browser cannot store WebLLM files, source-verified questions continue without the model.</p>
        </Card>

        <details className="glass group rounded-3xl p-4">
          <summary className="min-h-10 cursor-pointer text-sm font-bold text-white/75">Optional · On-device model downloads</summary>
          <div className="mt-3 space-y-4">
            <PrecachePanel compact />
            <div className="space-y-2">
              {MODELS.map((m) => {
                const active = s.webllmModel === m.id;
                const busy = loadingModel === m.id;
                return (
                  <button
                    key={m.id}
                    onClick={() => pickWebllmModel(m.id)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-2xl border px-3 py-3 text-left transition active:scale-[0.99]",
                      active ? "border-cyan-400/60 bg-cyan-400/10" : "border-white/8 bg-white/[0.04]"
                    )}
                  >
                    <Cpu className={cn("h-5 w-5 shrink-0", active ? "text-cyan-300" : "text-white/40")} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-sm font-bold text-white">
                        {m.label}
                        {m.tier === "strong" && <span className="rounded-full bg-amber-400/15 px-2 py-0.5 text-[10px] font-bold text-amber-300">STRONG</span>}
                      </span>
                      <span className="block truncate text-[11px] text-white/45">{m.blurb} · {m.sizeMB} MB</span>
                    </span>
                    {busy ? <Loader2 className="h-4 w-4 animate-spin text-cyan-300" /> : active ? <Check className="h-4 w-4 text-emerald-300" /> : null}
                  </button>
                );
              })}
            </div>
          </div>
        </details>

        <Card>
          <SectionTitle>OpenRouter</SectionTitle>
          <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-white/50">API key</label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <KeyRound className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" />
              <input
                type={showKey ? "text" : "password"}
                value={s.openrouterKey}
                onChange={(e) => p.onSettings({ ...s, openrouterKey: e.target.value.trim() })}
                placeholder="sk-or-v1-…"
                autoComplete="off"
                className="min-h-[48px] w-full rounded-2xl border border-white/10 bg-white/5 pl-10 pr-11 text-sm text-white placeholder:text-white/30"
              />
              <button onClick={() => setShowKey(!showKey)} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-2 text-white/50" aria-label="Show key">
                {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
          <div className="mt-2 flex items-center gap-2 text-[12px]">
            {s.openrouterKey ? (
              keyOk ? <span className="inline-flex items-center gap-1 font-semibold text-emerald-300"><Check className="h-3.5 w-3.5" /> Key format looks good</span>
              : <span className="font-semibold text-amber-300">Key should start with sk-or-v1-</span>
            ) : (
              <span className="text-white/45">Get a free key at openrouter.ai → Keys. Free models need no credits.</span>
            )}
          </div>

          <label className="mb-1.5 mt-4 block text-xs font-bold uppercase tracking-wider text-white/50">Model</label>
          <select
            value={s.openrouterModel}
            onChange={(e) => p.onSettings({ ...s, openrouterModel: e.target.value })}
            className="min-h-[48px] w-full rounded-2xl border border-white/10 bg-[#14142b] px-3 text-sm text-white"
          >
            {OPENROUTER_MODELS.map((m) => (
              <option key={m.id} value={m.id}>{m.label} — {m.hint}</option>
            ))}
          </select>

          <button
            onClick={testKey}
            disabled={testing || !keyOk}
            className="mt-3 flex min-h-[46px] w-full items-center justify-center gap-2 rounded-2xl bg-violet-500/25 text-sm font-bold text-violet-100 ring-1 ring-violet-400/40 transition active:scale-[0.99] disabled:opacity-40"
          >
            {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
            {testing ? "Testing…" : "Test connection"}
          </button>
          {testMsg && <div className="mt-2 rounded-2xl bg-white/[0.05] px-3 py-2 text-[12px] font-semibold text-white/70">{testMsg}</div>}
        </Card>

        <Card>
          <SectionTitle>Preferences</SectionTitle>
          <div className="space-y-2">
            <Toggle on={s.sound} onClick={() => p.onSettings({ ...s, sound: !s.sound })} label="Sound effects" hint="Correct / wrong / win sounds" />
          </div>
          <div className="mt-3 flex items-center gap-2 text-[12px] text-white/45">
            <Volume2 className="h-4 w-4" /> <Cloud className="h-4 w-4" />
            <span>Works on phones, tablets & desktops. WebGPU is optional.</span>
          </div>
        </Card>

        <details className="glass group rounded-3xl p-4">
          <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 text-sm font-bold text-white/70">
            <LockKeyhole className="h-4 w-4 text-violet-300" />
            <span className="flex-1">Hidden setting · Past questions</span>
            <span className="rounded-full bg-violet-400/15 px-2.5 py-1 text-[11px] font-bold text-violet-200">{p.questionHistoryCount} / 2</span>
          </summary>
          <p className="mt-2 text-[12px] leading-relaxed text-white/45">This archive is kept out of the main navigation. It stores only the latest two generated questions; older questions are automatically deleted.</p>
          <button
            onClick={p.onOpenQuestionHistory}
            className="mt-3 flex min-h-[48px] w-full items-center justify-center gap-2 rounded-2xl bg-violet-500/20 text-sm font-bold text-violet-100 ring-1 ring-violet-400/35 active:scale-[0.99]"
          >
            <FileQuestion className="h-4 w-4" /> Open past questions
          </button>
        </details>

        <Card>
          <SectionTitle>Install as Android APK</SectionTitle>
          <div className="flex items-start gap-3 rounded-2xl bg-white/[0.04] px-3 py-3">
            <Smartphone className="mt-0.5 h-5 w-5 shrink-0 text-violet-300" />
            <p className="text-[13px] leading-relaxed text-white/60">
              BrainForge is a PWA — install it and it behaves like a native APK (icon, fullscreen, offline).
              {p.canInstall ? " Tap below to install right now." : " On Android Chrome: menu → “Install app” / “Add to Home screen”. For a signed APK file, wrap this URL with PWABuilder (pwabuilder.com) or Bubblewrap (TWA) — no code changes needed."}
            </p>
          </div>
          <button
            onClick={p.onInstall}
            className="mt-3 flex min-h-[52px] w-full items-center justify-center gap-2 rounded-3xl bg-emerald-400 font-display text-base font-bold text-emerald-950 transition active:scale-[0.98]"
          >
            <Download className="h-5 w-5" /> {p.canInstall ? "Install app (APK)" : "How to install"}
          </button>
          <button
            onClick={clearCache}
            disabled={clearing}
            className="mt-2 flex min-h-[46px] w-full items-center justify-center gap-2 rounded-2xl bg-rose-400/10 text-sm font-bold text-rose-300 ring-1 ring-rose-400/25 transition active:scale-[0.99] disabled:opacity-40"
          >
            {clearing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            Clear downloaded models
          </button>
        </Card>
      </div>
    </div>
  );
}
