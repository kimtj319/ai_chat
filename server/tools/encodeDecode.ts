import type { ToolDefinition } from "./types.js";

const MAX_INPUT_CHARS = 100_000;

type Operation =
  | "base64_encode"
  | "base64_decode"
  | "base64url_encode"
  | "base64url_decode"
  | "hex_encode"
  | "hex_decode"
  | "url_encode"
  | "url_decode"
  | "jwt_decode";

const OPERATIONS: Operation[] = [
  "base64_encode",
  "base64_decode",
  "base64url_encode",
  "base64url_decode",
  "hex_encode",
  "hex_decode",
  "url_encode",
  "url_decode",
  "jwt_decode",
];

// Node's Buffer base64/base64url decoding is lenient (it silently drops
// invalid characters instead of throwing), so malformed input has to be
// rejected explicitly to give a clear error instead of returning garbage.
function isValidBase64(text: string): boolean {
  const cleaned = text.replace(/\s+/g, "");
  if (cleaned.length === 0) return true;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) return false;
  return cleaned.replace(/=+$/, "").length % 4 !== 1;
}

function isValidBase64Url(text: string): boolean {
  const cleaned = text.replace(/\s+/g, "");
  if (cleaned.length === 0) return true;
  if (!/^[A-Za-z0-9_-]+$/.test(cleaned)) return false;
  return cleaned.length % 4 !== 1;
}

function decodeJwt(token: string): Record<string, unknown> {
  const parts = token.trim().split(".");
  if (parts.length < 2) {
    throw new Error("Not a valid JWT: expected header.payload[.signature]");
  }
  const decodeSegment = (segment: string, name: string): unknown => {
    if (!isValidBase64Url(segment)) throw new Error(`JWT ${name} segment is not valid base64url`);
    try {
      return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    } catch {
      throw new Error(`JWT ${name} segment is not valid JSON`);
    }
  };
  const header = decodeSegment(parts[0]!, "header");
  const payload = decodeSegment(parts[1]!, "payload");
  const claims = (typeof payload === "object" && payload !== null ? payload : {}) as Record<string, unknown>;
  const result: Record<string, unknown> = {
    header,
    payload,
    signaturePresent: parts.length === 3 && parts[2]!.length > 0,
    warning: "Signature was not verified — do not trust this payload for authorization decisions.",
  };
  if (typeof claims.exp === "number") {
    result.expiresAt = new Date(claims.exp * 1000).toISOString();
    result.expired = Date.now() > claims.exp * 1000;
  }
  if (typeof claims.iat === "number") {
    result.issuedAt = new Date(claims.iat * 1000).toISOString();
  }
  return result;
}

export const encodeDecodeTool: ToolDefinition = {
  name: "encode_decode",
  description:
    "Encode or decode text using base64, base64url, hex, or URL-component encoding, or decode (not verify) a " +
    "JWT's header and payload. Every decode operation rejects malformed input with a clear error instead of " +
    "returning garbage bytes. Local and instant — no network involved.",
  category: "utility",
  parameters: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: OPERATIONS,
        description: "Which transformation to apply.",
      },
      text: { type: "string", description: "The input text (or JWT for jwt_decode)." },
    },
    required: ["operation", "text"],
    additionalProperties: false,
  },
  async execute(args: { operation: Operation; text: string }) {
    if (typeof args?.text !== "string" || args.text.length === 0) {
      throw new Error("text must be a non-empty string");
    }
    if (args.text.length > MAX_INPUT_CHARS) {
      throw new Error(`text too large (${args.text.length} chars, limit ${MAX_INPUT_CHARS})`);
    }
    if (!OPERATIONS.includes(args.operation)) {
      throw new Error(`Unknown operation: "${args.operation}"`);
    }
    const { operation, text } = args;
    switch (operation) {
      case "base64_encode":
        return { output: Buffer.from(text, "utf8").toString("base64") };
      case "base64_decode":
        if (!isValidBase64(text)) throw new Error("Input is not valid base64");
        return { output: Buffer.from(text.replace(/\s+/g, ""), "base64").toString("utf8") };
      case "base64url_encode":
        return { output: Buffer.from(text, "utf8").toString("base64url") };
      case "base64url_decode":
        if (!isValidBase64Url(text)) throw new Error("Input is not valid base64url");
        return { output: Buffer.from(text.replace(/\s+/g, ""), "base64url").toString("utf8") };
      case "hex_encode":
        return { output: Buffer.from(text, "utf8").toString("hex") };
      case "hex_decode":
        if (!/^[0-9a-fA-F]*$/.test(text) || text.length % 2 !== 0) {
          throw new Error("Input is not valid hex (must be an even number of 0-9a-f characters)");
        }
        return { output: Buffer.from(text, "hex").toString("utf8") };
      case "url_encode":
        return { output: encodeURIComponent(text) };
      case "url_decode":
        try {
          return { output: decodeURIComponent(text) };
        } catch {
          throw new Error("Input is not validly percent-encoded");
        }
      case "jwt_decode":
        return decodeJwt(text);
    }
  },
};
