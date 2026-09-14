import type { ToolContext, ToolDefinition } from "./types.js";
import { getAttachmentMeta, readAttachmentBytes } from "../storage/attachmentStore.js";

/** One call may return this many characters; the model pages through a bigger file with `offset`. */
const MAX_CHUNK_CHARS = 40_000;

/**
 * Reads a text attachment of the CURRENT conversation, by id.
 *
 * Deliberately not "read_text_file for the attachment directory". It takes an
 * id, never a path, and resolves it against the session and conversation the
 * turn is running in, so there is no path to traverse and no way to name
 * another session's file: an id that is not in this conversation's directory
 * simply does not resolve. It also reads the bytes directly rather than through
 * tools/fsRoot.ts, which refuses everything inside DATA_DIR — that ban is what
 * stopped a real cross-session read and must stay exactly as strict as it is.
 */
export const readAttachmentTool: ToolDefinition = {
  name: "read_attachment",
  description:
    "Read the full text of a file the user attached to this conversation, by its attachment_id. " +
    "Use this when an attachment was shown to you as a stub because it was too large to inline. " +
    "Returns a chunk of at most 40000 characters; pass `offset` to continue reading a longer file.",
  category: "attachment",
  parameters: {
    type: "object",
    properties: {
      attachment_id: { type: "string", description: "The attachment_id shown in the attachment stub" },
      offset: { type: "integer", description: "Character offset to start from (default 0)", minimum: 0 },
      length: {
        type: "integer",
        description: `Characters to return (default and maximum ${MAX_CHUNK_CHARS})`,
        minimum: 1,
        maximum: MAX_CHUNK_CHARS,
      },
    },
    required: ["attachment_id"],
    additionalProperties: false,
  },
  async execute(args: { attachment_id?: unknown; offset?: unknown; length?: unknown }, ctx?: ToolContext) {
    if (!ctx) throw new Error("read_attachment is only available inside a conversation");
    const id = typeof args?.attachment_id === "string" ? args.attachment_id.trim() : "";
    if (!id) throw new Error("attachment_id must be a non-empty string");

    const meta = await getAttachmentMeta(ctx.ownerId, ctx.conversationId, id);
    if (!meta) throw new Error(`No attachment ${id} in this conversation`);
    if (meta.kind !== "text") throw new Error(`Attachment ${meta.name} is an image; it is already in the conversation`);
    const bytes = await readAttachmentBytes(ctx.ownerId, ctx.conversationId, id);
    if (!bytes) throw new Error(`Attachment ${meta.name} is no longer stored`);

    const text = bytes.toString("utf8");
    const offset = clampInt(args?.offset, 0, Math.max(0, text.length), 0);
    const length = clampInt(args?.length, 1, MAX_CHUNK_CHARS, MAX_CHUNK_CHARS);
    const content = text.slice(offset, offset + length);
    return {
      name: meta.name,
      chars: text.length,
      offset,
      length: content.length,
      eof: offset + content.length >= text.length,
      content,
    };
  },
};

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}
