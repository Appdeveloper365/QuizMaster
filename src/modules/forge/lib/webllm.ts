import type { ChatMsg, ModelSpec, ModelState, PrecacheStatus } from "./types";
import { buildAppConfig, getBundledModels } from "@/shared/bundled";

/* ─────────────────────────────────────────────────────────────
   WebLLM Precache Helper — on-device AI Assist models.
   On startup the app prefetches / precaches / preloads fast
   Llama 3.1 + Qwen 3.5 builds in the BACKGROUND (low priority,
   after first paint) so the AI helper is instant + offline.
   Weights land in the browser Cache API / IndexedDB on first
   download; later launches load from cache in ~seconds.
   The engine library itself ships in the app bundle (npm
   @mlc-ai/web-llm) — no CDN dependency at runtime.
   ───────────────────────────────────────────────────────────── */

function modelErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/cache|quota|storage|internal error/i.test(message)) {
    return "WebLLM could not save model files in browser storage. Free device storage or try again in Settings. Live-source quiz questions still work without the model.";
  }
  return message || "WebLLM could not load this model.";
}

export const MODELS: ModelSpec[] = [
  {
    id: "Qwen3.5-0.8B-q4f16_1-MLC",
    label: "Qwen 3.5 · 0.8B Turbo",
    family: "Qwen 3.5",
    // Refined from bundled-manifest.json at runtime when the weights are shipped.
    sizeMB: 850,
    tier: "primary",
    blurb: "Instant helper — bundled in the app when fetched; otherwise downloads on demand.",
  },
  {
    id: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
    label: "Llama 3.1 · 1B Turbo",
    family: "Llama 3.1",
    sizeMB: 663,
    tier: "primary",
    blurb: "Fastest helper — hints & explanations in <1s on most GPUs.",
  },
  {
    id: "Qwen2.5-3B-Instruct-q4f16_1-MLC",
    label: "Qwen 3.5 · 3B Strong",
    family: "Qwen 3.5",
    sizeMB: 1600,
    tier: "primary",
    blurb: "Strong reasoning — best on-device quality for hard / expert rounds.",
  },
  {
    id: "Llama-3.2-3B-Instruct-q4f16_1-MLC",
    label: "Llama 3.1 · 3B Smart",
    family: "Llama 3.1",
    sizeMB: 1700,
    tier: "secondary",
    blurb: "Deeper quiz generation + trickier explanations.",
  },
  {
    id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
    label: "Qwen 3.5 · 1.5B",
    family: "Qwen 3.5",
    sizeMB: 828,
    tier: "secondary",
    blurb: "Sharp multilingual reasoning, still very fast.",
  },
  {
    id: "Qwen2.5-7B-Instruct-q4f16_1-MLC",
    label: "Qwen 3.5 · 7B Strong",
    family: "Qwen 3.5",
    sizeMB: 4400,
    tier: "strong",
    blurb: "Desktop-grade quality. Auto-precaches on powerful devices.",
  },
  {
    id: "Llama-3.1-8B-Instruct-q4f32_1-MLC",
    label: "Llama 3.1 · 8B Pro",
    family: "Llama 3.1",
    sizeMB: 4700,
    tier: "pro",
    blurb: "Desktop-grade. Manual download only (large).",
  },
];

export const PRIMARY_IDS = MODELS.filter((m) => m.tier === "primary").map((m) => m.id);

type Listener = () => void;

class WebLLMManager {
  states = new Map<string, ModelState>();
  private listeners = new Set<Listener>();
  private lib: any | null = null;
  private engine: any | null = null; // resident helper engine
  private activeId: string | null = null;
  private queue: string[] = [];
  private running = false;
  private cancelled = false;
  private inflight = new Map<string, Promise<void>>();
  private progressTarget: string | null = null;
  webgpu = false;
  saveData = false;
  slowNetwork = false;
  deviceMemoryGB: number | null = null;
  private booted = false;

  constructor() {
    for (const spec of MODELS) {
      this.states.set(spec.id, {
        spec,
        status: "idle",
        progress: 0,
        detail: "Not downloaded yet",
        cached: false,
        downloadedMB: 0,
      });
    }
    try {
      this.webgpu = typeof navigator !== "undefined" && !!(navigator as any).gpu;
      const conn: any = (navigator as any).connection ?? {};
      this.saveData = !!conn.saveData;
      this.slowNetwork = conn.effectiveType === "2g" || conn.effectiveType === "3g";
      this.deviceMemoryGB = typeof (navigator as any).deviceMemory === "number" ? (navigator as any).deviceMemory : null;
    } catch {
      /* noop */
    }
    this.restore();
  }

  /* ── persistence (status only — weights live in WebLLM cache) ── */
  private restore() {
    try {
      const raw = localStorage.getItem("bf_precache_v1");
      if (!raw) return;
      const saved = JSON.parse(raw) as Record<string, { cached: boolean; at: number }>;
      for (const [id, s] of Object.entries(saved)) {
        const st = this.states.get(id);
        if (st && s.cached) {
          st.cached = true;
          st.status = "queued";
          st.detail = "Downloaded — will load from cache";
          st.progress = 1;
          st.downloadedMB = st.spec.sizeMB;
        }
      }
    } catch {
      /* noop */
    }
  }

  private persist(id: string) {
    try {
      const raw = localStorage.getItem("bf_precache_v1");
      const obj = raw ? JSON.parse(raw) : {};
      obj[id] = { cached: true, at: Date.now() };
      localStorage.setItem("bf_precache_v1", JSON.stringify(obj));
    } catch {
      /* noop */
    }
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit() {
    this.listeners.forEach((f) => f());
  }

  private set(id: string, patch: Partial<ModelState>) {
    const st = this.states.get(id);
    if (!st) return;
    Object.assign(st, patch);
    this.emit();
  }

  snapshot(): ModelState[] {
    return MODELS.map((m) => this.states.get(m.id)!);
  }

  get activeModelId() {
    return this.activeId;
  }

  get readyModelId(): string | null {
    for (const m of MODELS) {
      if (this.states.get(m.id)?.status === "ready") return m.id;
    }
    return null;
  }

  overallProgress(): number {
    const prim = PRIMARY_IDS.map((id) => this.states.get(id)!);
    const sum = prim.reduce((a, s) => a + s.progress, 0);
    return prim.length ? sum / prim.length : 0;
  }

  /** Strong (7B) models only auto-precache on powerful devices. */
  isCapableDevice(): boolean {
    const mem = this.deviceMemoryGB;
    if (mem === null) return true; // desktop browsers often don't report it
    return mem >= 8;
  }

  /* ── library ── */
  private async loadLib(): Promise<any> {
    if (this.lib) return this.lib;
    // Ships in the app bundle (same @mlc-ai/web-llm package SageStrike
    // uses). Vite splits it into a lazy chunk; no CDN needed.
    this.lib = await import("@mlc-ai/web-llm");
    return this.lib;
  }

  /**
   * Reflect app-bundled models in the UI. Called once on app mount.
   * Bundled models are marked precached so the panel shows "Included in the
   * app" instead of suggesting a download; the manifest also refines sizeMB.
   */
  async initBundled(): Promise<void> {
    const bundled = await getBundledModels();
    for (const [id, info] of bundled) {
      const st = this.states.get(id);
      if (!st) continue;
      if (typeof info.sizeMB === "number" && info.sizeMB > 0) st.spec.sizeMB = info.sizeMB;
      if (st.status === "idle") {
        this.set(id, {
          cached: true,
          status: "queued",
          progress: 1,
          downloadedMB: st.spec.sizeMB,
          detail: "Included in the app — loads without a download",
        });
      }
    }
    if (bundled.size) this.emit();
  }

  async checkCache(id: string): Promise<boolean> {
    // Weights shipped in the APK — report as cached before probing engine storage.
    if ((await getBundledModels()).has(id)) {
      const st = this.states.get(id);
      this.set(id, {
        cached: true,
        status: "queued",
        progress: 1,
        downloadedMB: st?.spec.sizeMB ?? 0,
        detail: "Included in the app — loads without a download",
      });
      return true;
    }
    try {
      const lib = await this.loadLib();
      if (typeof lib.hasModelInCache === "function") {
        const hit = await lib.hasModelInCache(id);
        if (hit) {
          this.set(id, { cached: true, status: "queued", progress: 1, downloadedMB: this.states.get(id)!.spec.sizeMB, detail: "In browser cache — loads instantly" });
          return true;
        }
      }
    } catch {
      /* fall through */
    }
    return false;
  }

  /* ── background precache queue (startup) ── */
  async startBackgroundPrecache(opts: { wifiOnly?: boolean; includeSecondary?: boolean } = {}) {
    if (this.booted) return;
    this.booted = true;

    if (!this.webgpu) {
      for (const m of MODELS) {
        this.set(m.id, { status: "unsupported", detail: "WebGPU not available — cloud AI will be used" });
      }
      return;
    }
    if (this.saveData || this.slowNetwork) {
      for (const id of PRIMARY_IDS) {
        this.set(id, { status: "paused", detail: this.saveData ? "Paused — Data Saver is on" : "Paused — slow connection" });
      }
      return;
    }
    const conn: any = (navigator as any).connection ?? {};
    if (opts.wifiOnly && conn.type && conn.type !== "wifi") {
      for (const id of PRIMARY_IDS) {
        this.set(id, { status: "paused", detail: "Paused — Wi-Fi only mode" });
      }
      return;
    }

    // Check what's already cached first (instant on repeat visits).
    for (const id of PRIMARY_IDS) {
      this.set(id, { status: "checking", detail: "Checking browser cache…" });
      await this.checkCache(id);
    }

    const toFetch = PRIMARY_IDS.filter((id) => this.states.get(id)?.status !== "queued");
    this.queue = [...toFetch];
    if (opts.includeSecondary) {
      this.queue.push(...MODELS.filter((m) => m.tier === "secondary").map((m) => m.id));
    }
    // Strong 7B model: auto-precache on powerful devices, on-demand elsewhere.
    const strongIds = MODELS.filter((m) => m.tier === "strong").map((m) => m.id);
    if (this.isCapableDevice()) {
      for (const id of strongIds) {
        if (this.states.get(id)?.status !== "queued" && !this.queue.includes(id)) this.queue.push(id);
      }
    } else {
      for (const id of strongIds) {
        const st = this.states.get(id);
        if (st && st.status === "idle") {
          this.set(id, { status: "queued", detail: "Strong model — downloads on first use (low-memory device)" });
        }
      }
    }
    for (const id of this.queue) {
      if (this.states.get(id)?.status === "idle") this.set(id, { status: "queued", detail: "Queued for background download" });
    }
    void this.pump();
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length && !this.cancelled) {
      const id = this.queue.shift()!;
      try {
        await this.precacheModel(id, { keepResident: this.activeId === null || this.activeId === id });
      } catch (e: any) {
        this.set(id, { status: "error", detail: modelErrorMessage(e) });
      }
    }
    this.running = false;
  }

  /** Download + load a model. First model stays resident as the helper. */
  async precacheModel(id: string, _opts: { keepResident?: boolean } = {}): Promise<void> {
    const existing = this.inflight.get(id);
    if (existing) return existing;
    const task = this.doPrecache(id);
    this.inflight.set(id, task);
    try {
      await task;
    } finally {
      this.inflight.delete(id);
    }
  }

  private async doPrecache(id: string): Promise<void> {
    const st = this.states.get(id);
    if (!st) return;
    if (st.status === "ready") return;
    if (!this.webgpu) throw new Error("WebGPU is not available on this device/browser.");

    const lib = await this.loadLib();
    const CreateMLCEngine = lib.CreateMLCEngine ?? lib.default?.CreateMLCEngine;
    if (!CreateMLCEngine) throw new Error("WebLLM engine failed to load.");

    // Bundled models resolve to local /models/ paths; everything else keeps
    // the stock HuggingFace flow (falls back gracefully when nothing is bundled).
    const appConfig = await buildAppConfig(lib.prebuiltAppConfig);

    this.progressTarget = id;
    this.set(id, { status: "downloading", progress: 0, detail: "Starting background download…" });
    const t0 = performance.now();

    const onProgress = (p: any) => {
      const tid = this.progressTarget ?? id;
      const tst = this.states.get(tid);
      if (!tst) return;
      const prog = typeof p?.progress === "number" ? Math.min(1, Math.max(0, p.progress)) : 0;
      const phase = prog < 0.92 ? "downloading" : "loading";
      this.set(tid, {
        status: phase as PrecacheStatus,
        progress: prog,
        downloadedMB: Math.round(prog * tst.spec.sizeMB),
        detail: p?.text ?? (phase === "downloading" ? "Downloading weights…" : "Compiling on GPU…"),
      });
    };

    // If another model is resident, precache this one in a temp engine
    // then unload it — weights stay cached for instant future loads.
    const residentBusy = !!this.engine && this.activeId && this.activeId !== id;
    let engine: any;
    if (residentBusy) {
      try {
        engine = await CreateMLCEngine(id, { appConfig, initProgressCallback: onProgress });
      } catch (e) {
        const message = modelErrorMessage(e);
        this.set(id, { status: "error", progress: 0, detail: message });
        throw new Error(message);
      }
      try {
        await engine.unload?.();
      } catch {
        /* keep temp engine referenced so GC doesn't kill GPU buffers mid-flight */
        (this as any)._spare = engine;
      }
      this.set(id, { status: "queued", progress: 1, cached: true, downloadedMB: st.spec.sizeMB, detail: "Precached — loads instantly on demand" });
    } else {
      try {
        engine = await CreateMLCEngine(id, { appConfig, initProgressCallback: onProgress });
      } catch (e) {
        const message = modelErrorMessage(e);
        this.set(id, { status: "error", progress: 0, detail: message });
        throw new Error(message);
      }
      this.engine = engine;
      this.activeId = id;
      this.set(id, { status: "ready", progress: 1, cached: true, downloadedMB: st.spec.sizeMB, detail: `Ready in ${((performance.now() - t0) / 1000).toFixed(1)}s — AI helper online` });
    }
    this.persist(id);
  }

  /** Load a model for chat (used when user picks it as helper). */
  async ensureModel(id: string): Promise<void> {
    if (this.activeId === id && this.engine) return;
    // Switch the resident helper engine to the picked model.
    if (this.engine && typeof this.engine.reload === "function") {
      const st = this.states.get(id);
      this.progressTarget = id;
      if (st) this.set(id, { status: "loading", detail: "Switching helper model…" });
      const t0 = performance.now();
      try {
        await this.engine.reload(id);
      } catch (e) {
        const message = modelErrorMessage(e);
        if (st) this.set(id, { status: "error", detail: message });
        throw new Error(message);
      }
      this.activeId = id;
      if (st) {
        this.set(id, { status: "ready", progress: 1, cached: true, downloadedMB: st.spec.sizeMB, detail: `Ready in ${((performance.now() - t0) / 1000).toFixed(1)}s — AI helper online` });
        this.persist(id);
      }
      return;
    }
    await this.precacheModel(id, { keepResident: true });
  }

  cancel() {
    this.cancelled = true;
    this.queue = [];
  }

  resume(id?: string) {
    this.cancelled = false;
    const ids = id ? [id] : MODELS.map((m) => m.id);
    for (const mid of ids) {
      const st = this.states.get(mid);
      if (st && (st.status === "paused" || st.status === "error" || st.status === "idle" || (st.spec.tier === "strong" && st.status === "queued"))) {
        this.set(mid, { status: "queued", detail: "Queued for background download" });
        if (!this.queue.includes(mid)) this.queue.push(mid);
      }
    }
    void this.pump();
  }

  /** True while any helper model is checking / downloading / loading / queued for download. */
  get isPrecaching(): boolean {
    return MODELS.some((m) => {
      const s = this.states.get(m.id)?.status;
      return s === "checking" || s === "downloading" || s === "loading" || (s === "queued" && this.queue.includes(m.id));
    }) || this.running;
  }

  /** Resolve when a helper model is ready; reject only if nothing is coming or the caller cancels. No timeout. */
  whenReady(opts: { signal?: AbortSignal; onProgress?: (p: number, text: string) => void } = {}): Promise<string> {
    if (this.readyModelId) return Promise.resolve(this.readyModelId);
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        unsub();
        opts.signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const check = () => {
        const id = this.readyModelId;
        if (id) return finish(() => resolve(id));
        if (!this.isPrecaching && !this.inflight.size) {
          return finish(() => reject(new Error("On-device model isn't downloading. Resume it in the AI Helper panel.")));
        }
        const active = MODELS.map((m) => this.states.get(m.id)!).find((s) => s.status === "downloading" || s.status === "loading");
        if (active) opts.onProgress?.(active.progress, `${active.spec.label}: ${Math.round(active.progress * 100)}% — ${active.status === "loading" ? "loading on GPU" : "downloading"}`);
      };
      const unsub = this.subscribe(check);
      const onAbort = () => finish(() => reject(new Error("Cancelled.")));
      opts.signal?.addEventListener("abort", onAbort);
      if (!this.webgpu) return finish(() => reject(new Error("WebGPU is not available on this device.")));
      if (!this.isPrecaching && !this.inflight.size) this.resume();
      check();
    });
  }

  /* ── chat ── */
  async chat(messages: ChatMsg[], onToken?: (t: string) => void, maxTokens = 512, temperature = 0.7): Promise<string> {
    if (!this.engine || !this.activeId) throw new Error("On-device model is still downloading. Use Puter / OpenRouter for now.");
    const engine = this.engine;
    const stream = await engine.chat.completions.create({
      messages,
      stream: true,
      temperature,
      max_tokens: maxTokens,
    });
    let full = "";
    for await (const chunk of stream) {
      const delta = chunk?.choices?.[0]?.delta?.content ?? chunk?.choices?.[0]?.message?.content ?? "";
      if (delta) {
        full += delta;
        onToken?.(delta);
      }
    }
    if (!full) {
      // Non-stream fallback shape
      const res = await engine.chat.completions.create({ messages, temperature: 0.7, max_tokens: maxTokens });
      full = res?.choices?.[0]?.message?.content ?? "";
      if (full) onToken?.(full);
    }
    return full;
  }

  async storageEstimate(): Promise<{ usageMB: number; quotaMB: number } | null> {
    try {
      const est = await (navigator as any).storage?.estimate?.();
      if (!est) return null;
      return {
        usageMB: Math.round((est.usage ?? 0) / 1048576),
        quotaMB: Math.round((est.quota ?? 0) / 1048576),
      };
    } catch {
      return null;
    }
  }
}

export const webllm = new WebLLMManager();
