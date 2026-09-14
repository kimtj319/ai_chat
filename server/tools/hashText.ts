import crypto from "node:crypto";
import type { ToolDefinition } from "./types.js";

const MAX_INPUT_CHARS = 200_000;
const ALGORITHMS = ["md5", "sha1", "sha256", "sha512"] as const;
type Algorithm = (typeof ALGORITHMS)[number];

export const hashTextTool: ToolDefinition = {
  name: "hash_text",
  description:
    "Compute a cryptographic hash digest (md5, sha1, sha256, or sha512) of a text string, returned as hex. Use " +
    "this for checksums or \"what's the SHA256 of this\" — not for password storage (this has no salt/KDF). " +
    "md5/sha1 are offered for legacy/checksum compatibility only.",
  category: "utility",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "The text to hash." },
      algorithm: {
        type: "string",
        enum: [...ALGORITHMS],
        description: "Hash algorithm. Defaults to sha256.",
      },
    },
    required: ["text"],
    additionalProperties: false,
  },
  async execute(args: { text: string; algorithm?: Algorithm }) {
    if (typeof args?.text !== "string" || args.text.length === 0) {
      throw new Error("text must be a non-empty string");
    }
    if (args.text.length > MAX_INPUT_CHARS) {
      throw new Error(`text too large (${args.text.length} chars, limit ${MAX_INPUT_CHARS})`);
    }
    const algorithm: Algorithm =
      args.algorithm && (ALGORITHMS as readonly string[]).includes(args.algorithm) ? args.algorithm : "sha256";
    const hex = crypto.createHash(algorithm).update(args.text, "utf8").digest("hex");
    return { algorithm, hex, inputLength: args.text.length };
  },
};
