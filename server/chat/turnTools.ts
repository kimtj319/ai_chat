import { getTool, readAttachmentTool } from "../tools/index.js";
import { BROWSER_TOOLS, isBrowserTool } from "../tools/browser.js";
import { SCHEDULE_TOOLS } from "../tools/schedule.js";
import { createDocumentTool, wantsDownloadableFile } from "../tools/createDocument.js";
import type { ToolDefinition } from "../tools/types.js";
import type { ChatToolDef } from "../vllm/client.js";
import type { Conversation } from "../types.js";

/**
 * How many times one turn may ask for the same tool with the same arguments
 * before the loop stops running it.
 *
 * Measured, not guessed: a 27B model asked a four-part question called
 * regex_test 267 times with the same input and produced no answer at all in
 * twenty minutes. TOOL_MAX_ROUNDS defaults to 0, which means "unlimited"
 * because the context budget is supposed to end the loop instead — and it
 * would have, eventually, except that a repeated call with a tiny result grows
 * the prompt so slowly that a 262k window swallows hundreds of them.
 *
 * A repeat is not work. Three is enough to allow a genuine retry after a
 * transient failure and short enough that nobody waits through a loop.
 */
const MAX_IDENTICAL_TOOL_CALLS = 3;

/**
 * Backstop for a loop that varies its arguments just enough to slip past the
 * check above. Well clear of any real turn seen here: the same question that
 * span 267 times was answered by three other models in 5 to 8 calls.
 */
const MAX_TOOL_CALLS_PER_TURN = 40;

/**
 * 크롬을 다루는 턴의 한도. 페이지 하나를 다루는 데 읽기·스크롤·클릭이 여러 번 들고,
 * 같은 "아래로 스크롤" 을 연달아 부르는 것도 정상이다. 그래도 끝없이 돌지는 않게 묶는다.
 */
const MAX_IDENTICAL_BROWSER_CALLS = 8;
const MAX_TOOL_CALLS_PER_BROWSER_TURN = 80;

export interface TurnTools {
  /**
   * The same objects the array was built from. Resolving a call through this
   * rather than through getTool() is what stops the model reaching a tool this
   * turn was never offered — including an MCP tool from a server that has since
   * been disabled, whose name a transcript still contains.
   */
  turnTools: Map<string, ToolDefinition>;
  /** The `tools` array sent on every request of the turn; undefined when there are none. */
  tools: ChatToolDef[] | undefined;
  /** Tool calls the whole turn may make before the rest are refused. */
  maxToolCalls: number;
  /** Identical calls (same tool, same arguments) allowed before the next one is refused. */
  identicalLimit(name: string): number;
}

/**
 * THE TURN'S TOOLS, TAKEN ONCE.
 *
 * One snapshot — builtins plus whatever MCP servers this owner has switched
 * on — serves both the `tools` array on the wire and the per-call lookup in
 * the loop. It is built before the loop and never rebuilt: see the comment on
 * `body.tools` in toolLoop.ts about the 33s-versus-2.3s prefill recompute when
 * the array changed mid-turn. Two lists that could drift apart would be the
 * same bug with extra steps, so the map IS the array.
 *
 * The MCP half comes from the discovery cache only (mcp/discovery.ts) and
 * never from the network: a turn must not wait on someone else's server, and
 * a tool list that arrived mid-turn would change the array.
 */
export function buildTurnTools(conversation: Conversation, mcpTools: ToolDefinition[], browserControl: boolean): TurnTools {
  const snapshotTools: ToolDefinition[] = (conversation.enabledTools ?? [])
    // read_attachment is not a tool the user toggles: it is added below, and
    // only when there is an attachment it could read.
    .filter((name) => name !== readAttachmentTool.name)
    .map((name) => getTool(name))
    .filter((t): t is ToolDefinition => Boolean(t))
    // 파일로 받겠다는 말이 이번 질문에 있을 때만 — "정리해서 작성해줘" 에 PDF 를 만들던 것
    // (tools/createDocument.ts wantsDownloadableFile). 보통 턴에는 빠져 있어 도구 목록(프롬프트
    // 앞부분)이 턴마다 바뀌지 않는다.
    .filter((t) => t.name !== createDocumentTool.name || wantsDownloadableFile(lastUserText(conversation)));
  // Offered only when this conversation actually holds a text attachment whose
  // body was left out of the prompt. Otherwise it is a schema with nothing to
  // read, which the model calls anyway when a question mentions a file.
  if (conversation.messages.some((m) => m.attachments?.some((a) => a.kind === "text" && !a.inlined))) {
    snapshotTools.push(readAttachmentTool);
  }
  // Already sorted by (slug, toolName) by the adapter, so the array's bytes are
  // the same for the same set of servers. Never throws: an unreachable server
  // contributes no tools and a notice instead.
  //
  // Every tool of a server switched on in 커넥터 goes in — the switch is the
  // whole choice. There used to be a second, per-conversation choice in the
  // composer's picker (MCP names in enabledTools); users switched a server on
  // and then found the model ignoring it because nothing was ticked in that
  // conversation. MCP names still stored there from that time are ignored.
  snapshotTools.push(...mcpTools);
  // 크롬 도구는 대화 설정이 아니라 이 턴을 보낸 브라우저가 정한다(tools/browser.ts).
  if (browserControl) {
    snapshotTools.push(...BROWSER_TOOLS);
    // "11시에 …해 줘" 는 크롬을 켠 사람이 가장 흔히 하는 말이다. 도구 설정에서 예약 도구를
    // 켜 두지 않은 대화(이 기능 이전에 만든 대화 등)에서도 크롬 제어와 함께 쓸 수 있게 싣는다.
    for (const tool of SCHEDULE_TOOLS) if (!snapshotTools.some((t) => t.name === tool.name)) snapshotTools.push(tool);
  }

  return {
    turnTools: new Map(snapshotTools.map((t) => [t.name, t])),
    tools:
      snapshotTools.length > 0
        ? snapshotTools.map((t) => ({
            type: "function" as const,
            function: { name: t.name, description: t.description, parameters: t.parameters },
          }))
        : undefined,
    maxToolCalls: browserControl ? MAX_TOOL_CALLS_PER_BROWSER_TURN : MAX_TOOL_CALLS_PER_TURN,
    identicalLimit: (name) => (isBrowserTool(name) ? MAX_IDENTICAL_BROWSER_CALLS : MAX_IDENTICAL_TOOL_CALLS),
  };
}

function lastUserText(conversation: Conversation): string {
  for (let i = conversation.messages.length - 1; i >= 0; i--) {
    const message = conversation.messages[i]!;
    if (message.role === "user") return typeof message.content === "string" ? message.content : "";
  }
  return "";
}

/** "mcp__alphavantage__GLOBAL_QUOTE" → "alphavantage(GLOBAL_QUOTE)", builtins as they are. */
export function displayToolName(name: string): string {
  const match = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  return match ? `${match[1]}(${match[2]})` : name;
}
