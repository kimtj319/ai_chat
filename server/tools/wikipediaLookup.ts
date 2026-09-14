import type { ToolDefinition } from "./types.js";
import { config } from "../config.js";

const SEARCH_ENDPOINT = "https://en.wikipedia.org/w/api.php";
const SUMMARY_ENDPOINT = "https://en.wikipedia.org/api/rest_v1/page/summary/";
// Two sequential calls (search, then summary) share the tool's runner budget,
// so each leg gets 60% of the single-request timeout (6s at the default) —
// enough for a slow leg, short enough that one cannot eat the whole budget.
const LEG_TIMEOUT_MS = Math.round(config.toolHttpTimeoutMs * 0.6);
const MAX_EXTRACT_CHARS = 2_000;
const USER_AGENT = "qwen3-web-chat-tool/1.0";

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
  let res: Response;
  try {
    res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(LEG_TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`Wikipedia search failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new Error(`Wikipedia search responded ${res.status}`);
  const data = (await res.json()) as { query?: { search?: SearchHit[] } };
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
    const query = typeof args?.query === "string" ? args.query.trim() : "";
    if (!query) throw new Error("query must be a non-empty string");

    const title = await findTitle(query);

    let res: Response;
    try {
      res = await fetch(SUMMARY_ENDPOINT + encodeURIComponent(title.replace(/ /g, "_")), {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(LEG_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`Wikipedia summary request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) throw new Error(`Wikipedia summary responded ${res.status} for "${title}"`);
    const data = (await res.json()) as {
      title?: string;
      description?: string;
      extract?: string;
      type?: string;
      content_urls?: { desktop?: { page?: string } };
    };

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
