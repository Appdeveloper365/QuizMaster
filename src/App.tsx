import { useEffect, useRef, useState } from "react";
import { App as CapacitorApp } from "@capacitor/app";
import Home from "./home/Home";
import Strike from "./modules/strike/App";
import Forge from "./modules/forge/App";
import AppInfo from "./modules/info/App";
import ErrorBoundary from "./components/ErrorBoundary";

type ModuleId = "sage" | "forge" | "info";

// Browser-/status-bar tint per shell so the Android chrome matches each module's background.
const THEME_COLORS: Record<ModuleId | "home", string> = {
  home: "#10131b",
  sage: "#f5f5ef",
  forge: "#070714",
  info: "#10131b",
};

export default function App() {
  const [moduleId, setModuleId] = useState<ModuleId | null>(null);
  const moduleIdRef = useRef<ModuleId | null>(null);
  moduleIdRef.current = moduleId;

  useEffect(() => {
    const color = moduleId ? THEME_COLORS[moduleId] : THEME_COLORS.home;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", color);
  }, [moduleId]);

  // Android hardware back button: return from a module to Home instead of closing the app.
  useEffect(() => {
    let removed = false;
    let handle: { remove: () => void } | null = null;
    void CapacitorApp.addListener("backButton", () => {
      if (moduleIdRef.current) setModuleId(null);
    }).then((h) => {
      if (removed) h.remove();
      else handle = h;
    });
    return () => {
      removed = true;
      handle?.remove();
    };
  }, []);

  return (
    <ErrorBoundary key={moduleId ?? "home"} onReset={() => setModuleId(null)}>
      {moduleId === "sage" ? (
        <Strike onBack={() => setModuleId(null)} />
      ) : moduleId === "forge" ? (
        <Forge onBack={() => setModuleId(null)} />
      ) : moduleId === "info" ? (
        <AppInfo onBack={() => setModuleId(null)} />
      ) : (
        <Home onEnter={(id) => setModuleId(id as ModuleId)} />
      )}
    </ErrorBoundary>
  );
}
