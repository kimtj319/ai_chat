import type { Conversation, MessageAttachment, StoredMessage } from "../types.js";
import { composeSystemPrompt } from "./systemPrompt.js";
import { readAttachmentBytes } from "../storage/attachmentStore.js";
import { IMAGE_TOKEN_CEILING } from "../attachments/sniff.js";
import { STUB_PREVIEW_CHARS } from "../attachments/budget.js";

export interface VllmTextPart {
  type: "text";
  text: string;
}

export interface VllmImagePart {
  type: "image_url";
  /**
   * Must be an object: a bare string is a 400 from the server. Only `data:`
   * URLs are usable — an http:// url makes the GPU host fetch it and file:// is
   * refused outright (measured 2026-09-11).
   */
  image_url: { url: string };
}

export type VllmContentPart = VllmTextPart | VllmImagePart;

export interface VllmMessage {
  role: "system" | "user" | "assistant" | "tool";
  /**
   * A parts array is emitted ONLY for a user message that carries images, so
   * every other consumer keeps seeing the string it has always seen. A system
   * message must never carry parts: the server answers
   * 400 "System message cannot contain images."
   */
  content: string | VllmContentPart[];
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
  /**
   * NOT part of the wire format: what each image part of this message costs the
   * prompt, in the same order as the parts. The budget ladder uses it to plan an
   * eviction in one batch instead of re-tokenizing after every image (a
   * /tokenize on a 16-image list measured 1.2-7.7s against 0.15-0.86s for the
   * same token count as text). vllm/client.ts strips it in toWire() before
   * serialising: this server ignores the extra field today (measured — 200 and
   * an identical token count with it left in), but it is not part of the API
   * and must not be relied on to stay ignored.
   */
  imageTokens?: number[];
}

/**
 * Shown in place of an image the budget ladder had to evict, and in the copy of
 * the context sent to the summariser. Without it the model sees a question about
 * a picture that is simply not there and answers as if it had seen one.
 */
export const IMAGE_DROPPED_PLACEHOLDER =
  "[첨부 이미지 1장은 컨텍스트 한도 때문에 대화에서 제외되었습니다. 이 이미지에 대해 다시 물으시려면 같은 이미지를 다시 올려 주세요.]";

/**
 * Build the message list sent to vLLM: the composed system prompt first
 * (default baseline + this conversation's extra instructions), then
 * every prior turn. Reasoning is intentionally stripped — Qwen's chat
 * template discards previous-turn thinking. A turn that used tools is
 * reconstructed as assistant(tool_calls) -> tool result(s) -> assistant
 * (final content), which is the standard OpenAI tool-turn shape even though
 * we persist it as a single flattened message.
 *
 * Async because attachments are read from disk here — once per turn, not once
 * per tool round: the tool loop keeps the list this returns and appends to it.
 */
export interface HistoryBuildOptions {
  /**
   * Inserted right after the system prompt, standing in for the messages before
   * `fromIndex`. This is how a stored history summary reaches the model; see
   * chat/historySummary.ts.
   */
  prelude?: VllmMessage;
  /** Index of the first message of `conversation.messages` to include. */
  fromIndex?: number;
}

export async function buildHistoryMessages(
  conversation: Conversation,
  ownerId: string,
  options?: HistoryBuildOptions,
): Promise<VllmMessage[]> {
  const result: VllmMessage[] = [];
  // The default prompt always applies; the conversation's own instructions are
  // appended to it rather than replacing it.
  const system = composeSystemPrompt(conversation.systemPrompt);
  if (system) {
    result.push({ role: "system", content: system });
  }
  if (options?.prelude) result.push(options.prelude);
  for (const message of conversation.messages.slice(options?.fromIndex ?? 0)) {
    result.push(...(await messageToVllm(message, ownerId, conversation.id)));
  }
  return result;
}

async function messageToVllm(
  message: StoredMessage,
  ownerId: string,
  conversationId: string,
): Promise<VllmMessage[]> {
  if (message.role === "user") {
    return [await userMessageToVllm(message, ownerId, conversationId)];
  }
  if (message.toolCalls && message.toolCalls.length > 0) {
    const out: VllmMessage[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: message.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
        })),
      },
    ];
    for (const tr of message.toolResults ?? []) {
      out.push({
        role: "tool",
        tool_call_id: tr.id,
        name: tr.name,
        content: JSON.stringify(tr.ok ? tr.result ?? null : { error: tr.error ?? "tool execution failed" }),
      });
    }
    if (message.content.trim().length > 0) {
      out.push({ role: "assistant", content: message.content });
    }
    return out;
  }
  return [{ role: "assistant", content: message.content }];
}

/**
 * A user message plus its attachments: images become image parts (images first,
 * then exactly one text part), text files are folded into that text — inlined
 * whole when small, or as a stub the model can expand with read_attachment.
 */
async function userMessageToVllm(
  message: StoredMessage,
  ownerId: string,
  conversationId: string,
): Promise<VllmMessage> {
  const attachments = message.attachments ?? [];
  if (attachments.length === 0) return { role: "user", content: message.content };

  const imageParts: VllmImagePart[] = [];
  const imageTokens: number[] = [];
  const blocks: string[] = [];
  for (const attachment of attachments) {
    const bytes = await readAttachmentBytes(ownerId, conversationId, attachment.id);
    if (!bytes) {
      // Swept, or the disk lost it. Say so rather than answering about a file
      // that is not in the prompt.
      blocks.push(`[첨부 파일: ${attachment.name} — 파일을 찾을 수 없어 이 대화에 포함하지 못했습니다.]`);
      continue;
    }
    if (attachment.kind === "image") {
      imageParts.push({ type: "image_url", image_url: { url: `data:${attachment.mime};base64,${bytes.toString("base64")}` } });
      imageTokens.push(attachment.estimatedTokens ?? IMAGE_TOKEN_CEILING);
    } else {
      blocks.push(textAttachmentBlock(attachment, bytes));
    }
  }

  const text = [message.content.trim(), ...blocks].filter((part) => part.length > 0).join("\n\n");
  if (imageParts.length === 0) return { role: "user", content: text };
  return {
    role: "user",
    // Images first, then one text part. A message whose text would be empty
    // (images only, no typed question) still gets one, naming the files: an
    // empty text part is a shape we have not measured, and the filename is
    // often what the user is asking about.
    content: [...imageParts, { type: "text", text: text || imageOnlyLabel(attachments) }],
    imageTokens,
  };
}

function imageOnlyLabel(attachments: MessageAttachment[]): string {
  const names = attachments.filter((a) => a.kind === "image").map((a) => a.name);
  return `[첨부 이미지: ${names.join(", ")}]`;
}

/**
 * The text of one text attachment as the model sees it. Inlined whole below the
 * configured threshold; above it a stub with a short preview and the id to pass
 * to read_attachment, so a 2MB log costs a few hundred tokens instead of the
 * window.
 */
function textAttachmentBlock(attachment: MessageAttachment, bytes: Buffer): string {
  const text = bytes.toString("utf8");
  const chars = attachment.chars ?? text.length;
  const label = `[첨부 파일: ${attachment.name} · 텍스트 · ${chars.toLocaleString("en-US")}자]`;
  if (attachment.inlined) {
    return `${label}\n${fence(text, attachment.name)}`;
  }
  const preview = text.slice(0, STUB_PREVIEW_CHARS).trimEnd();
  return (
    `${label.slice(0, -1)} · 본문은 프롬프트에 포함되지 않았습니다]\n` +
    `attachment_id: ${attachment.id}\n` +
    `앞부분 ${preview.length.toLocaleString("en-US")}자 미리보기:\n${fence(preview, attachment.name)}\n` +
    `전체 내용이 필요하면 read_attachment 도구에 attachment_id="${attachment.id}" 를 넘겨서 읽으세요.`
  );
}

/**
 * Wrap text in a fence long enough to survive its own content: a .md
 * attachment containing ``` would otherwise close the block early and the rest
 * of the file would read as the user's own words.
 */
function fence(text: string, name: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}${fenceLanguage(name)}\n${text}\n${ticks}`;
}

/**
 * Fence language from the extension. Only the tag — it buys syntax awareness in
 * the model's reading of the block and costs one token.
 */
const FENCE_LANGUAGES: Record<string, string> = {
  ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", mjs: "js", cjs: "js",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp", php: "php",
  swift: "swift", scala: "scala", sh: "bash", bash: "bash", zsh: "bash",
  sql: "sql", json: "json", yaml: "yaml", yml: "yaml", toml: "toml", xml: "xml",
  html: "html", css: "css", scss: "scss", md: "markdown", csv: "csv",
  ini: "ini", conf: "conf", log: "log", env: "ini", properties: "ini",
};

function fenceLanguage(name: string): string {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return FENCE_LANGUAGES[ext] ?? "";
}

/** True for a user message that still carries at least one image part. */
export function imagePartCount(message: VllmMessage): number {
  if (!Array.isArray(message.content)) return 0;
  return message.content.reduce((n, part) => (part.type === "image_url" ? n + 1 : n), 0);
}

/**
 * Replace the `count` oldest image parts of a message with the placeholder,
 * folding it into the message's single text part rather than leaving a second
 * text part behind — one text part after the images is the shape that has been
 * measured, and a message whose images are all gone collapses back to a plain
 * string.
 */
export function dropImageParts(message: VllmMessage, count: number): VllmMessage {
  if (!Array.isArray(message.content) || count <= 0) return message;
  let dropped = 0;
  const kept: VllmContentPart[] = [];
  const keptTokens: number[] = [];
  let seen = 0;
  for (const part of message.content) {
    if (part.type !== "image_url") {
      kept.push(part);
      continue;
    }
    const cost = message.imageTokens?.[seen];
    seen++;
    if (dropped < count) {
      dropped++;
      continue;
    }
    kept.push(part);
    keptTokens.push(cost ?? IMAGE_TOKEN_CEILING);
  }
  if (dropped === 0) return message;

  const notes = Array.from({ length: dropped }, () => IMAGE_DROPPED_PLACEHOLDER).join("\n");
  const textPart = kept.find((part): part is VllmTextPart => part.type === "text");
  const text = [notes, textPart?.text ?? ""].filter((part) => part.length > 0).join("\n\n");
  const images = kept.filter((part): part is VllmImagePart => part.type === "image_url");
  if (images.length === 0) {
    const { imageTokens: _dropped, ...rest } = message;
    return { ...rest, content: text };
  }
  return { ...message, content: [...images, { type: "text", text }], imageTokens: keptTokens };
}
