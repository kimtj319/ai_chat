/**
 * Argument checks that several tools repeat word for word. The messages are
 * what the model reads when it gets an argument wrong, so they stay exactly as
 * the tools wrote them.
 */

/** A required string argument, trimmed. Throws `${name} must be a non-empty string` when nothing is left. */
export function requireTrimmed(value: unknown, name: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${name} must be a non-empty string`);
  return text;
}

/**
 * A required string argument, NOT trimmed (whitespace can be the input — a hash
 * or an encoding of it is still an answer), and at most `maxChars` long.
 */
export function requireBoundedText(value: unknown, name: string, maxChars: number): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  if (value.length > maxChars) {
    throw new Error(`${name} too large (${value.length} chars, limit ${maxChars})`);
  }
  return value;
}
