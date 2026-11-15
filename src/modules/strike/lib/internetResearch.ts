/* Curated-source retrieval.
 *
 * Instead of "searching the entire internet", every subject is grounded in a
 * fixed pool of quality sources, each behind its own adapter:
 *
 *   • Wikipedia           — encyclopedia: the lead article in full, plus the
 *                           full bodies of the two next-best related articles.
 *   • Wiktionary          — dictionary that doubles as a science dictionary:
 *                           entries carry field labels like "(chemistry)",
 *                           "(physics)", "(medicine)".
 *   • Free Dictionary API — plain English definitions and synonyms (the
 *                           synonyms feed the subtopic rotation used for
 *                           question diversity).
 *   • REST Countries      — atlas/countries pool: capital, region, languages,
 *                           currencies, borders, area and population.
 *   • DuckDuckGo/Wikidata — last-resort fallback when every curated pool
 *                           comes up empty.
 *
 * All adapters run in parallel, self-filter by token overlap against the
 * subject (an irrelevant pool returns nothing rather than junk), and the
 * results are ranked by domain relevance, deduped, and packed into passages.
 */
export interface InternetSource {
  title: string;
  url: string;
  snippet: string;
  /** Which curated source produced this entry ("Wikipedia", "Wiktionary", …). */
  via?: string;
}

export interface ResearchPassage {
  title: string;
  url: string;
  text: string;
  via?: string;
}

export interface InternetResearch {
  subject: string;
  sources: InternetSource[];
  passages: ResearchPassage[];
  relatedTerms: string[];
  context: string;
}

interface WikiSearchPage {
  pageid: number;
  title: string;
  index?: number;
  extract?: string;
  fullurl?: string;
  description?: string;
}

interface WikiCategoryPage {
  categories?: Array<{ title: string }>;
}

interface WikiExtractPage {
  title?: string;
  extract?: string;
}

interface DictionaryEntry {
  word?: string;
  meanings?: Array<{
    partOfSpeech?: string;
    definitions?: Array<{ definition?: string; example?: string }>;
    synonyms?: Array<string | { name?: string }>;
  }>;
}

interface CountryRecord {
  cca3?: string;
  name?: { common?: string; official?: string; altSpellings?: string[] };
  capital?: string[];
  region?: string;
  subregion?: string;
  population?: number;
  area?: number;
  currencies?: Record<string, { name?: string }>;
  languages?: Record<string, string>;
  borders?: string[];
}

/** Internally shared result of one source adapter. */
interface SourceBundle {
  sources: InternetSource[];
  passages: ResearchPassage[];
  relatedTerms: string[];
}

const EMPTY_BUNDLE: SourceBundle = { sources: [], passages: [], relatedTerms: [] };

const researchCache = new Map<string, InternetResearch>();
const RESEARCH_CACHE_LIMIT = 40;

const STOP_SECTIONS = new Set([
  "see also",
  "references",
  "notes",
  "further reading",
  "external links",
  "bibliography",
  "sources",
  "works cited",
  "citations",
]);

function cleanWhitespace(text: string) {
  return text.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function isDisambiguation(title: string, extract: string) {
  const lowerTitle = title.toLocaleLowerCase();
  const head = extract.slice(0, 260).toLocaleLowerCase();
  return lowerTitle.includes("(disambiguation)") || /\bmay refer to\s*:/.test(head) || /\bcan refer to\s*:/.test(head);
}

function curateArticleBody(rawText: string, maxChars: number): string {
  const lines = rawText.replace(/\r/g, "").split("\n");
  const blocks: string[] = [];
  let currentHeading = "Overview";
  let currentParagraphs: string[] = [];

  const flush = () => {
    const joined = currentParagraphs.join(" ").replace(/\s+/g, " ").trim();
    if (joined.length >= 60) {
      blocks.push(currentHeading === "Overview" ? joined : `${currentHeading}: ${joined}`);
    }
    currentParagraphs = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const headingMatch = line.match(/^={2,4}\s*(.+?)\s*={2,4}$/);
    if (headingMatch) {
      flush();
      const heading = headingMatch[1].trim();
      if (STOP_SECTIONS.has(heading.toLocaleLowerCase())) break;
      currentHeading = heading;
      continue;
    }
    if (line.length >= 35) currentParagraphs.push(line);
  }
  flush();

  if (blocks.length === 0) return cleanWhitespace(rawText).slice(0, maxChars);

  let result = "";
  for (const block of blocks) {
    const candidate = result ? `${result}\n\n${block}` : block;
    if (candidate.length > maxChars) {
      if (!result) result = block.slice(0, maxChars);
      break;
    }
    result = candidate;
  }
  return result;
}

/* ── Domain detection ──────────────────────────────────────────────────── */

const GEOGRAPHY_HINTS = /\b(countr|capital|cities|city|continent|ocean|sea|river|mountain|desert|lake|island|volcano|border|atlas|geograph|climate|peninsula|strait|canyon|archipelago|plateau|glacier|monsoon|rainforest|savanna|tundra)\b/i;

function isGeographicSubject(subject: string): boolean {
  return GEOGRAPHY_HINTS.test(subject);
}

const WORDISH_SUBJECT = /^[A-Za-z][A-Za-z'’-]*( [A-Za-z][A-Za-z'’-]*)?$/;

/** True for 1–2 plain words that dictionaries can plausibly define. */
function isWordishSubject(subject: string): boolean {
  return WORDISH_SUBJECT.test(subject.trim());
}

/* ── Fuzzy country-name matching for the atlas pool ────────────────────── */

function foldDiacritics(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

function significantTokens(text: string): string[] {
  return foldDiacritics(text).toLocaleLowerCase().match(/[a-z]{4,}/g) ?? [];
}

/** Does the subject plausibly name this country (token overlap on its names)? */
function countryNameMatches(subject: string, country: CountryRecord): boolean {
  const names = [country.name?.common ?? "", country.name?.official ?? "", ...(country.name?.altSpellings ?? [])].filter(Boolean);
  const subjectTokens = new Set(significantTokens(subject));
  const folded = foldDiacritics(subject).toLocaleLowerCase().trim();
  for (const name of names) {
    if (subjectTokens.size > 0) {
      for (const token of significantTokens(name)) {
        if (subjectTokens.has(token)) return true;
      }
    }
    if (folded.length >= 3 && foldDiacritics(name).toLocaleLowerCase().split(/[ ,]+/).includes(folded)) return true;
  }
  return false;
}

/* ── Dictionary curation ───────────────────────────────────────────────── */

function curateDictionaryBody(rawText: string, maxChars: number): string {
  let text = rawText;
  const englishIndex = text.search(/^==\s*English\s*==$/m);
  if (englishIndex > 0) text = text.slice(englishIndex);

  const lines: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const headingMatch = line.match(/^={2,4}\s*(.+?)\s*={2,4}$/);
    if (headingMatch) {
      const heading = headingMatch[1].trim();
      if (/^(translations|derived terms|related terms|descendants|anagrams|see also|references|external links|further reading)$/i.test(heading)) break;
      lines.push(`${heading}:`);
      continue;
    }
    if (line.length >= 15) lines.push(line);
    if (lines.join(" ").length > maxChars) break;
  }

  const result = cleanWhitespace(lines.join(" "));
  return result.length > maxChars ? result.slice(0, maxChars) : result;
}

/* ── Sources ───────────────────────────────────────────────────────────── */

async function searchWikipedia(query: string, what?: "text"): Promise<WikiSearchPage[]> {
  const params = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrsearch: query,
    gsrlimit: "6",
    prop: "extracts|description|info",
    inprop: "url",
    explaintext: "1",
    exintro: "1",
    exchars: "1100",
    format: "json",
    origin: "*",
  });
  if (what) params.set("gsrwhat", what);

  const response = await fetch(`https://en.wikipedia.org/w/api.php?${params.toString()}`);
  if (!response.ok) throw new Error(`Wikipedia returned HTTP ${response.status}.`);
  const data = (await response.json()) as { query?: { pages?: Record<string, WikiSearchPage> } };
  const pages = Object.values(data.query?.pages ?? {});
  return pages
    .filter((page) => Boolean(page.extract?.trim()) && !isDisambiguation(page.title, page.extract ?? ""))
    .sort((a, b) => (a.index ?? 999) - (b.index ?? 999));
}

async function fetchFullWikipediaArticle(pageid: number): Promise<string> {
  const params = new URLSearchParams({
    action: "query",
    prop: "extracts",
    explaintext: "1",
    exsectionformat: "wiki",
    pageids: String(pageid),
    format: "json",
    origin: "*",
  });
  const response = await fetch(`https://en.wikipedia.org/w/api.php?${params.toString()}`);
  if (!response.ok) return "";
  const data = (await response.json()) as { query?: { pages?: Record<string, { extract?: string }> } };
  return data.query?.pages?.[String(pageid)]?.extract ?? "";
}

async function fetchWikipediaCategories(pageids: number[]): Promise<string[]> {
  if (pageids.length === 0) return [];
  const params = new URLSearchParams({
    action: "query",
    prop: "categories",
    cllimit: "60",
    clnamespace: "14",
    pageids: pageids.join("|"),
    format: "json",
    origin: "*",
  });
  try {
    const response = await fetch(`https://en.wikipedia.org/w/api.php?${params.toString()}`);
    if (!response.ok) return [];
    const data = (await response.json()) as { query?: { pages?: Record<string, WikiCategoryPage> } };
    const names = Object.values(data.query?.pages ?? {}).flatMap((page) => page.categories ?? []).map((category) => category.title.replace(/^Category:/i, "").trim());
    return [...new Set(names)].filter(Boolean);
  } catch {
    return [];
  }
}

function wikiUrl(title: string): string {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

/** Exact-title lookup used when search comes up empty or fails. The search
 *  generator can return nothing for perfectly valid subjects (e.g. "Solar
 *  System") or be temporarily rate-limited; a direct title query is far more
 *  reliable and still gives us the article's lead section. */
async function fetchWikipediaByTitle(title: string): Promise<WikiSearchPage | null> {
  const params = new URLSearchParams({
    action: "query",
    titles: title,
    prop: "extracts|description|info",
    inprop: "url",
    explaintext: "1",
    exintro: "1",
    exchars: "1100",
    format: "json",
    origin: "*",
  });
  try {
    const response = await fetch(`https://en.wikipedia.org/w/api.php?${params.toString()}`);
    if (!response.ok) return null;
    const data = (await response.json()) as { query?: { pages?: Record<string, WikiSearchPage> } };
    const page = Object.values(data.query?.pages ?? {}).find(
      (candidate) => Boolean(candidate.extract?.trim()) && !isDisambiguation(candidate.title, candidate.extract ?? "")
    );
    return page && typeof page.pageid === "number" ? page : null;
  } catch {
    return null;
  }
}

/** Encyclopedia pool: lead article in full + the two next-best articles in full. */
async function fetchWikipediaBundle(subject: string): Promise<SourceBundle> {
  let pages: WikiSearchPage[] = [];
  try {
    pages = await searchWikipedia(subject);
  } catch {
    pages = [];
  }
  if (pages.length === 0) {
    try {
      pages = await searchWikipedia(subject, "text");
    } catch {
      pages = [];
    }
  }
  if (pages.length === 0) {
    const direct = await fetchWikipediaByTitle(subject);
    if (direct) pages = [direct];
  }
  if (pages.length === 0) return EMPTY_BUNDLE;

  // Fetch the lead article plus the two secondary articles' full bodies in one
  // parallel sweep — full bodies give the model real breadth instead of three
  // rewordings of the same intro.
  const bodies = await Promise.allSettled(pages.slice(0, 3).map((page) => fetchFullWikipediaArticle(page.pageid)));
  const bodyFor = (index: number) => (bodies[index]?.status === "fulfilled" ? bodies[index].value : "");

  const sources: InternetSource[] = [];
  const passages: ResearchPassage[] = [];
  const relatedTerms: string[] = [];

  pages.slice(0, 3).forEach((page, index) => {
    const url = page.fullurl || wikiUrl(page.title);
    const makePassage = (): ResearchPassage | null => {
      const fullBody = bodyFor(index);
      if (index === 0) {
        const text = fullBody ? curateArticleBody(fullBody, 2300) : cleanWhitespace(page.extract ?? "");
        return text ? { title: page.title, url, text, via: "Wikipedia" } : null;
      }
      const text = fullBody ? curateArticleBody(fullBody, 1200) : cleanWhitespace(page.extract ?? "").slice(0, 900);
      return text ? { title: page.title, url, text, via: "Wikipedia" } : null;
    };
    const snippet = cleanWhitespace(page.extract ?? "").slice(0, 220);
    const passage = makePassage();
    if (passage) passages.push(passage);
    if (snippet) sources.push({ title: page.title, url, snippet, via: "Wikipedia" });
    relatedTerms.push(page.title);
  });

  const categories = await fetchWikipediaCategories(pages.slice(0, 2).map((page) => page.pageid));
  relatedTerms.push(...categories);

  return { sources, passages, relatedTerms };
}

/** Atlas/countries pool from REST Countries (capital, region, borders, …). */
async function fetchCountriesBundle(subject: string): Promise<SourceBundle> {
  const fields = "name,capital,region,subregion,population,area,currencies,languages,borders,cca3";
  const endpoints = [
    `https://restcountries.com/v3.1/name/${encodeURIComponent(subject)}?fields=${fields}`,
    ...(isGeographicSubject(subject)
      ? [`https://restcountries.com/v3.1/translation/${encodeURIComponent(subject)}?fields=${fields}`]
      : []),
  ];

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint);
      if (!response.ok) continue;
      const data = (await response.json()) as unknown;
      if (!Array.isArray(data)) continue;
      const matched = (data as CountryRecord[])
        .filter((country) => countryNameMatches(subject, country))
        .slice(0, 2);
      if (matched.length === 0) continue;

      const sources: InternetSource[] = [];
      const passages: ResearchPassage[] = [];
      const relatedTerms: string[] = [];

      for (const country of matched) {
        const common = country.name?.common?.trim();
        if (!common) continue;
        const official = country.name?.official?.trim() || common;
        const url = country.cca3 ? `https://restcountries.com/v3.1/alpha/${country.cca3}` : "https://restcountries.com";

        const facts: string[] = [];
        facts.push(`${official} — ${country.region ?? ""}${country.subregion ? ` (${country.subregion})` : ""} region.`);
        if (country.capital?.length) facts.push(`Capital: ${country.capital.join(", ")}.`);
        if (typeof country.population === "number") facts.push(`Population: ${country.population.toLocaleString("en-US")}.`);
        if (typeof country.area === "number") facts.push(`Area: ${country.area.toLocaleString("en-US")} km².`);
        const languages = Object.values(country.languages ?? {});
        if (languages.length) facts.push(`Languages: ${languages.join(", ")}.`);
        const currencies = Object.entries(country.currencies ?? {})
          .map(([code, currency]) => `${currency.name?.trim() || code}${currency.name?.trim() ? ` (${code})` : ""}`);
        if (currencies.length) facts.push(`Currency: ${currencies.join(", ")}.`);
        if (country.borders?.length) facts.push(`Borders: ${country.borders.join(", ")}.`);

        const text = facts.join(" ");
        passages.push({ title: `${common} — country & atlas facts`, url, text, via: "REST Countries" });
        sources.push({ title: `${common} — country & atlas facts`, url, snippet: text.slice(0, 220), via: "REST Countries" });
        relatedTerms.push(common, ...country.capital ?? [], country.region ?? "", country.subregion ?? "");
      }

      if (passages.length === 0) continue;
      return { sources, passages, relatedTerms: relatedTerms.filter(Boolean) };
    } catch { /* try the next endpoint */ }
  }
  return EMPTY_BUNDLE;
}

/** Dictionary pool: dictionaryapi.dev definitions + synonyms. */
async function fetchDictionaryBundle(subject: string): Promise<SourceBundle> {
  if (!isWordishSubject(subject)) return EMPTY_BUNDLE;
  try {
    const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(subject.trim())}`);
    if (!response.ok) return EMPTY_BUNDLE;
    const data = (await response.json()) as DictionaryEntry[];
    const entry = Array.isArray(data) ? data[0] : undefined;
    if (!entry?.word) return EMPTY_BUNDLE;

    const lines: string[] = [];
    const synonyms: string[] = [];
    for (const meaning of entry.meanings ?? []) {
      for (const definition of meaning.definitions ?? []) {
        if (!definition.definition?.trim() || lines.length >= 5) continue;
        const example = definition.example?.trim();
        lines.push(`(${meaning.partOfSpeech?.trim() || "usage"}) ${definition.definition.trim()}${example ? ` — e.g. “${example}”` : ""}`);
      }
      if (lines.length < 5) {
        for (const synonym of meaning.synonyms ?? []) {
          const name = typeof synonym === "string" ? synonym : synonym.name ?? "";
          if (name.trim()) synonyms.push(name.trim());
        }
      }
      if (lines.length >= 5 && synonyms.length >= 6) break;
    }

    if (lines.length === 0) return EMPTY_BUNDLE;
    const word = entry.word;
    const text = `Dictionary definition of “${word}”: ${lines.join(" ")}`.slice(0, 1100);
    const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`;
    return {
      sources: [{ title: `${word} — English dictionary`, url, snippet: text.slice(0, 220), via: "Free Dictionary" }],
      passages: [{ title: `${word} — English dictionary`, url, text, via: "Free Dictionary" }],
      relatedTerms: [...new Set(synonyms)].slice(0, 10),
    };
  } catch {
    return EMPTY_BUNDLE;
  }
}

/** Dictionary pool: Wiktionary — formal definitions that double as a science
 *  dictionary (entries carry field labels like "(chemistry)", "(physics)"). */
async function fetchWiktionaryBundle(subject: string): Promise<SourceBundle> {
  if (!isWordishSubject(subject)) return EMPTY_BUNDLE;
  try {
    const params = new URLSearchParams({
      action: "query",
      prop: "extracts",
      explaintext: "1",
      exsectionformat: "wiki",
      redirects: "1",
      titles: subject.trim(),
      format: "json",
      origin: "*",
    });
    const response = await fetch(`https://en.wiktionary.org/w/api.php?${params.toString()}`);
    if (!response.ok) return EMPTY_BUNDLE;
    const data = (await response.json()) as { query?: { pages?: Record<string, WikiExtractPage> } };
    const page = Object.values(data.query?.pages ?? {}).find((candidate) => candidate.extract?.trim());
    if (!page?.title) return EMPTY_BUNDLE;

    const text = curateDictionaryBody(page.extract ?? "", 1300);
    if (text.length < 60) return EMPTY_BUNDLE;
    const url = `https://en.wiktionary.org/wiki/${encodeURIComponent(page.title.replace(/ /g, "_"))}`;
    return {
      sources: [{ title: `${page.title} — Wiktionary`, url, snippet: text.slice(0, 220), via: "Wiktionary" }],
      passages: [{ title: `${page.title} — Wiktionary`, url, text, via: "Wiktionary" }],
      relatedTerms: [page.title],
    };
  } catch {
    return EMPTY_BUNDLE;
  }
}

/* ── Last-resort fallback (unchanged behavior) ─────────────────────────── */

async function fetchFallbackWebFacts(subject: string): Promise<InternetSource[]> {
  const sources: InternetSource[] = [];

  try {
    const ddgParams = new URLSearchParams({ q: subject, format: "json", no_html: "1", skip_disambig: "1" });
    const ddgRes = await fetch(`https://api.duckduckgo.com/?${ddgParams.toString()}`);
    if (ddgRes.ok) {
      const ddg = (await ddgRes.json()) as {
        Heading?: string;
        AbstractText?: string;
        AbstractURL?: string;
        RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
      };
      if (ddg.AbstractText?.trim()) {
        sources.push({
          title: ddg.Heading?.trim() || subject,
          url: ddg.AbstractURL?.trim() || wikiUrl(subject),
          snippet: ddg.AbstractText.trim(),
          via: "DuckDuckGo",
        });
      }
      const related = (ddg.RelatedTopics ?? [])
        .map((item) => item.Text?.trim())
        .filter((text): text is string => Boolean(text && text.length > 25))
        .slice(0, 4);
      if (related.length > 0) {
        sources.push({
          title: `${subject} — Related facts`,
          url: ddg.AbstractURL?.trim() || `https://duckduckgo.com/?q=${encodeURIComponent(subject)}`,
          snippet: related.join(" "),
          via: "DuckDuckGo",
        });
      }
    }
  } catch { /* try Wikidata next */ }

  if (sources.length === 0) {
    try {
      const wdParams = new URLSearchParams({ action: "wbsearchentities", search: subject, language: "en", limit: "5", format: "json", origin: "*" });
      const wdRes = await fetch(`https://www.wikidata.org/w/api.php?${wdParams.toString()}`);
      if (wdRes.ok) {
        const wd = (await wdRes.json()) as { search?: Array<{ label?: string; description?: string; concepturi?: string }> };
        const items = (wd.search ?? []).filter((entry) => entry.label && entry.description);
        if (items.length > 0) {
          sources.push({
            title: items[0].label!,
            url: items[0].concepturi || `https://www.wikidata.org/wiki/Special:Search?search=${encodeURIComponent(subject)}`,
            snippet: items.map((entry) => `${entry.label}: ${entry.description}.`).join(" "),
            via: "Wikidata",
          });
        }
      }
    } catch { /* handled by caller if empty */ }
  }

  return sources;
}

/* ── Orchestrator ──────────────────────────────────────────────────────── */

function pushUnique<T>(list: T[], items: T[], keyOf: (item: T) => string): void {
  const seen = new Set(list.map(keyOf));
  for (const item of items) {
    const key = keyOf(item);
    if (!seen.has(key)) {
      seen.add(key);
      list.push(item);
    }
  }
}

export async function fetchInternetResearch(subject: string): Promise<InternetResearch> {
  const trimmed = subject.trim();
  const cacheKey = trimmed.toLocaleLowerCase();
  const cached = researchCache.get(cacheKey);
  if (cached) return cached;

  const [wikiRes, countriesRes, dictionaryRes, wiktionaryRes] = await Promise.allSettled([
    fetchWikipediaBundle(trimmed),
    fetchCountriesBundle(trimmed),
    fetchDictionaryBundle(trimmed),
    fetchWiktionaryBundle(trimmed),
  ]);

  const value = (result: PromiseSettledResult<SourceBundle>): SourceBundle =>
    result.status === "fulfilled" ? result.value : EMPTY_BUNDLE;
  const wiki = value(wikiRes);
  const countries = value(countriesRes);
  const dictionary = value(dictionaryRes);
  const wiktionary = value(wiktionaryRes);

  // Rank: encyclopedia lead first, then the domain-specific atlas capsule,
  // then encyclopedia breadth (secondary articles), and dictionary/wiktionary
  // definitions LAST — they explain the literal word, but the model should
  // dig into the topic's substance first. The pools self-filtered to nothing,
  // so they never inject junk for non-matching subjects.
  const passages: ResearchPassage[] = [];
  const [wikiPrimary, ...wikiSecondary] = wiki.passages;
  pushUnique(passages, wikiPrimary ? [wikiPrimary] : [], (passage) => passage.url);
  pushUnique(passages, countries.passages, (passage) => passage.url);
  pushUnique(passages, wikiSecondary, (passage) => passage.url);
  pushUnique(passages, dictionary.passages, (passage) => passage.url);
  pushUnique(passages, wiktionary.passages, (passage) => passage.url);

  const sources: InternetSource[] = [];
  pushUnique(sources, wiki.sources, (source) => source.url);
  pushUnique(sources, countries.sources, (source) => source.url);
  pushUnique(sources, dictionary.sources, (source) => source.url);
  pushUnique(sources, wiktionary.sources, (source) => source.url);

  const relatedTerms: string[] = [];
  // Encyclopedia categories/titles and country facts steer the focus rotation
  // first; dictionary synonyms come last (they push toward the bare word).
  pushUnique(relatedTerms, wiki.relatedTerms, (term) => term.toLocaleLowerCase());
  pushUnique(relatedTerms, countries.relatedTerms.filter(Boolean), (term) => term.toLocaleLowerCase());
  pushUnique(relatedTerms, wiktionary.relatedTerms, (term) => term.toLocaleLowerCase());
  pushUnique(relatedTerms, dictionary.relatedTerms, (term) => term.toLocaleLowerCase());
  pushUnique(relatedTerms, [trimmed], (term) => term.toLocaleLowerCase());

  if (passages.length === 0 && sources.length === 0) {
    // Every curated pool came up empty — fall back to the generic web facts.
    const fallbackSources = await fetchFallbackWebFacts(trimmed);
    if (fallbackSources.length === 0) {
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        throw new Error(`Could not reach the internet to research “${trimmed}”. Check your internet connection so WebLLM can generate questions from live sources.`);
      }
      throw new Error(`No factual articles were found for “${trimmed}” in the encyclopedia, dictionary, or atlas sources. Try a clearer or more specific topic so WebLLM can ground the quiz in real facts.`);
    }

    const fallbackPassages = fallbackSources.map((source) => ({ title: source.title, url: source.url, text: source.snippet, via: source.via }));
    const fallbackTerms = [trimmed, ...fallbackSources.map((source) => source.title)];
    const research: InternetResearch = {
      subject: trimmed,
      sources: fallbackSources,
      passages: fallbackPassages,
      relatedTerms: fallbackTerms.filter((term, index, all) => all.findIndex((candidate) => candidate.toLocaleLowerCase() === term.toLocaleLowerCase()) === index),
      context: fallbackPassages.map((passage, index) => `[Source ${index + 1}: ${passage.title}]\n${passage.text}`).join("\n\n").slice(0, 4800),
    };
    return research;
  }

  const context = passages
    .slice(0, 6)
    .map((passage, index) => `[Source ${index + 1}: ${passage.title}]\n${passage.text}`)
    .join("\n\n")
    .slice(0, 4800);

  const research: InternetResearch = {
    subject: trimmed,
    sources: sources.slice(0, 5),
    passages: passages.slice(0, 6),
    relatedTerms: relatedTerms.slice(0, 16),
    context,
  };

  // Cache only results that include an encyclopedia article. A dictionary-only
  // result is a degraded fallback: caching it would pin the whole session to a
  // one-line definition and make every generated question sound like a
  // vocabulary quiz. Re-fetching gives the next attempt a chance at Wikipedia.
  const hasEncyclopediaPassage = passages.some((passage) => passage.via === "Wikipedia");
  if (hasEncyclopediaPassage) {
    if (researchCache.size >= RESEARCH_CACHE_LIMIT) {
      for (const key of researchCache.keys()) {
        researchCache.delete(key);
        break;
      }
    }
    researchCache.set(cacheKey, research);
  }
  return research;
}
