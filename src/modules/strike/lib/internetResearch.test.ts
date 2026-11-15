import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchInternetResearch } from "./internetResearch";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchInternetResearch", () => {
  it("keeps the encyclopedia bundle when search returns more than three pages", async () => {
    // Regression: fetchWikipediaBundle fetched full bodies for only the first
    // 3 pages but iterated over all search results, so any search returning 4+
    // pages threw on bodies[3].status, discarded the whole Wikipedia bundle,
    // and left every topic grounded in a one-line Wiktionary stub.
    const title = "Regression Planet";
    const wikiPages = Array.from({ length: 6 }, (_, index) => ({
      pageid: 100 + index,
      title: index === 0 ? title : `Related article ${index}`,
      index: index + 1,
      extract: `${title} is a planet used in regression tests. It orbits a star and has gravity.`,
      fullurl: `https://en.wikipedia.org/wiki/Regression_${index}`,
    }));
    const pagesById = Object.fromEntries(wikiPages.map((page) => [String(page.pageid), page]));

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("en.wiktionary.org")) {
          return jsonResponse({
            query: { pages: { 1: { title: `${title} — Wiktionary`, extract: `${title}: a planet used in tests.` } } },
          });
        }
        if (url.includes("generator=search")) {
          return jsonResponse({ query: { pages: pagesById } });
        }
        if (url.includes("prop=categories")) {
          return jsonResponse({ query: { pages: {} } });
        }
        if (url.includes("pageids=")) {
          const pageid = new URL(url).searchParams.get("pageids") ?? "";
          return jsonResponse({
            query: {
              pages: {
                [pageid]: {
                  extract: `Full article body for page ${pageid}. The planet orbits a star, and its gravity shapes the orbit.`,
                },
              },
            },
          });
        }
        return new Response("", { status: 404 });
      })
    );

    const research = await fetchInternetResearch(title);

    expect(research.passages.some((passage) => passage.via === "Wikipedia")).toBe(true);
    expect(research.passages[0].title).toBe(title);
    expect(research.passages[0].text).toContain("orbits a star");
  });
});
