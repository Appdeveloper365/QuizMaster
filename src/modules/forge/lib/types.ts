export type ProviderId = "webllm" | "puter" | "openrouter" | "offline";

export interface Question {
  q: string;
  options: string[];
  answer: number; // index into options
  explanation: string;
  category: string;
  difficulty: string;
  /** Set when the answer is a verbatim quote from a fetched source (zero-hallucination path). */
  verified?: boolean;
  sourceTitle?: string;
  sourceUrl?: string;
  sourceSentence?: string;
}

export interface PuterUser {
  username: string;
  uuid?: string;
  email?: string;
  profile_picture?: string;
  [k: string]: unknown;
}

export type PrecacheStatus =
  | "idle"
  | "checking"
  | "queued"
  | "downloading"
  | "loading"
  | "ready"
  | "error"
  | "unsupported"
  | "paused";

export interface ModelSpec {
  id: string; // WebLLM model_id
  label: string;
  family: string;
  sizeMB: number;
  tier: "primary" | "secondary" | "strong" | "pro";
  blurb: string;
}

export interface ModelState {
  spec: ModelSpec;
  status: PrecacheStatus;
  progress: number; // 0..1
  detail: string;
  cached: boolean;
  downloadedMB: number;
}

export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GameResult {
  id: string;
  category: string;
  difficulty: string;
  score: number;
  correct: number;
  total: number;
  date: number;
  bestStreak: number;
}

export interface QuestionHistoryEntry {
  id: string;
  topic: string;
  question: Question;
  generatedAt: number;
}

export interface Settings {
  provider: ProviderId;
  openrouterKey: string;
  openrouterModel: string;
  webllmModel: string;
  sound: boolean;
}
