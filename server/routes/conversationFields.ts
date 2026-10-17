import { validateSettingsPatch } from "../types.js";
import type { ConversationSettings } from "../types.js";

/** A sidebar row, not a document. */
const MAX_TITLE_CHARS = 200;
/** Rides in every prompt of every later turn, so it is charged for forever. */
const MAX_SYSTEM_PROMPT_CHARS = 20_000;
/** The registry holds a few dozen; this is room for MCP servers on top. */
const MAX_ENABLED_TOOLS = 500;
/** No tool name is longer, so a longer entry could never resolve to a tool. */
const MAX_TOOL_NAME_CHARS = 64;

/** A refusal the caller can act on: which field was wrong, and why. */
export interface FieldProblem {
  error: string;
  field: string;
}

/**
 * The rules for the four stored fields, in ONE place, because PATCH is not the
 * only route that writes them: POST /conversations writes a title and a system
 * prompt, and POST /conversations/:id/messages carries a `settings` and an
 * `enabledTools` patch of its own. Both of those wrote straight through, so
 * every limit below could be walked around by sending the same value to a
 * different route — measured on the deployment:
 *
 *   POST /conversations/:id/messages {"content":"hi","settings":{"topP":99,"seed":"abc"}}
 *
 * stored topP 99 and seed "abc", and the conversation then answered
 * 400 "Input should be a valid integer, unable to parse string as an integer"
 * on EVERY later turn — the exact breakage validateSettingsPatch exists to
 * prevent, reachable through the route next to the one that was fixed.
 */
export function checkTextField(field: "title" | "systemPrompt", value: string): FieldProblem | null {
  // Bounded because both are stored and replayed: a title rides in the sidebar,
  // a system prompt rides in EVERY prompt of every later turn. 100,000-character
  // titles and 500,000-character system prompts were accepted before this.
  if (field === "title") {
    return value.length > MAX_TITLE_CHARS
      ? { error: `제목은 ${MAX_TITLE_CHARS}자를 넘을 수 없습니다.`, field }
      : null;
  }
  return value.length > MAX_SYSTEM_PROMPT_CHARS
    ? { error: `시스템 프롬프트는 ${MAX_SYSTEM_PROMPT_CHARS}자를 넘을 수 없습니다.`, field }
    : null;
}

export function checkSettings(
  raw: unknown,
): { ok: true; value?: Partial<ConversationSettings> } | { ok: false; problem: FieldProblem } {
  if (!raw || typeof raw !== "object") return { ok: true };
  // Checked, not spread: whatever is stored here is what goes to vLLM on every
  // later turn. The legacy "high" level still normalises to what the servers
  // take, and an unknown key is dropped rather than stored.
  const checked = validateSettingsPatch(raw as Record<string, unknown>);
  if (checked.ok) return { ok: true, value: checked.value };
  return { ok: false, problem: { error: checked.problem.message, field: checked.problem.field } };
}

export function checkEnabledTools(raw: unknown): { ok: true; value?: string[] } | { ok: false; problem: FieldProblem } {
  if (!Array.isArray(raw)) return { ok: true };
  // A tool list is walked once per turn, so it is bounded too.
  if (raw.length > MAX_ENABLED_TOOLS) {
    return { ok: false, problem: { error: `도구는 ${MAX_ENABLED_TOOLS}개를 넘을 수 없습니다.`, field: "enabledTools" } };
  }
  // Names only, and no longer than a tool name can be: anything else could
  // never resolve to a tool anyway.
  return {
    ok: true,
    value: (raw as unknown[]).filter(
      (name): name is string => typeof name === "string" && name.length > 0 && name.length <= MAX_TOOL_NAME_CHARS,
    ),
  };
}
