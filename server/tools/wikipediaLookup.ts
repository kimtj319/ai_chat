import type { ToolDefinition } from "./types.js";
import { requireTrimmed } from "./args.js";
import { fetchJsonOrThrow, LEG_TIMEOUT_MS } from "./net/fetchJson.js";
import { TOOL_USER_AGENT } from "./net/guardedFetch.js";

const SEARCH_ENDPOINT = "https://en.wikipedia.org/w/api.php";
const SUMMARY_ENDPOINT = "https://en.wikipedia.org/api/rest_v1/page/summary/";
const MAX_EXTRACT_CHARS = 2_000;

interface SearchHit {
  title: string;
}

async function findTitle(query: string): Promise<string> {
  const url = new URL(SEARCH_ENDPOINT);
  url.searchParams.set("action", "query");
  url.searchParams.set("list", "search");
  url.searchParams.set("srsearch", query);
  url.searchParams.set("srlimit", "1");
  url.searchParams.set("format", "json");
  const data = await fetchJsonOrThrow<{ query?: { search?: SearchHit[] } }>(url, {
    timeoutMs: LEG_TIMEOUT_MS,
    headers: { "User-Agent": TOOL_USER_AGENT },
    failed: (detail) => `Wikipedia search failed: ${detail}`,
    status: (status) => `Wikipedia search responded ${status}`,
  });
  const hit = data.query?.search?.[0];
  if (!hit) {
    throw new Error(`No Wikipedia article found for "${query}" — try a different phrase or an English title.`);
  }
  return hit.title;
}

export const wikipediaLookupTool: ToolDefinition = {
  name: "wikipedia_lookup",
  description:
    "Look up a topic on English Wikipedia and return a short summary, its canonical title, and page URL. Use " +
    "this for encyclopedic facts about people, places, concepts, or events. Unlike web_search, this returns one " +
    "authoritative structured summary instead of ranked links — prefer web_search for current events or when " +
    "multiple sources matter.",
  category: "data",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: 'Topic or article title to look up, e.g. "Alan Turing" or "black hole".' },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async execute(args: { query: string }) {
    const query = requireTrimmed(args?.query, "query");

    const title = await findTitle(query);

    const data = await fetchJsonOrThrow<{
      title?: string;
      description?: string;
      extract?: string;
      type?: string;
      content_urls?: { desktop?: { page?: string } };
    }>(SUMMARY_ENDPOINT + encodeURIComponent(title.replace(/ /g, "_")), {
      timeoutMs: LEG_TIMEOUT_MS,
      headers: { "User-Agent": TOOL_USER_AGENT },
      failed: (detail) => `Wikipedia summary request failed: ${detail}`,
      status: (status) => `Wikipedia summary responded ${status} for "${title}"`,
    });

    const extract = data.extract ?? "";
    const truncated = extract.length > MAX_EXTRACT_CHARS;
    return {
      title: data.title ?? title,
      description: data.description ?? null,
      extract: truncated ? `${extract.slice(0, MAX_EXTRACT_CHARS)}...[truncated]` : extract,
      truncated,
      isDisambiguation: data.type === "disambiguation",
      url:
        data.content_urls?.desktop?.page ??
        `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
    };
  },
};
