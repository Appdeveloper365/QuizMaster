import { useEffect, useMemo, useState, type ReactNode } from "react";
import { cn } from "@/utils/cn";
import { haptic } from "@/shared/haptics";

/* ── tiny sound engine (WebAudio, no assets) ── */
let ctx: AudioContext | null = null;
export function beep(kind: "good" | "bad" | "click" | "win" | "tick", enabled = true) {
  if (!enabled) return;
  // Pair the audio cue with a native haptic (no-op on non-native platforms).
  haptic(kind);
  try {
    ctx = ctx ?? new (window.AudioContext || (window as any).webkitAudioContext)();
    if (ctx.state === "suspended") void ctx.resume();
    const t = ctx.currentTime;
    const tone = (f: number, at: number, d: number, type: OscillatorType = "sine", g = 0.08) => {
      const o = ctx!.createOscillator();
      const gn = ctx!.createGain();
      o.type = type;
      o.frequency.value = f;
      gn.gain.setValueAtTime(g, t + at);
      gn.gain.exponentialRampToValueAtTime(0.0001, t + at + d);
      o.connect(gn).connect(ctx!.destination);
      o.start(t + at);
      o.stop(t + at + d);
    };
    if (kind === "good") { tone(660, 0, 0.12); tone(880, 0.09, 0.16); }
    if (kind === "bad") { tone(220, 0, 0.18, "sawtooth", 0.05); tone(160, 0.1, 0.22, "sawtooth", 0.05); }
    if (kind === "click") tone(520, 0, 0.06, "triangle", 0.05);
    if (kind === "tick") tone(980, 0, 0.04, "square", 0.02);
    if (kind === "win") { tone(523, 0, 0.14); tone(659, 0.12, 0.14); tone(784, 0.24, 0.14); tone(1046, 0.36, 0.3); }
  } catch {
    /* audio unavailable */
  }
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("glass rounded-3xl p-4 sm:p-5", className)}>{children}</div>;
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <h2 className="font-display text-sm font-bold uppercase tracking-[0.14em] text-white/85">{children}</h2>
      {right}
    </div>
  );
}

export function Pill({ active, onClick, children, className }: { active?: boolean; onClick?: () => void; children: ReactNode; className?: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "min-h-[40px] rounded-full border px-3.5 py-2 text-sm font-semibold transition active:scale-95",
        active
          ? "border-violet-400/70 bg-violet-500/25 text-white shadow-[0_0_18px_rgba(139,92,246,0.35)]"
          : "border-white/10 bg-white/5 text-white/65 hover:bg-white/10 hover:text-white",
        className
      )}
    >
      {children}
    </button>
  );
}

export function ProgressBar({ value, color = "#a78bfa", className }: { value: number; color?: string; className?: string }) {
  return (
    <div className={cn("h-2.5 w-full overflow-hidden rounded-full bg-white/10", className)}>
      <div
        className="h-full rounded-full transition-all duration-500 ease-out"
        style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`, background: color }}
      />
    </div>
  );
}

export function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="glass rounded-2xl px-3 py-3 text-center">
      <div className="font-display text-xl font-bold text-white">{value}</div>
      <div className="mt-0.5 text-[11px] font-semibold uppercase tracking-wider text-white/50">{label}</div>
      {sub && <div className="mt-0.5 text-[11px] text-white/40">{sub}</div>}
    </div>
  );
}

export function TimerRing({ value, max, size = 64 }: { value: number; max: number; size?: number }) {
  const pct = Math.max(0, Math.min(1, value / max));
  const r = (size - 10) / 2;
  const c = 2 * Math.PI * r;
  const color = pct > 0.5 ? "#34d399" : pct > 0.25 ? "#fbbf24" : "#fb7185";
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth={5} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={5} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - pct)} className="transition-all duration-300"
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center font-display text-base font-bold text-white">{Math.ceil(value)}</div>
    </div>
  );
}

export function Confetti({ show }: { show: boolean }) {
  const pieces = useMemo(
    () =>
      Array.from({ length: 36 }, (_, i) => ({
        id: i,
        left: Math.random() * 100,
        delay: Math.random() * 0.9,
        dur: 2.6 + Math.random() * 1.8,
        color: ["#a78bfa", "#22d3ee", "#fbbf24", "#34d399", "#fb7185"][i % 5],
        size: 6 + Math.random() * 7,
        round: Math.random() > 0.5,
      })),
    []
  );
  if (!show) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-50 overflow-hidden" aria-hidden>
      {pieces.map((p) => (
        <span
          key={p.id}
          className="absolute top-0"
          style={{
            left: `${p.left}%`,
            width: p.size,
            height: p.size * (p.round ? 1 : 0.45),
            background: p.color,
            borderRadius: p.round ? "50%" : 2,
            animation: `confetti-fall ${p.dur}s ease-in ${p.delay}s both`,
          }}
        />
      ))}
    </div>
  );
}

export function Toast({ msg }: { msg: string | null }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!msg) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 2600);
    return () => clearTimeout(t);
  }, [msg]);
  if (!visible || !msg) return null;
  return (
    <div className="anim-slide-up fixed bottom-24 left-1/2 z-[70] -translate-x-1/2 sm:bottom-8">
      <div className="glass max-w-[90vw] rounded-full px-4 py-2.5 text-sm font-semibold text-white shadow-2xl">{msg}</div>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton animate-pulse rounded-2xl", className)} />;
}
