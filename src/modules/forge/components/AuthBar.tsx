import { useState } from "react";
import { Bot, Download, LogIn, LogOut, Settings as SettingsIcon, Sparkles, User } from "lucide-react";
import type { PuterUser } from "../lib/types";
import { signInWithPuter, signOutOfPuter } from "../lib/puter";
import { beep } from "./ui";

interface Props {
  user: PuterUser | null;
  avatar: string | null;
  puterReady: boolean;
  helperReady: boolean;
  onUser: (u: PuterUser | null, avatar: string | null) => void;
  onOpenSettings: () => void;
  onOpenHelper: () => void;
  onInstall: () => void;
  canInstall: boolean;
  sound: boolean;
}

export default function AuthBar(p: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function signIn() {
    setBusy(true);
    setErr(null);
    try {
      const u = await signInWithPuter();
      p.onUser(u, null);
      beep("good", p.sound);
    } catch (e: any) {
      setErr(e?.msg ?? e?.message ?? "Sign-in failed. Allow popups and retry.");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    await signOutOfPuter();
    p.onUser(null, null);
  }

  return (
    <header className="safe-t sticky top-0 z-40 border-b border-white/8 bg-[#070714]/85 backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl items-center gap-2 px-3 py-2.5 sm:gap-3 sm:px-5">
        {/* Logo */}
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="anim-floaty flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-violet-500/20 ring-1 ring-violet-400/40">
            <Sparkles className="h-5 w-5 text-violet-300" />
          </div>
          <div className="min-w-0">
            <div className="font-display truncate text-base font-bold leading-tight text-white sm:text-lg">BrainForge</div>
            <div className="truncate text-[10px] font-semibold uppercase tracking-[0.18em] text-white/40">AI Quiz Arena</div>
          </div>
        </div>

        <div className="flex-1" />

        {/* Helper status */}
        <button
          onClick={p.onOpenHelper}
          className="relative flex h-10 items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 text-xs font-bold text-white/80 active:scale-95"
          aria-label="Open AI helper"
        >
          <Bot className="h-4.5 w-4.5 text-cyan-300" />
          <span className="hidden sm:inline">AI Helper</span>
          <span className={`h-2 w-2 rounded-full ${p.helperReady ? "bg-emerald-400 anim-pulse-ring" : "bg-amber-400 animate-pulse"}`} />
        </button>

        {/* Install */}
        <button
          onClick={p.onInstall}
          className="hidden h-10 items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 text-xs font-bold text-white/80 active:scale-95 sm:flex"
          aria-label="Install app"
        >
          <Download className="h-4 w-4" />
          {p.canInstall ? "Install APK" : "APK"}
        </button>

        {/* Settings */}
        <button
          onClick={p.onOpenSettings}
          className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white/80 active:scale-95"
          aria-label="Settings"
        >
          <SettingsIcon className="h-4.5 w-4.5" />
        </button>

        {/* Puter auth */}
        {p.user ? (
          <div className="flex items-center gap-2">
            <div className="flex h-10 items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-400/10 py-1 pl-1 pr-3">
              {p.avatar ? (
                <img src={p.avatar} alt="" className="h-8 w-8 rounded-full object-cover" />
              ) : (
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-400/25 text-sm font-bold text-emerald-200">
                  {(p.user.username ?? "G").slice(0, 1).toUpperCase()}
                </span>
              )}
              <span className="hidden max-w-28 truncate text-xs font-bold text-emerald-200 md:block">{p.user.username}</span>
            </div>
            <button
              onClick={signOut}
              className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white/70 active:scale-95"
              aria-label="Sign out of Puter"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <button
            onClick={signIn}
            disabled={busy || !p.puterReady}
            className="flex h-10 items-center gap-2 rounded-full bg-emerald-400 px-4 text-xs font-extrabold text-emerald-950 shadow-[0_0_20px_rgba(52,211,153,0.35)] transition active:scale-95 disabled:opacity-50"
          >
            <LogIn className="h-4 w-4" />
            {busy ? "Signing in…" : p.puterReady ? "Puter Sign-in" : "Loading Puter…"}
          </button>
        )}
      </div>
      {err && <div className="mx-auto max-w-6xl px-3 pb-2 text-xs font-semibold text-rose-300 sm:px-5">{err}</div>}
      {!p.user && p.puterReady && (
        <div className="mx-auto flex max-w-6xl items-center gap-1.5 px-3 pb-2 text-[11px] text-white/40 sm:px-5">
          <User className="h-3 w-3" /> Guest play works fully. Sign in with Puter only if you want its optional cloud AI.
        </div>
      )}
    </header>
  );
}
