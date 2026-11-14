/* Shared Puter.js integration — https://js.puter.com/v2/
 *
 * Auth:   puter.auth.signIn / signOut / isSignedIn / getUser
 * AI:     puter.ai.chat(prompt, { model })
 * KV:     puter.kv.set / get  (cloud backup, when signed in)
 *
 * This is the single source of truth for both modules (SageStrike + BrainForge).
 * The Window.puter ambient type is declared here so both modules share it.
 */

export interface PuterUser {
  username: string;
  uuid?: string;
  email?: string;
  profile_picture?: string;
  [key: string]: unknown;
}

export interface PuterAPI {
  auth: {
    isSignedIn: () => boolean;
    signIn: (options?: { attempt_temp_user_creation?: boolean }) => Promise<unknown>;
    signOut: () => Promise<void> | void;
    getUser: () => Promise<PuterUser | undefined | null>;
    getProfilePicture?: () => Promise<string | undefined | null>;
  };
  ai: {
    chat: (prompt: string, options?: { model?: string }) => Promise<unknown>;
  };
  kv?: {
    set?: (key: string, value: string) => Promise<unknown>;
    get?: (key: string) => Promise<string | null | undefined>;
  };
}

declare global {
  interface Window { puter?: PuterAPI; }
}

export function getPuter(): PuterAPI | null {
  if (typeof window === "undefined") return null;
  return window.puter ?? null;
}

export function puterAvailable(): boolean {
  return !!getPuter();
}

export function waitForPuter(timeoutMs = 6000): Promise<boolean> {
  if (getPuter()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (getPuter() || Date.now() - t0 > timeoutMs) {
        clearInterval(iv);
        resolve(!!getPuter());
      }
    }, 150);
  });
}

export function isSignedIn(): boolean {
  try {
    return !!getPuter()?.auth?.isSignedIn?.();
  } catch {
    return false;
  }
}

/** Resolve the Puter API once loaded, throwing if it never appears. */
export async function ensurePuter(timeoutMs = 5000): Promise<PuterAPI> {
  const ready = await waitForPuter(timeoutMs);
  if (!ready) {
    throw new Error("Puter.js could not be reached. Check your internet connection or popup/script blockers and retry.");
  }
  const puter = getPuter();
  if (!puter) throw new Error("Puter.js could not be reached. Check your internet connection or popup/script blockers and retry.");
  return puter;
}

/** BrainForge flow — sign in and return the full user object. */
export async function signInWithPuter(): Promise<PuterUser | null> {
  const p = getPuter();
  if (!p?.auth?.signIn) throw new Error("Puter.js not loaded yet. Check your connection and retry.");
  // Must be called from a user gesture (button click) — popup blockers require it.
  await p.auth.signIn({ attempt_temp_user_creation: false });
  return getUser();
}

/** SageStrike flow — sign in and return the display name. */
export async function signInToPuter(): Promise<string> {
  const puter = await ensurePuter();
  await puter.auth.signIn();
  const user = await puter.auth.getUser();
  return user?.username ?? "Puter player";
}

export async function signOutOfPuter(): Promise<void> {
  try {
    await getPuter()?.auth?.signOut?.();
  } catch {
    /* noop */
  }
}

/** Full user object (BrainForge). */
export async function getUser(): Promise<PuterUser | null> {
  try {
    const p = getPuter();
    if (!p?.auth?.getUser || !isSignedIn()) return null;
    const u = await p.auth.getUser();
    return (u ?? null) as PuterUser | null;
  } catch {
    return null;
  }
}

/** Display name (SageStrike). */
export async function getPuterUser(): Promise<string | null> {
  if (!isSignedIn()) return null;
  const user = await getUser();
  return user?.username ?? "Puter player";
}

export async function getProfilePicture(): Promise<string | null> {
  try {
    const p = getPuter();
    if (!p?.auth?.getProfilePicture || !isSignedIn()) return null;
    return (await p.auth.getProfilePicture()) ?? null;
  } catch {
    return null;
  }
}

/** Free cloud AI via the signed-in Puter account. */
export async function puterChat(prompt: string, model = "gpt-4o-mini"): Promise<string> {
  const p = getPuter();
  if (!p?.ai?.chat) throw new Error("Puter AI unavailable — sign in with Puter first.");
  const res: unknown = await p.ai.chat(prompt, { model });
  if (typeof res === "string") return res;
  if (res && typeof res === "object") {
    const candidate = res as { message?: { content?: unknown }; content?: unknown; text?: unknown };
    const content = candidate.message?.content ?? candidate.content ?? candidate.text;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map((part) => `${part}`).join("");
  }
  return JSON.stringify(res);
}

export async function kvSet(key: string, value: string): Promise<void> {
  try {
    await getPuter()?.kv?.set?.(key, value);
  } catch {
    /* offline — localStorage fallback handles it */
  }
}

export async function kvGet(key: string): Promise<string | null> {
  try {
    const v = await getPuter()?.kv?.get?.(key);
    return v ?? null;
  } catch {
    return null;
  }
}