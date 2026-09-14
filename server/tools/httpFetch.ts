import type { ToolDefinition } from "./types.js";
import { guardedFetchText } from "./net/guardedFetch.js";
import { config } from "../config.js";

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}


export const httpFetchTool: ToolDefinition = {
  name: "http_fetch",
  // 도구 설명은 매 턴 프롬프트에 실리는 고정 비용이라 한 문장을 더하는 데에도
  // 값이 있어야 한다. 이 문장은 그 값을 한다 — 없으면 모델이 GitLab 주소로
  // 열 번을 시도하고 열 번을 10초씩 기다린다. 설정돼 있을 때만 붙는다.
  description:
    "Fetch a public web URL over GET and return its status and readable text content (HTML is stripped to " +
    "plain text). Blocked from reaching loopback, link-local, and private/internal network addresses." +
    (config.gitlabHost
      ? ` Cannot reach ${config.gitlabHost} — use the mcp__gitlab__* tools for GitLab issues instead.`
      : ""),
  category: "web",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "http(s) URL to fetch" },
    },
    required: ["url"],
    additionalProperties: false,
  },
  async execute(args: { url: string }) {
    if (typeof args?.url !== "string" || args.url.trim().length === 0) {
      throw new Error("url must be a non-empty string");
    }
    const parsed = new URL(args.url);
    const { status, contentType, text } = await guardedFetchText(parsed.toString());
    const body = contentType.toLowerCase().includes("html") ? htmlToText(text) : text;
    return { status, contentType, text: body };
  },
};
