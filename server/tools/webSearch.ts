import type { ToolDefinition } from "./types.js";
import { config } from "../config.js";

const MAX_RESULTS_CAP = 10;
const SNIPPET_CHARS = 1_200;

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
  published_date?: string;
}

interface TavilyResponse {
  answer?: string | null;
  results?: TavilyResult[];
  response_time?: number;
  detail?: unknown;
}

function clampResults(value: unknown): number {
  const n = typeof value === "number" ? Math.trunc(value) : 5;
  if (!Number.isFinite(n)) return 5;
  return Math.min(Math.max(n, 1), MAX_RESULTS_CAP);
}

/**
 * Web search via the Tavily API.
 *
 * Unlike http_fetch (which needs a URL you already have), this turns a natural
 * language query into ranked results. Tavily returns pre-extracted page text,
 * so the model usually does not need a follow-up http_fetch — though it can
 * still fetch a returned URL for the full page.
 *
 * Requires TAVILY_API_KEY. Without it the tool fails with a clear message
 * rather than silently returning nothing.
 */
export const webSearchTool: ToolDefinition = {
  name: "web_search",
  description:
    "Search the public web and return ranked results with title, URL, and an extracted text snippet, " +
    "plus a short synthesized answer when available. Use this to find current information or sources " +
    "when you do not already have a URL. To read one result in full, follow up with http_fetch on its URL.",
  category: "web",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query, in natural language.",
      },
      max_results: {
        type: "integer",
        description: `How many results to return (1-${MAX_RESULTS_CAP}). Defaults to 5.`,
        minimum: 1,
        maximum: MAX_RESULTS_CAP,
      },
      search_depth: {
        type: "string",
        enum: ["basic", "advanced"],
        description:
          'Search effort. "basic" is fast and usually enough; "advanced" digs deeper but is slower. Defaults to basic.',
      },
      topic: {
        type: "string",
        enum: ["general", "news"],
        description: 'Use "news" for recent events and reporting. Defaults to general.',
      },
      include_domains: {
        type: "array",
        items: { type: "string" },
        description: "Restrict results to these domains, e.g. [\"docs.vllm.ai\"].",
      },
      exclude_domains: {
        type: "array",
        items: { type: "string" },
        description: "Never return results from these domains.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },

  async execute(args: {
    query: string;
    max_results?: number;
    search_depth?: "basic" | "advanced";
    topic?: "general" | "news";
    include_domains?: string[];
    exclude_domains?: string[];
  }) {
    const query = typeof args?.query === "string" ? args.query.trim() : "";
    if (!query) throw new Error("query must be a non-empty string");

    const apiKey = config.tavilyApiKey;
    if (!apiKey) {
      throw new Error(
        "Web search is not configured: set TAVILY_API_KEY in the server environment.",
      );
    }

    const body: Record<string, unknown> = {
      query,
      max_results: clampResults(args?.max_results),
      search_depth: args?.search_depth === "advanced" ? "advanced" : "basic",
      topic: args?.topic === "news" ? "news" : "general",
      include_answer: true,
    };
    if (Array.isArray(args?.include_domains) && args.include_domains.length > 0) {
      body.include_domains = args.include_domains.filter((d) => typeof d === "string");
    }
    if (Array.isArray(args?.exclude_domains) && args.exclude_domains.length > 0) {
      body.exclude_domains = args.exclude_domains.filter((d) => typeof d === "string");
    }

    let res: Response;
    try {
      res = await fetch(config.tavilyApiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.toolHttpTimeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new Error(`Web search timed out after ${config.toolHttpTimeoutMs / 1000}s`);
      }
      throw new Error(`Web search request failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!res.ok) {
      // Map the common failures to something the model can act on, and never
      // echo the API key back into the transcript.
      const detail = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) {
        throw new Error("Web search rejected the API key (check TAVILY_API_KEY).");
      }
      if (res.status === 429) {
        throw new Error("Web search rate limit or monthly quota exceeded.");
      }
      throw new Error(`Web search responded ${res.status}: ${detail.slice(0, 300)}`);
    }

    const data = (await res.json()) as TavilyResponse;

    return {
      query,
      answer: data.answer ?? null,
      results: (data.results ?? []).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        // Snippets are already extracted text; cap each one so a handful of
        // long pages can't blow past the runner's overall result limit.
        snippet: (r.content ?? "").slice(0, SNIPPET_CHARS),
        score: r.score,
        ...(r.published_date ? { publishedDate: r.published_date } : {}),
      })),
      resultCount: (data.results ?? []).length,
    };
  },
};
