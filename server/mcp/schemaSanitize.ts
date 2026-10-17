/**
 * The schema sanitiser for MCP tools: what a server we do not control declares,
 * cut down at the boundary to what the prompt can afford.
 *
 * THE SCHEMA BLOCK IS A FIXED COST IN EVERY PROMPT. It is sent on every round
 * of every turn, it cannot be shortened later, and a server we do not control
 * decides what goes in it. So an oversized, deeply nested or $ref-laden schema
 * is cut down here rather than being passed through to the model.
 */

/** Root counts as 1, so a property's property is the deepest that survives. */
const MAX_SCHEMA_DEPTH = 3;
const MAX_PROPERTIES = 40;
const MAX_DESCRIPTION_CHARS = 1024;

/**
 * Everything else is dropped. An allowlist rather than a denylist because the
 * risk is what a server sends that we have not thought about — `$ref` into a
 * `$defs` we removed, vendor extensions, a nested `$schema` — not what it sends
 * that we already know to remove.
 */
const SCHEMA_KEYS = new Set([
  "type",
  "description",
  "enum",
  "const",
  "default",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "items",
  "properties",
  "required",
  "additionalProperties",
  // Kept because real servers use them for a plain "string or string[]"
  // argument: mcp.deepwiki.com's ask_question declares repoName that way, and
  // dropping the branch would leave the model a described argument with no
  // type at all.
  "anyOf",
  "oneOf",
]);

/** Dropped wherever they appear, including nested. A $ref is dropped, never resolved. */
const STRIPPED_KEYS = new Set(["$schema", "$id", "$ref", "$defs", "definitions"]);

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Control characters out of a description. Newlines and tabs stay: a schema
 * description is prose that reaches the prompt, and flattening it to one line
 * makes a multi-paragraph description unreadable without making it any safer.
 */
export function cleanText(value: unknown, max = MAX_DESCRIPTION_CHARS): string {
  if (typeof value !== "string") return "";
  const stripped = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  return stripped.length > max ? `${stripped.slice(0, max - 1)}…` : stripped;
}

/**
 * One schema node. Returns undefined for anything that must be DROPPED — a
 * $ref, a non-object node, or a node that is already too deep — and the caller
 * removes the property that held it (and its `required` entry) rather than
 * leaving the model a name with no schema.
 */
function sanitizeNode(node: unknown, depth: number): Record<string, unknown> | undefined {
  if (!isPlainObject(node)) return undefined;
  if ("$ref" in node) return undefined;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (STRIPPED_KEYS.has(key) || !SCHEMA_KEYS.has(key)) continue;
    if (key === "description") {
      const description = cleanText(value);
      if (description) out.description = description;
      continue;
    }
    if (key === "properties" || key === "items" || key === "anyOf" || key === "oneOf") continue; // depth-aware, below
    if (key === "required") {
      if (Array.isArray(value)) out.required = value.filter((v): v is string => typeof v === "string");
      continue;
    }
    out[key] = value;
  }

  // At the depth limit the node keeps its scalar constraints and loses its
  // children: a truncated shape the model can still fill in beats a name with
  // no schema at all.
  if (depth >= MAX_SCHEMA_DEPTH) {
    delete out.required;
    return out;
  }

  if (isPlainObject(node.properties)) {
    const properties: Record<string, unknown> = {};
    let kept = 0;
    for (const [name, child] of Object.entries(node.properties)) {
      if (kept >= MAX_PROPERTIES) break;
      const sanitized = sanitizeNode(child, depth + 1);
      if (!sanitized) continue;
      properties[name] = sanitized;
      kept++;
    }
    out.properties = properties;
    if (Array.isArray(out.required)) {
      // A required name whose schema we dropped would be an instruction the
      // model cannot follow.
      const filtered = (out.required as string[]).filter((name) => name in properties);
      if (filtered.length > 0) out.required = filtered;
      else delete out.required;
    }
  }

  if (node.items !== undefined) {
    const items = sanitizeNode(node.items, depth + 1);
    if (items) out.items = items;
  }

  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = node[key];
    if (!Array.isArray(branches)) continue;
    // A branch that sanitises away (a $ref, say) is dropped; a union with no
    // branch left is dropped entirely rather than offered as an empty choice.
    const kept = branches.map((branch) => sanitizeNode(branch, depth + 1)).filter((b): b is Record<string, unknown> => Boolean(b));
    if (kept.length > 0) out[key] = kept;
  }

  return out;
}

/**
 * The parameters object handed to vLLM. Forced to an object root whatever the
 * server declared: the chat-completions contract is that arguments arrive as a
 * JSON object, and a schema saying otherwise produces calls that cannot be
 * parsed.
 */
export function sanitizeInputSchema(schema: unknown): Record<string, unknown> {
  const sanitized = sanitizeNode(schema, 1) ?? {};
  sanitized.type = "object";
  if (!isPlainObject(sanitized.properties)) sanitized.properties = {};
  return sanitized;
}
