import type { ToolDefinition } from "./types.js";
import { guardedFetchText } from "./net/guardedFetch.js";
import { config } from "../config.js";

const MAX_EXCERPT_CHARS = 6_000;
const MIN_BLOCK_CHARS = 40; // drop short nav/menu/link fragments once tags are stripped


function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function extractTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return null;
  const title = decodeEntities(match[1]!.trim()).slice(0, 300);
  return title || null;
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * Small readability heuristic (no dependency, no real DOM parsing): drop
 * boilerplate elements outright, split what remains on paragraph/heading
 * closing tags, and keep only chunks with enough plain text to plausibly be
 * article prose. This filters short nav links / button labels reasonably
 * well on typical article markup (<p>-based bodies); it will extract less
 * cleanly on div-soup-only pages with no semantic paragraph tags.
 */
function extractReadableText(html: string): string {
  const withoutBoilerplate = html.replace(
    /<(script|style|noscript|svg|nav|header|footer|aside|form|iframe|button)[\s\S]*?<\/\1>/gi,
    " ",
  );
  const blocks = withoutBoilerplate.split(/<\/(?:p|li|h[1-6]|blockquote)>/gi);
  const kept = blocks.map((block) => stripTags(block)).filter((text) => text.length >= MIN_BLOCK_CHARS);
  return kept.join("\n\n");
}

export const articleExtractTool: ToolDefinition = {
  name: "article_extract",
  description:
    "Fetch a public web page and extract just its readable article text and title, filtering out navigation, " +
    "ads, and boilerplate. Prefer this over http_fetch when the user shares a link and wants its content or a " +
    "summary; use http_fetch instead when you need the raw response (non-HTML content, or exact markup). Same " +
    "SSRF protections as http_fetch." +
    (config.gitlabHost ? ` Cannot reach ${config.gitlabHost} — use the mcp__gitlab__* tools for GitLab issues instead.` : ""),
  category: "web",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "http(s) URL of the article/page to read." },
    },
    required: ["url"],
    additionalProperties: false,
  },
  async execute(args: { url: string }) {
    if (typeof args?.url !== "string" || args.url.trim().length === 0) {
      throw new Error("url must be a non-empty string");
    }
    const parsed = new URL(args.url);
    const { status, contentType, text: html } = await guardedFetchText(parsed.toString());
    if (!contentType.toLowerCase().includes("html")) {
      throw new Error(`Not an HTML page (content-type: ${contentType || "unknown"}) — try http_fetch instead.`);
    }
    const title = extractTitle(html);
    const text = extractReadableText(html);
    const truncated = text.length > MAX_EXCERPT_CHARS;
    const excerpt = truncated ? `${text.slice(0, MAX_EXCERPT_CHARS)}\n...[truncated]` : text;
    const wordCount = excerpt.split(/\s+/).filter(Boolean).length;
    return {
      url: parsed.toString(),
      status,
      title,
      text: excerpt,
      truncated,
      wordCount,
      estimatedReadingMinutes: Math.max(1, Math.round(wordCount / 200)),
    };
  },
};
