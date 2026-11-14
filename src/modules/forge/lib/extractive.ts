import type { Question } from "./types";
import type { Knowledge, KnowledgeSource } from "./knowledge";

/* ─────────────────────────────────────────────────────────────
   Extractive question builder — ZERO hallucination, ~1 ms per question.
   No language model is involved. Every question is a sentence lifted
   verbatim from a fetched source with one fact (year / quantity /
   named entity / the article subject) blanked out. The correct answer
   is the exact text that was removed, so it is provably in the source.
   Distractors are built from the same corpus (other real years, real
   entities, other real article titles) so they are plausible but wrong.
   ───────────────────────────────────────────────────────────── */

const ABBR = ["Mr", "Mrs", "Ms", "Dr", "Prof", "Sr", "Jr", "St", "Mt", "No", "vs", "etc", "e.g", "i.e", "U.S", "U.K", "U.N", "c", "ca", "approx", "Inc", "Ltd", "Co", "Gen", "Col", "Lt", "Capt", "Rev", "Hon", "Fr", "Gov", "Sen", "Rep"];
const CONNECT = new Set(["of", "the", "de", "da", "von", "van", "and", "du", "la", "le", "del", "di", "al", "bin", "ibn", "y", "e"]);
const MONTHS = new Set(["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]);
const BAD_START = new Set([
  "The", "It", "In", "On", "At", "By", "For", "From", "With", "This", "That", "These", "Those", "He", "She", "They", "We", "His", "Her", "Its", "Their", "A", "An", "As", "After", "Before", "During", "However", "Although", "Many", "Most", "Some", "Other", "Since", "While", "When", "Where", "Which", "Who", "Today", "Both", "Each", "Several", "There", "Here", "Over", "Under", "Between", "Among", "Despite", "Because", "Unlike", "Like", "Within", "Without", "Through", "Its", "Such", "One", "Two", "Three", "Four", "Five", "First", "Second", "Third", "New", "Modern", "Early", "Late", "Later", "Also", "Then", "Thus", "Among", "According",
]);

const UNIT_RE = "(million|billion|trillion|thousand|percent|%|km|kilometres|kilometers|miles|mi|metres|meters|m|feet|ft|square kilometres|square kilometers|square miles|km2|km²|years|species|people|inhabitants|countries|members|episodes|languages|tonnes|tons|kg|kilograms|pounds|lb|°C|°F|mph|km/h|hours|minutes|seconds|days|weeks|months|centuries|seasons|games|matches|goals|points|albums|films|books|volumes|chapters|players|teams|nations|states|provinces|islands|moons|planets|light-years|kilometres per second|km/s)";

export function splitSentences(text: string): string[] {
  let t = text.replace(/\s+/g, " ").trim();
  for (const a of ABBR) t = t.replace(new RegExp(`\\b${a.replace(/\./g, "\\.")}\\.`, "g"), `${a.replace(/\./g, "§")}§`);
  t = t.replace(/(\d)\.(\d)/g, "$1§$2");
  const parts = t.split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/);
  return parts
    .map((s) => s.replace(/§/g, ".").replace(/\(\s*[;,:]\s*/g, "(").replace(/\(\s*\)/g, "").replace(/\s{2,}/g, " ").trim())
    .filter((s) => s.length >= 45 && s.length <= 240 && /[.!?]$/.test(s) && !/may refer to|:$|^[a-z]|\[|\]/.test(s) && s.split(" ").length >= 8);
}

interface Entity {
  text: string;
  words: number;
}

function entitiesIn(sentence: string): Entity[] {
  const tokens = sentence.split(" ");
  const out: Entity[] = [];
  let i = 0;
  while (i < tokens.length) {
    const core = tokens[i].replace(/^[("“']+|[)"”',.;:!?]+$/g, "");
    if (/^[A-Z][A-Za-z'’\-]+$/.test(core) && !MONTHS.has(core)) {
      const span = [core];
      let j = i + 1;
      while (j < tokens.length) {
        const nxt = tokens[j].replace(/^[("“']+|[)"”',.;:!?]+$/g, "");
        const ended = /[.;:!?]$/.test(tokens[j - 1]);
        if (ended) break;
        if (/^[A-Z][A-Za-z'’\-]+$/.test(nxt) && !MONTHS.has(nxt)) {
          span.push(nxt);
          j++;
        } else if (CONNECT.has(nxt) && j + 1 < tokens.length && /^[A-Z]/.test(tokens[j + 1].replace(/^[("“']+/, ""))) {
          span.push(nxt);
          j++;
        } else break;
      }
      // trim trailing connector
      while (span.length && CONNECT.has(span[span.length - 1])) span.pop();
      // strip bad leading words
      while (span.length && BAD_START.has(span[0])) span.shift();
      const text = span.join(" ");
      const sentenceStart = i === 0;
      const noisy = span.length === 1 && (/['’]s$/.test(text) || /ly$/.test(text) || text.length < 4);
      if (text && !noisy && !(sentenceStart && span.length === 1) && text.length >= 3 && text.length <= 40 && !/^\d/.test(text)) {
        out.push({ text, words: span.length });
      }
      i = Math.max(j, i + 1);
    } else i++;
  }
  return out;
}

function esc(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function blank(sentence: string, answer: string): string {
  return sentence.replace(new RegExp(`\\b${esc(answer)}\\b`, "g"), "______");
}

function fmtNumber(orig: string, factor: number): string {
  const hasComma = orig.includes(",");
  const dec = (orig.split(".")[1] ?? "").length;
  const n = parseFloat(orig.replace(/,/g, "")) * factor;
  let out: string;
  if (dec > 0) out = n.toFixed(dec);
  else out = String(Math.round(n));
  if (hasComma || (dec === 0 && n >= 10000)) out = Number(out).toLocaleString("en-US");
  return out;
}

function shuffle<T>(a: T[]): T[] {
  return [...a].sort(() => Math.random() - 0.5);
}

function normalizeFact(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
}

function titleVariants(title: string): string[] {
  const base = title.replace(/\s*\([^)]*\)\s*$/, "").trim();
  const v = new Set<string>([title, base]);
  if (base.startsWith("The ")) v.add(base.slice(4));
  return [...v].filter(Boolean).sort((a, b) => b.length - a.length);
}

type Candidate = { kind: "title" | "year" | "number" | "entity"; sentence: string; answer: string; options: string[]; src: KnowledgeSource; weight: number };

function makeQuestion(c: Candidate, category: string, difficulty: string, topic: string): Question {
  const opts = shuffle(c.options);
  const cleanTitle = c.src.title.replace(/\s*\([^)]*\)\s*$/, "");
  const about = cleanTitle;
  const head =
    c.kind === "title"
      ? `In ${topic}, which of these is being described?`
      : c.kind === "year"
        ? `Which year completes this fact about ${about}?`
        : c.kind === "number"
          ? `Which figure completes this fact about ${about}?`
          : `Which name completes this fact about ${about}?`;
  const body = c.kind === "title" ? titleVariants(c.src.title).reduce((s, v) => s.replace(new RegExp(esc(v), "gi"), "______"), c.sentence) : blank(c.sentence, c.answer);
  return {
    q: `${head}\n“${body}”`,
    options: opts,
    answer: opts.indexOf(c.answer),
    explanation: `${c.src.title}: ${c.sentence}`,
    category,
    difficulty,
    verified: true,
    sourceTitle: c.src.title,
    sourceUrl: c.src.url,
    sourceSentence: c.sentence,
  };
}

/** Build up to `count` verified questions from fetched knowledge. Synchronous and fast. */
export function buildExtractiveQuestions(
  k: Knowledge,
  category: string,
  difficulty: string,
  count: number,
  excludedFacts: string[] = []
): Question[] {
  const sources = k.sources.filter((s) => s.extract);
  if (!sources.length) return [];
  const topic = category.trim();
  // Sources were chosen as the subject's own sub-topics, so all are on-topic for "described" questions.
  const srcOnTopic = (_t: string) => true;
  const thisYear = new Date().getFullYear();
  const hard = difficulty === "hard" || difficulty === "expert";
  const easy = difficulty === "easy";

  // Corpus-wide pools for distractors
  const sentencesBySrc = sources.map((s) => ({ src: s, sentences: splitSentences(s.extract) }));
  const entityPool = new Map<string, number>(); // text -> words
  const titleTokens = new Set(sources.flatMap((s) => titleVariants(s.title).flatMap((v) => v.toLowerCase().split(/\s+/))));
  for (const { sentences } of sentencesBySrc) for (const sen of sentences) for (const e of entitiesIn(sen)) entityPool.set(e.text, e.words);
  const relatedTitles = Array.from(new Set(sources.map((s) => s.title.replace(/\s*\([^)]*\)\s*$/, ""))));
  const maxTitleQs = easy ? Math.ceil(count * 0.4) : hard ? 1 : Math.ceil(count * 0.25);

  const perSrc: Candidate[][] = sentencesBySrc.map(({ src, sentences }) => {
    const cands: Candidate[] = [];
    const vars = titleVariants(src.title);
    const srcTitleWords = new Set(vars.flatMap((v) => v.toLowerCase().split(/\s+/)));
    sentences.forEach((sen, si) => {
      // 1) Subject identification (intro sentence mentions the title) — only for sources clearly on-topic
      if (si < 3 && srcOnTopic(src.title) && vars.some((v) => new RegExp(`\\b${esc(v)}\\b`, "i").test(sen))) {
        const ans0 = vars[vars.length - 1].toLowerCase();
        const ok = (t: string) => t.toLowerCase() !== ans0 && !sen.toLowerCase().includes(t.toLowerCase()) && !ans0.includes(t.toLowerCase());
        // Prefer related articles from the same fetch (plausible), top up with seed titles.
        const others = shuffle(relatedTitles.filter(ok)).slice(0, 3);
        if (others.length === 3) {
          const ans = vars[vars.length - 1];
          cands.push({ kind: "title", sentence: sen, answer: ans, options: [ans, ...others], src, weight: easy ? 5 : hard ? 1 : 3 });
        }
      }
      // 2) Year
      const years = Array.from(sen.matchAll(/\b(1[0-9]{3}|20[0-2][0-9])\b/g)).map((m) => m[1]);
      if (years.length) {
        const y = parseInt(years[0], 10);
        const used = new Set(years);
        const spread = easy ? [5, 60] : hard ? [1, 9] : [2, 25];
        const opts = new Set<string>();
        let guard = 0;
        while (opts.size < 3 && guard++ < 60) {
          const k2 = spread[0] + Math.floor(Math.random() * (spread[1] - spread[0] + 1));
          const cand = Math.random() < 0.5 ? y - k2 : y + k2;
          if (cand > 0 && cand <= thisYear + 2 && !used.has(String(cand))) opts.add(String(cand));
        }
        if (opts.size === 3) cands.push({ kind: "year", sentence: sen, answer: years[0], options: [years[0], ...opts], src, weight: easy ? 4 : 3 });
      }
      // 3) Quantity with unit
      const num = sen.match(new RegExp(`\\b(\\d{1,3}(?:,\\d{3})+|\\d+(?:\\.\\d+)?)\\s?${UNIT_RE}\\b`, "i"));
      if (num && !/^(1[0-9]{3}|20[0-2][0-9])$/.test(num[1])) {
        const raw = num[1];
        const factors = hard ? [0.8, 1.25, 1.5, 0.6, 2] : [0.5, 2, 3, 0.25, 1.5];
        const opts = new Set<string>();
        for (const f of shuffle(factors)) {
          const v = fmtNumber(raw, f);
          if (v !== raw && v !== "0") opts.add(v);
          if (opts.size === 3) break;
        }
        if (opts.size === 3) cands.push({ kind: "number", sentence: sen, answer: raw, options: [raw, ...opts], src, weight: hard ? 4 : 2 });
      }
      // 4) Named entity
      const ents = entitiesIn(sen).filter((e) => !e.text.toLowerCase().split(/\s+/).some((w) => srcTitleWords.has(w) || titleTokens.has(w)));
      for (const e of shuffle(ents).slice(0, 2)) {
        const pool = shuffle(
          Array.from(entityPool.entries())
            .filter(([t, w]) => t !== e.text && Math.abs(w - e.words) <= 1 && !sen.toLowerCase().includes(t.toLowerCase()) && !t.toLowerCase().includes(e.text.toLowerCase()) && !e.text.toLowerCase().includes(t.toLowerCase()))
            .map(([t]) => t)
        );
        const opts = pool.slice(0, 3);
        if (opts.length === 3) {
          cands.push({ kind: "entity", sentence: sen, answer: e.text, options: [e.text, ...opts], src, weight: hard ? 5 : 2 });
          break;
        }
      }
    });
    return cands;
  });

  // Pick: round-robin across sources, highest weight first, one question per sentence, no repeated answers, ≤1 "title" per source.
  const out: Question[] = [];
  const usedSentences = new Set<string>();
  const usedAnswers = new Set<string>();
  const titleUsed = new Set<string>();
  const excluded = new Set(excludedFacts);
  let titleCount = 0;
  const queues = perSrc.map((c) => shuffle(c).sort((a, b) => b.weight - a.weight));
  // Main article (first source) is the user's actual subject → it gets two picks per round.
  const order = queues.length > 1 ? [queues[0], ...queues.slice(1), queues[0]] : queues;
  let progress = true;
  while (out.length < count && progress) {
    progress = false;
    for (const q of order) {
      while (q.length) {
        const c = q.shift()!;
        const factKey = `${c.src.title}|${normalizeFact(c.sentence)}`;
        if (excluded.has(factKey)) continue;
        if (usedSentences.has(c.sentence) || usedAnswers.has(c.answer.toLowerCase())) continue;
        if (c.kind === "title" && (titleUsed.has(c.src.title) || titleCount >= maxTitleQs)) continue;
        usedSentences.add(c.sentence);
        usedAnswers.add(c.answer.toLowerCase());
        if (c.kind === "title") {
          titleUsed.add(c.src.title);
          titleCount++;
        }
        out.push(makeQuestion(c, category, difficulty, topic));
        progress = true;
        break;
      }
      if (out.length >= count) break;
    }
  }
  return out;
}
