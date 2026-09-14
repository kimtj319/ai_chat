import crypto from "node:crypto";
import type { ToolDefinition } from "./types.js";

const MAX_COUNT = 20;
const MAX_BYTES = 64;

type Kind = "uuid4" | "hex" | "base64";

export const generateRandomTool: ToolDefinition = {
  name: "generate_random",
  description:
    'Generate cryptographically random values: v4 UUIDs, or random hex/base64 tokens of a given byte length. ' +
    'Use this for "give me a UUID", session tokens, or placeholder IDs — not for anything requiring a specific ' +
    "or reproducible value.",
  category: "utility",
  parameters: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["uuid4", "hex", "base64"], description: "Kind of random value to generate." },
      count: {
        type: "integer",
        description: `How many values to generate (1-${MAX_COUNT}). Defaults to 1.`,
        minimum: 1,
        maximum: MAX_COUNT,
      },
      bytes: {
        type: "integer",
        description: `Byte length for "hex"/"base64" tokens (1-${MAX_BYTES}). Ignored for "uuid4". Defaults to 16.`,
        minimum: 1,
        maximum: MAX_BYTES,
      },
    },
    required: ["type"],
    additionalProperties: false,
  },
  async execute(args: { type: Kind; count?: number; bytes?: number }) {
    if (args?.type !== "uuid4" && args?.type !== "hex" && args?.type !== "base64") {
      throw new Error('type must be "uuid4", "hex", or "base64"');
    }
    const count = Number.isInteger(args.count) ? Math.min(Math.max(args.count as number, 1), MAX_COUNT) : 1;
    const bytes = Number.isInteger(args.bytes) ? Math.min(Math.max(args.bytes as number, 1), MAX_BYTES) : 16;

    const values = Array.from({ length: count }, () => {
      if (args.type === "uuid4") return crypto.randomUUID();
      const buf = crypto.randomBytes(bytes);
      return args.type === "hex" ? buf.toString("hex") : buf.toString("base64");
    });

    return { type: args.type, count, ...(args.type !== "uuid4" ? { bytes } : {}), values };
  },
};
