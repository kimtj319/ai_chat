import fs from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "./types.js";
import { config } from "../config.js";
import { resolveInsideRoot } from "./fsRoot.js";

const MAX_READ_BYTES = 2 * 1024 * 1024;

/** Exported so the attachment upload route can refuse exactly what this tool refuses. */
export function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8000);
  if (sample.includes(0)) return true;
  let suspicious = 0;
  for (const byte of sample) {
    // allow common whitespace control chars (tab, LF, CR); count other control bytes as suspicious
    if (byte < 7 || (byte > 14 && byte < 32)) suspicious++;
  }
  return sample.length > 0 && suspicious / sample.length > 0.3;
}

export const readTextFileTool: ToolDefinition = {
  name: "read_text_file",
  description:
    "Read a UTF-8 text file. Only files under the server's configured filesystem root can be read; the path " +
    "is resolved (following symlinks) and checked to still be inside that root. Binary files are rejected.",
  category: "filesystem",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the tool filesystem root" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async execute(args: { path: string }) {
    if (typeof args?.path !== "string" || args.path.trim().length === 0) {
      throw new Error("path must be a non-empty string");
    }
    const real = await resolveInsideRoot(config.toolFsRoot, args.path);
    const stat = await fs.stat(real);
    if (!stat.isFile()) throw new Error("Not a regular file");
    if (stat.size > MAX_READ_BYTES) {
      throw new Error(`File too large (${stat.size} bytes, limit ${MAX_READ_BYTES})`);
    }
    const buffer = await fs.readFile(real);
    if (looksBinary(buffer)) throw new Error("Refusing to read what looks like a binary file");
    const realRoot = await fs.realpath(config.toolFsRoot);
    return { path: path.relative(realRoot, real) || ".", content: buffer.toString("utf8") };
  },
};
