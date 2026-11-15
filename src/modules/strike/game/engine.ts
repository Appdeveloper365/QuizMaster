import { QUESTIONS } from "../data/questions";
import { BLITZ_LEVEL, GAUNTLET_LEVEL } from "../data/levels";
import type { Difficulty, GameMode, GameSession, Level, Question } from "../types";

export function shuffle<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function buildDeck(level: Level, mode: GameMode, recent: string[] = []): Question[] {
  let pool = QUESTIONS.filter((q) => level.categories.some((category) => category === q.category));
  if (mode === "campaign") {
    const suited = pool.filter((q) => q.difficulty <= level.difficulty);
    if (suited.length >= level.rounds) pool = suited;
  }
  const fresh = shuffle(pool.filter((q) => !recent.includes(q.id)));
  const familiar = shuffle(pool.filter((q) => recent.includes(q.id)));
  const deck = [...fresh, ...familiar];
  if (mode === "gauntlet") {
    return [1, 2, 3].flatMap((difficulty) => shuffle(deck.filter((q) => q.difficulty === difficulty)));
  }
  if (deck.length < level.rounds) {
    return [...deck, ...shuffle(pool)].slice(0, Math.max(level.rounds, deck.length));
  }
  return deck;
}

export function createSession(mode: GameMode, selectedLevel: Level, recent: string[] = []): GameSession {
  const level = mode === "blitz" ? BLITZ_LEVEL : mode === "gauntlet" ? GAUNTLET_LEVEL : selectedLevel;
  const deck = buildDeck(level, mode, recent);
  return createSessionFromDeck(mode, level, deck);
}

function createSessionFromDeck(mode: GameMode, level: Level, deck: Question[]): GameSession {
  const combat = mode === "campaign";
  const timed = mode === "blitz";
  return {
    mode,
    level,
    deck,
    questionIndex: 0,
    optionOrder: shuffle([0, 1, 2, 3]),
    eliminated: [],
    selected: null,
    wasCorrect: null,
    status: "playing",
    score: 0,
    combo: 0,
    bestCombo: 0,
    hearts: level.hearts,
    maxHearts: level.hearts,
    enemyHp: combat ? level.requiredHits : 0,
    enemyMaxHp: combat ? level.requiredHits : 0,
    phase: 1,
    focus: 3,
    powerups: { fifty: 2, overdrive: 1, shield: 1 },
    shieldArmed: false,
    overdriveArmed: false,
    armor: level.kind === "warden" ? 1 : 0,
    timed,
    timeLeft: timed ? level.seconds : 0,
    timeTotal: timed ? level.seconds : 0,
    elapsed: 0,
    specialUsed: false,
    consecutiveMisses: 0,
    correctCount: 0,
    answeredCount: 0,
    hintsUsed: 0,
    event: mode === "campaign"
      ? `${level.enemyName} entered the arena`
      : mode === "custom"
        ? "Endless run · each question is researched live from the internet"
        : timed
          ? "Sixty-second sprint · questions never expire individually"
          : "Take your time · questions never expire",
    eventType: "neutral",
    awaitingQuestion: false,
    startedAt: Date.now(),
  };
}

export function createCustomSession(subject: string, questions: Question[], difficulty: Difficulty): GameSession {
  const sources = questions[0]?.sources;
  const level: Level = {
    id: 100,
    name: subject,
    realm: sources?.length ? "Internet-Grounded Forge" : "Question Forge",
    description: `An AI-generated ${questions.length}-question trial about ${subject}.`,
    enemyName: "The Curator",
    enemyTitle: sources?.length ? `Grounded in ${sources[0].title}` : "Custom subject sentinel",
    kind: "drone",
    categories: [],
    difficulty,
    rounds: questions.length,
    requiredHits: 0,
    hearts: 3,
    seconds: 0,
    rewardXp: 60 + questions.length * 12,
    accent: "#8df4ff",
    sources,
  };
  return createSessionFromDeck("custom", level, questions);
}

function phaseFor(session: GameSession, hp: number) {
  if (!session.level.boss || session.enemyMaxHp === 0) return 1;
  const ratio = hp / session.enemyMaxHp;
  return ratio <= 0.34 ? 3 : ratio <= 0.67 ? 2 : 1;
}

export function currentQuestion(session: GameSession): Question {
  return session.deck[Math.min(session.questionIndex, session.deck.length - 1)];
}

export function applyAnswer(session: GameSession, option: number): GameSession {
  if (session.status !== "playing") return session;
  const question = currentQuestion(session);
  const correct = option === question.answer;
  const combat = session.mode === "campaign";
  let next: GameSession = {
    ...session,
    selected: option,
    wasCorrect: correct,
    status: "feedback",
    answeredCount: session.answeredCount + 1,
    correctCount: session.correctCount + (correct ? 1 : 0),
    event: correct ? "Direct hit" : "The enemy countered",
    eventType: correct ? "good" : "bad",
  };

  if (correct) {
    const combo = session.combo + 1;
    const basePoints = 120 + question.difficulty * 35 + (session.mode === "blitz" ? 50 : 0);
    const streakFactor = 1 + Math.min(combo - 1, 6) * 0.14;
    const overdriveFactor = session.overdriveArmed ? (combat ? 1.5 : 2) : 1;
    let gained = Math.round(basePoints * streakFactor * overdriveFactor);
    let hp = session.enemyHp;
    let armor = session.armor;
    let event = session.overdriveArmed
      ? `Overdrive strike! · +${gained.toLocaleString()} pts`
      : `Direct hit · +${gained.toLocaleString()} pts`;

    if (combat) {
      if (armor > 0) {
        if (session.overdriveArmed) {
          armor = 0;
          hp = Math.max(0, hp - 1);
          event = `Overdrive shattered Aegis & hit core · +${gained.toLocaleString()} pts`;
        } else {
          armor -= 1;
          gained = Math.round(gained / 2);
          event = `Aegis absorbed the hit · +${gained.toLocaleString()} pts`;
        }
      } else {
        const damage = session.overdriveArmed ? 2 : 1;
        hp = Math.max(0, hp - damage);
      }
    }

    const phase = phaseFor(session, hp);
    let phaseArmor = armor;
    if (phase > session.phase && session.level.kind === "warden") {
      phaseArmor = 1;
      event = `Phase ${phase} · Prism Aegis restored`;
    } else if (phase > session.phase && session.level.kind === "oracle") {
      if (phase === 3) phaseArmor = 1;
      event = phase === 3 ? "Phase 3 · Oracle raised an Aegis" : `Phase ${phase} · The Oracle shifts reality`;
    }

    next = {
      ...next,
      combo,
      bestCombo: Math.max(session.bestCombo, combo),
      score: session.score + gained,
      enemyHp: hp,
      armor: phaseArmor,
      phase,
      overdriveArmed: false,
      consecutiveMisses: 0,
      focus: Math.min(3, session.focus + (next.correctCount > 0 && next.correctCount % 4 === 0 ? 1 : 0)),
      event,
      eventType: "good",
    };
  } else {
    let hearts = session.hearts;
    let shieldArmed = session.shieldArmed;
    let blocked = false;
    const overcharged = session.level.kind === "leech" && session.mode === "campaign" && session.questionIndex % 2 === 1;
    if (shieldArmed) {
      shieldArmed = false;
      blocked = true;
      next.event = overcharged ? "Shield absorbed the overcharged strike" : "Shield absorbed the counterattack";
    } else if (session.mode !== "blitz" && session.mode !== "custom") {
      const damage = overcharged ? 2 : 1;
      hearts = Math.max(0, hearts - damage);
      if (overcharged) next.event = "Iron Sentinel landed an overcharged strike (−2 shields)";
    }
    let enemyHp = session.enemyHp;
    let misses = session.consecutiveMisses + 1;
    if (session.level.kind === "hydra" && session.mode === "campaign") {
      if (misses >= 2) {
        enemyHp = Math.min(session.enemyMaxHp, enemyHp + 1);
        misses = 0;
        next.event = "Hydra regenerated 1 core segment";
      } else {
        next.event = "Hydra is charging regeneration · one more miss";
      }
    }
    next = {
      ...next,
      combo: 0,
      hearts,
      shieldArmed,
      overdriveArmed: false,
      enemyHp,
      consecutiveMisses: misses,
      timeLeft: session.timed ? Math.max(0, session.timeLeft - (blocked ? 0 : 3)) : 0,
    };
  }
  return next;
}

export function advanceSession(session: GameSession): GameSession {
  if (session.status !== "feedback") return session;
  if (session.mode === "campaign" && session.enemyHp <= 0) return { ...session, status: "won", event: "Arena cleared" };
  if (session.mode !== "blitz" && session.hearts <= 0) return { ...session, status: "lost", event: "Your shields are down" };
  if (session.timed && session.timeLeft <= 0) return { ...session, status: "won", event: "Time!" };
  const nextIndex = session.questionIndex + 1;
  if (session.mode === "campaign" && nextIndex >= session.level.rounds) {
    return { ...session, status: "lost", event: "The enemy core survived" };
  }
  if (nextIndex >= session.deck.length) {
    if (session.mode === "custom") {
      return {
        ...session,
        questionIndex: nextIndex,
        optionOrder: shuffle([0, 1, 2, 3]),
        eliminated: [],
        selected: null,
        wasCorrect: null,
        status: "playing",
        elapsed: 0,
        overdriveArmed: false,
        specialUsed: false,
        awaitingQuestion: true,
        event: "Searching the live internet for your next question…",
        eventType: "neutral",
      };
    }
    return { ...session, status: "won", event: "Run complete" };
  }
  return {
    ...session,
    questionIndex: nextIndex,
    optionOrder: shuffle([0, 1, 2, 3]),
    eliminated: [],
    selected: null,
    wasCorrect: null,
    status: "playing",
    elapsed: 0,
    overdriveArmed: false,
    specialUsed: false,
    awaitingQuestion: false,
    event: session.phase > 1 ? `Phase ${session.phase} · stay sharp` : "Next question",
    eventType: "neutral",
  };
}

export function tickSession(session: GameSession, delta: number): GameSession {
  if (session.status !== "playing") return session;
  const elapsed = session.elapsed + delta;
  let next: GameSession = {
    ...session,
    elapsed,
    timeLeft: session.timed ? Math.max(0, session.timeLeft - delta) : 0,
  };

  if (session.mode === "campaign" && !session.specialUsed && elapsed >= 4.5) {
    if (session.level.kind === "scrambler") {
      next = {
        ...next,
        optionOrder: shuffle(session.optionOrder),
        specialUsed: true,
        event: "Scrambler shifted the answer positions",
        eventType: "bad",
      };
    } else if (session.level.kind === "oracle" && session.phase >= 2) {
      next = {
        ...next,
        optionOrder: shuffle(session.optionOrder),
        specialUsed: true,
        event: "The Oracle shifted the answer positions",
        eventType: "bad",
      };
    }
  }

  if (session.timed && next.timeLeft <= 0) {
    return { ...next, status: "won", event: "Time!" };
  }
  return next;
}

export function useFifty(session: GameSession): GameSession {
  if (session.status !== "playing" || session.powerups.fifty <= 0 || session.eliminated.length > 0) return session;
  const question = currentQuestion(session);
  const wrong = shuffle([0, 1, 2, 3].filter((index) => index !== question.answer)).slice(0, 2);
  return { ...session, eliminated: wrong, powerups: { ...session.powerups, fifty: session.powerups.fifty - 1 }, event: "Two false answers removed", eventType: "good" };
}

export function useOverdrive(session: GameSession): GameSession {
  if (session.status !== "playing" || session.powerups.overdrive <= 0 || session.overdriveArmed) return session;
  const combat = session.mode === "campaign";
  return {
    ...session,
    overdriveArmed: true,
    powerups: { ...session.powerups, overdrive: session.powerups.overdrive - 1 },
    event: combat ? "Overdrive armed · next hit deals 2× core damage & +50% points" : "Overdrive armed · next hit earns 2× points",
    eventType: "good",
  };
}

export function useShield(session: GameSession): GameSession {
  if (session.status !== "playing" || session.powerups.shield <= 0 || session.shieldArmed) return session;
  return { ...session, shieldArmed: true, powerups: { ...session.powerups, shield: session.powerups.shield - 1 }, event: "Shield armed for the next counterattack", eventType: "good" };
}

export function getIntent(session: GameSession): string {
  if (session.mode === "blitz") return "Optional 60s sprint · questions never expire · misses cost 3s";
  if (session.mode === "gauntlet") return `Untimed survival · ${session.hearts} shields remain · questions never expire`;
  if (session.mode === "custom") return session.awaitingQuestion ? "Fetching the next question from live internet sources…" : "Untimed endless run · the next question is auto-generated from the internet";
  switch (session.level.kind) {
    case "scrambler": return session.specialUsed ? "Answers shifted · counterattack on a miss" : "Telegraph: rearranges answer positions mid-thought";
    case "leech": return session.questionIndex % 2 === 1 ? "Telegraph: OVERCHARGED — a miss breaks 2 shields unless Shield is armed" : "Charging heavy strike · 1 shield damage on a miss";
    case "warden": return session.armor > 0 ? `Phase ${session.phase} · Aegis blocks 1 hit (Overdrive shatters it)` : `Phase ${session.phase} · core exposed`;
    case "hydra": return session.consecutiveMisses === 1 ? "Telegraph: one more miss restores 1 core segment" : "Regeneration charges after 2 consecutive misses";
    case "oracle": return session.phase === 3 ? "Phase 3 · Aegis protection & mid-thought answer shifts" : session.phase === 2 ? "Phase 2 · mid-thought answer shifts" : "Phase 1 · untimed final encounter";
    default: return "Untimed combat · counterattack on a miss (1 shield damage)";
  }
}
