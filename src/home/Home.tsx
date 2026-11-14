import { Bot, Info, Sparkles } from "lucide-react";

const MODULES = [
  {
    id: "sage",
    name: "SageStrike",
    eye: "Tactical Campaign",
    desc: "Boss-led campaign, Blitz and Gauntlet modes with live-source questions, AI hints, and a persistent skill tree.",
    join: "Enter arena",
    theme: "sage",
  },
  {
    id: "forge",
    name: "BrainForge",
    eye: "On-Device Arena",
    desc: "Instant quiz arena with on-device WebLLM, Puter sign-in and OpenRouter, fully private and offline-first.",
    join: "Start forging",
    theme: "forge",
  },
  {
    id: "info",
    name: "App Info",
    eye: "About & Policies",
    desc: "What QuizMaster is, how your data is handled, our security posture, and the terms of use.",
    join: "Read info",
    theme: "info",
  },
] as const;

interface ModuleCardProps {
  module: (typeof MODULES)[number];
  onEnter: (id: string) => void;
}

function ModuleCard({ module, onEnter }: ModuleCardProps) {
  const theme = module.theme;
  const Icon = theme === "sage" ? Bot : theme === "forge" ? Sparkles : Info;
  return (
    <button
      type="button"
      className={`module-card module-card--${theme}`}
      onClick={() => onEnter(module.id)}
      aria-label={`Open ${module.name}`}
    >
      <span className={`module-glow module-glow--${theme}`} aria-hidden />
      <div>
        <div className="module-eye">
          <Icon size={16} />
          <span>{module.eye}</span>
        </div>
        <h2 className="module-name">{module.name}</h2>
        <p className="module-desc">{module.desc}</p>
      </div>
      <div className={`module-join module-join--${theme}`}>
        <span>{module.join}</span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></svg>
      </div>
    </button>
  );
}

export function Home({ onEnter }: { onEnter: (id: string) => void }) {
  return (
    <div className="quizhome">
      <div className="quizhome-head">
        <span className="quizhome-kicker">
          <Bot size={16} />
          <span>QuizMaster</span>
        </span>
        <h1 className="quizhome-title">
          Pick your <span>quiz arena</span>
        </h1>
        <p className="quizhome-sub">
          One app, {MODULES.length} independent modules. Each runs in its own self-contained shell with its own design system,
          AI providers and storage — switch between them without disturbing the other.
        </p>
      </div>

      <div className="quizhome-grid">
        {MODULES.map((module) => (
          <ModuleCard key={module.id} module={module} onEnter={onEnter} />
        ))}
      </div>

      <p className="quizhome-foot">
        Each module shares the same QuizMaster package but loads its own styles and logic in isolation. Select a module to launch it.
      </p>
    </div>
  );
}

export default Home;
