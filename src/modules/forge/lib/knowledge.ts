/* Internet knowledge retrieval — fetches real, verifiable facts about the
   topic (Wikipedia API, CORS-enabled) and hands them to the LLM so questions
   are grounded in sourced content instead of a small model's memory. */

export interface KnowledgeSource {
  title: string;
  url: string;
  extract: string;
}

export interface Knowledge {
  topic: string;
  sources: KnowledgeSource[];
  context: string; // trimmed, ready to inject into the prompt
  keywords: Set<string>;
  online: boolean;
}

const WIKI = "https://en.wikipedia.org/w/api.php";

const STOP = new Set("about above after again against all also among and any are around because been before being below between both but can could did does doing down during each few from further had has have having here hers herself him himself his how into its itself just more most much must off once only other ought our ours ourselves out over own same shall she should some such than that the their theirs them themselves then there these they this those through under until very was were what when where which while whom whose will with would you your yours yourself yourselves which within without such while many several often known called used using include includes including first second third later early became become between".split(" "));

function pick<T>(arr: T[], n: number): T[] {
  return [...arr].sort(() => Math.random() - 0.5).slice(0, n);
}

export class RateLimitError extends Error {
  constructor() {
    super("Wikipedia is rate-limiting requests right now. Wait a few seconds and try again.");
    this.name = "RateLimitError";
  }
}

async function wikiGet(params: Record<string, string>, signal?: AbortSignal): Promise<any> {
  const qs = new URLSearchParams({ format: "json", origin: "*", formatversion: "2", maxlag: "5", ...params });
  const res = await fetch(`${WIKI}?${qs.toString()}`, { signal });
  if (res.status === 429) throw new RateLimitError();
  if (!res.ok) throw new Error(`Wikipedia ${res.status}`);
  const data = await res.json();
  if (data?.error?.code === "ratelimited" || data?.error?.code === "maxlag") throw new RateLimitError();
  return data;
}

async function searchTitles(query: string, limit: number, signal?: AbortSignal): Promise<string[]> {
  const data = await wikiGet({ action: "query", list: "search", srsearch: query, srlimit: String(limit + 2), srprop: "" }, signal);
  return (data?.query?.search ?? [])
    .map((s: any) => String(s.title))
    .filter((t: string) => !/\(disambiguation\)|^List of |^Index of /i.test(t))
    .slice(0, limit);
}

const SKIP_TITLE = /\(disambiguation\)|^List of |^Index of |^Outline of |^Glossary of |^Timeline of |^History of |^Category:|^Portal:|\(identifier\)|^Bibcode|^Doi|^ISBN|^ISSN|^PMID|^S2CID|^OCLC|^Wayback|^Internet Archive|^JSTOR|^ArXiv|^Help:|^Wikipedia:/i;
const GENERIC = new Set(["Academic discipline", "Science", "Natural science", "Scientific method", "Research", "Mathematics", "Nature", "Universe", "Knowledge", "Philosophy", "Theory", "Experiment", "Education", "Technology", "Society", "Culture", "World", "Human", "Matter", "Energy", "Time", "Space", "Earth", "United States", "English language", "Latin", "Ancient Greek", "Greek language", "Encyclopædia Britannica", "Oxford English Dictionary"]);

/** Concepts linked from the article's lead section = its core sub-topics. */
async function leadLinks(title: string, signal?: AbortSignal): Promise<string[]> {
  try {
    const d = await wikiGet({ action: "parse", page: title, prop: "links", section: "0", redirects: "1" }, signal);
    const links: any[] = d?.parse?.links ?? [];
    return links
      .filter((l) => l.ns === 0 && (l.exists === true || "exists" in l))
      .map((l) => String(l.title ?? l["*"]))
      .filter((t) => !SKIP_TITLE.test(t) && !GENERIC.has(t) && t.toLowerCase() !== title.toLowerCase());
  } catch {
    return [];
  }
}

/** Articles Wikipedia itself considers similar to the main one. */
async function moreLike(title: string, limit: number, signal?: AbortSignal): Promise<string[]> {
  try {
    const d = await wikiGet({ action: "query", list: "search", srsearch: `morelike:${title}`, srlimit: String(limit), srprop: "" }, signal);
    return (d?.query?.search ?? []).map((s: any) => String(s.title)).filter((t: string) => !SKIP_TITLE.test(t));
  } catch {
    return [];
  }
}

/** Full plain text of the main article (used to weigh how central each linked concept is). */
async function fullText(title: string, signal?: AbortSignal): Promise<string> {
  try {
    const d = await wikiGet({ action: "query", prop: "extracts", explaintext: "1", redirects: "1", titles: title, exlimit: "1" }, signal);
    const page: any = Array.isArray(d?.query?.pages) ? d.query.pages[0] : Object.values(d?.query?.pages ?? {})[0];
    return String(page?.extract ?? "");
  } catch {
    return "";
  }
}

const SUBTOPIC_BOOST = /\b(mechanics|dynamics|theory|physics|chemistry|biology|law|laws|principle|effect|equation|model|field|force|energy|wave|particle|system|process|structure|evolution|history|era|period|war|battle|empire|revolution|album|song|tour|film|series|championship|league|cup|award|style|genre|language|algorithm|method)\b/i;

/** Broad subject → a spread of its CORE sub-topics, re-sampled each round. Core = linked from the lead
    AND mentioned repeatedly throughout the article (peripheral trivia is mentioned once). */
export async function expandTopic(main: string, want: number, signal?: AbortSignal): Promise<string[]> {
  const [lead, similar, body] = await Promise.all([leadLinks(main, signal), moreLike(main, 12, signal), fullText(main, signal)]);
  const bodyLow = body.toLowerCase();
  const mainLow = main.toLowerCase();
  const seen = new Set<string>([mainLow]);
  const uniq = (arr: string[]) => arr.filter((t) => { const k = t.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });

  const scored = uniq(lead).map((t) => {
    const clean = t.replace(/\s*\([^)]*\)\s*$/, "").toLowerCase();
    let mentions = 0;
    if (clean.length >= 4) {
      let i = -1;
      while ((i = bodyLow.indexOf(clean, i + 1)) !== -1 && mentions < 50) mentions++;
    }
    let score = mentions;
    if (clean.includes(mainLow) || mainLow.includes(clean)) score += 2; // "Astrophysics" for physics
    if (SUBTOPIC_BOOST.test(t)) score += 1.5;
    if (/^[A-Z][a-z]+ [A-Z][a-z]+$/.test(t) && mentions <= 2) score -= 2; // likely a person's name mentioned once
    if (/^(\d{4}|[A-Z]{2,})$/.test(t)) score -= 3;
    return { t, score, mentions };
  });

  // Core pool: mentioned ≥2 times (or strong boost). Weighted random sample for variety between rounds.
  const core = scored.filter((x) => x.score >= 2).sort((a, b) => b.score - a.score);
  const pool = core.length >= want ? core : scored.filter((x) => x.score >= 1).sort((a, b) => b.score - a.score);
  const sample = weightedSample(pool.map((x) => ({ item: x.t, w: Math.max(0.5, x.score) })), Math.ceil(want * 0.7));

  const simU = uniq(similar).filter((t) => !sample.includes(t));
  const out = [...sample, ...pick(simU, want - sample.length)];
  if (out.length < want) out.push(...pick(pool.map((x) => x.t).filter((t) => !out.includes(t)), want - out.length));
  return out.slice(0, want);
}

function weightedSample<T>(items: Array<{ item: T; w: number }>, n: number): T[] {
  const pool = [...items];
  const out: T[] = [];
  while (pool.length && out.length < n) {
    const total = pool.reduce((a, x) => a + x.w, 0);
    let r = Math.random() * total;
    let idx = 0;
    for (; idx < pool.length; idx++) {
      r -= pool[idx].w;
      if (r <= 0) break;
    }
    out.push(pool[Math.min(idx, pool.length - 1)].item);
    pool.splice(Math.min(idx, pool.length - 1), 1);
  }
  return out;
}

async function fetchExtracts(titles: string[], perPageChars: number, signal?: AbortSignal): Promise<KnowledgeSource[]> {
  if (!titles.length) return [];
  // Full article bodies (no exintro): definition-only intros make every
  // question a "what is X" vocabulary question; full bodies give the model
  // mechanisms, types, processes and examples to probe instead.
  // The TextExtracts API only allows full-text (no exintro) for ONE page per
  // request, so each title gets its own parallel call.
  const responses = await Promise.allSettled(titles.map((title) =>
    wikiGet(
      { action: "query", prop: "extracts|info", inprop: "url", explaintext: "1", exsectionformat: "plain", redirects: "1", titles: title },
      signal
    )
  ));
  const pages = responses.flatMap((res) =>
    res.status === "fulfilled"
      ? (Array.isArray(res.value?.query?.pages) ? res.value.query.pages : Object.values(res.value?.query?.pages ?? {})) as any[]
      : []
  );
  return pages
    .filter((p) => p && p.extract && !p.missing && !/may refer to:|may also refer to/i.test(String(p.extract).slice(0, 200)))
    .map((p) => ({
      title: String(p.title),
      url: String(p.fullurl ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(String(p.title).replace(/ /g, "_"))}`),
      extract: cleanExtract(String(p.extract), perPageChars),
    }))
    .filter((s) => s.extract.length > 80);
}

function cleanExtract(text: string, max: number): string {
  let t = text.replace(/\s+/g, " ").replace(/\([^)]*\)/g, (m) => (m.length > 60 ? "" : m)).trim();
  if (t.length > max) {
    t = t.slice(0, max);
    const cut = t.lastIndexOf(". ");
    if (cut > max * 0.5) t = t.slice(0, cut + 1);
  }
  return t;
}

export function buildKeywords(text: string, topic: string): Set<string> {
  const kw = new Set<string>();
  for (const w of `${topic} ${text}`.toLowerCase().match(/[a-z][a-z0-9'-]{3,}/g) ?? []) {
    if (!STOP.has(w)) kw.add(w);
  }
  return kw;
}

/* ── cache: memory + localStorage so repeat topics resolve in ~1ms ── */
const memCache = new Map<string, { at: number; k: Knowledge }>();
const inflight = new Map<string, Promise<Knowledge>>();
const LS_KEY = "bf_knowledge_v2";
const TTL_CUSTOM = 3 * 60 * 1000; // re-search periodically so broad subjects get fresh related pages

function cacheKey(category: string) {
  return category.trim().toLowerCase();
}
function readLS(): Record<string, { at: number; k: Omit<Knowledge, "keywords"> }> {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? "{}");
  } catch {
    return {};
  }
}
function writeLS(key: string, k: Knowledge) {
  try {
    const all = readLS();
    all[key] = { at: Date.now(), k: { topic: k.topic, sources: k.sources, context: k.context, online: k.online } };
    const entries = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, 30);
    localStorage.setItem(LS_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* quota — ignore */
  }
}
function fromCache(category: string): Knowledge | null {
  const key = cacheKey(category);
  const ttl = TTL_CUSTOM;
  const m = memCache.get(key);
  if (m && Date.now() - m.at < ttl) return m.k;
  const ls = readLS()[key];
  if (ls && Date.now() - ls.at < ttl && ls.k.context) {
    const k: Knowledge = { ...ls.k, keywords: buildKeywords(ls.k.context, ls.k.topic) };
    memCache.set(key, { at: ls.at, k });
    return k;
  }
  return null;
}

/** Warm the cache in the background (e.g. while the user is still typing). */
export function prefetchKnowledge(category: string): void {
  if (!category.trim() || fromCache(category)) return;
  // The typed-input debounce and per-topic in-flight map prevent duplicate requests.
  void fetchKnowledge(category).catch(() => {});
}

/** Fetch grounded facts for a topic or built-in category (cached). */
export async function fetchKnowledge(
  category: string,
  opts: { maxChars?: number; articles?: number; signal?: AbortSignal; onStatus?: (s: string) => void } = {}
): Promise<Knowledge> {
  const cached = fromCache(category);
  if (cached) {
    opts.onStatus?.(`Using cached facts for “${cached.topic}”`);
    return cached;
  }
  const key = cacheKey(category);
  const running = inflight.get(key);
  if (running) {
    opts.onStatus?.(`Fetching facts for “${category}”…`);
    return running;
  }
  const task = fetchKnowledgeUncached(category, opts).then((k) => {
    if (k.context) {
      memCache.set(key, { at: Date.now(), k });
      writeLS(key, k);
    }
    return k;
  });
  inflight.set(key, task);
  try {
    return await task;
  } finally {
    inflight.delete(key);
  }
}

async function fetchKnowledgeUncached(
  category: string,
  opts: { maxChars?: number; articles?: number; signal?: AbortSignal; onStatus?: (s: string) => void } = {}
): Promise<Knowledge> {
  const maxChars = opts.maxChars ?? 14000;
  const articles = opts.articles ?? 7;
  const topic = category.trim();
  const empty: Knowledge = { topic, sources: [], context: "", keywords: new Set(), online: false };

  if (typeof navigator !== "undefined" && navigator.onLine === false) return empty;

  try {
    opts.onStatus?.(`Searching the internet for “${topic}”…`);
    let hits = await searchTitles(topic, 6, opts.signal);
    if (!hits.length) hits = await searchTitles(topic.replace(/[^\w\s]/g, " "), 6, opts.signal);
    if (!hits.length) return { ...empty, online: true };
    const main = hits[0];
    opts.onStatus?.(`Exploring “${main}” and its related topics…`);
    const related = await expandTopic(main, articles - 1, opts.signal);
    // Ambiguous single-word topics ("compound", "mercury") can resolve to one
    // narrow sense — pull the next best hits directly so other senses of the
    // topic are covered too.
    const singleWord = topic.split(/\s+/).length === 1;
    const direct = hits.slice(1, singleWord ? 4 : 3).filter((t) => !related.includes(t));
    const titles = [main, ...related, ...direct].slice(0, articles + 2);
    opts.onStatus?.(`Reading the main article and ${titles.length - 1} related pages…`);

    const perPage = Math.floor(maxChars / Math.max(1, Math.min(titles.length, articles)));
    let sources = await fetchExtracts(titles, perPage, opts.signal);
    sources.sort((a, b) => titles.indexOf(a.title) - titles.indexOf(b.title));
    sources = sources.filter((src, i) => i === 0 || !/\b(given name|surname|may refer to|disambiguation)\b/i.test(src.extract.slice(0, 160) + " " + src.title));
    sources = sources.slice(0, articles + 1);

    let context = "";
    for (const src of sources) {
      const block = `### ${src.title}\nSOURCE_URL: ${src.url}\n${src.extract}\n\n`;
      if (context.length + block.length > maxChars + 600) break;
      context += block;
    }
    return { topic, sources, context: context.trim(), keywords: buildKeywords(context, topic), online: true };
  } catch (e: any) {
    if (e?.name === "AbortError" || e?.name === "RateLimitError") throw e;
    return { ...empty, online: false };
  }
}

/** Does this question appear grounded in the fetched facts? */
export function isGrounded(k: Knowledge, text: string): boolean {
  if (!k.context) return true;
  const words = text.toLowerCase().match(/[a-z][a-z0-9'-]{3,}/g) ?? [];
  const topicWords = new Set((k.topic.toLowerCase().match(/[a-z][a-z0-9'-]{3,}/g) ?? []).filter((w) => !STOP.has(w)));
  let hits = 0;
  let topicHit = false;
  const seen = new Set<string>();
  for (const w of words) {
    if (seen.has(w) || STOP.has(w)) continue;
    seen.add(w);
    if (topicWords.has(w)) topicHit = true;
    if (k.keywords.has(w)) hits++;
  }
  return hits >= 3 || (topicHit && hits >= 1);
}
