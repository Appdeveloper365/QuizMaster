export type Category = "Science" | "History" | "Geography" | "Technology" | "Arts" | "Logic";
export type Difficulty = 1 | 2 | 3 | 4;

export interface SourceRef {
  title: string;
  url: string;
}

export interface Question {
  id: string;
  category: Category | "Custom";
  subject?: string;
  sources?: SourceRef[];
  difficulty: Difficulty;
  prompt: string;
  options: [string, string, string, string];
  answer: number;
  hint: string;
  explanation: string;
  /** Fingerprint of the fact being tested (subject + normalized correct answer) — used for dedup. */
  factKey?: string;
}

export type EnemyKind = "drone" | "scrambler" | "leech" | "warden" | "hydra" | "oracle";

export interface Level {
  id: number;
  name: string;
  realm: string;
  description: string;
  enemyName: string;
  enemyTitle: string;
  kind: EnemyKind;
  categories: Category[];
  difficulty: Difficulty;
  rounds: number;
  requiredHits: number;
  hearts: number;
  seconds: number;
  rewardXp: number;
  boss?: boolean;
  accent: string;
  sources?: SourceRef[];
}

export type GameMode = "campaign" | "blitz" | "gauntlet" | "custom";
export type GameStatus = "playing" | "feedback" | "won" | "lost";

export interface Powerups {
  fifty: number;
  overdrive: number;
  shield: number;
}

export interface GameSession {
  mode: GameMode;
  level: Level;
  deck: Question[];
  questionIndex: number;
  optionOrder: number[];
  eliminated: number[];
  selected: number | null;
  wasCorrect: boolean | null;
  status: GameStatus;
  score: number;
  combo: number;
  bestCombo: number;
  hearts: number;
  maxHearts: number;
  enemyHp: number;
  enemyMaxHp: number;
  phase: number;
  focus: number;
  powerups: Powerups;
  shieldArmed: boolean;
  overdriveArmed: boolean;
  armor: number;
  timed: boolean;
  timeLeft: number;
  timeTotal: number;
  elapsed: number;
  specialUsed: boolean;
  consecutiveMisses: number;
  correctCount: number;
  answeredCount: number;
  hintsUsed: number;
  event: string;
  eventType: "neutral" | "good" | "bad";
  awaitingQuestion: boolean;
  startedAt: number;
}

export interface LevelRecord {
  stars: number;
  bestScore: number;
}

export interface Profile {
  xp: number;
  unlockedLevel: number;
  completed: Record<string, LevelRecord>;
  games: number;
  totalCorrect: number;
  totalAnswered: number;
  bestCombo: number;
  bestBlitz: number;
  bestGauntlet: number;
  recentQuestions: string[];
}

export type AIProvider = "webllm" | "puter" | "openrouter" | "offline";
export type WebLLMStatus = "idle" | "loading" | "ready" | "error" | "unsupported";

export interface AISettings {
  provider: AIProvider;
  webllmModel: string;
  openRouterModel: string;
  autoPreload: boolean;
  rememberKey: boolean;
  modelCustomized: boolean;
  webllmDual: boolean;
}

export interface AIProgress {
  status: WebLLMStatus;
  progress: number;
  text: string;
  model: string;
}

export interface HintResult {
  text: string;
  source: string;
  isAI: boolean;
}

export interface QuestionHistoryItem {
  id: string;
  subject: string;
  prompt: string;
  options: [string, string, string, string];
  answer: number;
  explanation: string;
  sources?: SourceRef[];
  createdAt: number;
}
