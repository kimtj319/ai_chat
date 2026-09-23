import { annotateForModel, citationSources } from "./citations.js";
import {
  resolveModel,
  streamChatCompletion,
  countPromptTokens,
  type ChatCompletionRequestBody,
  type PromptTokenCount,
} from "../vllm/client.js";
import type { VllmMessage } from "./historyBuilder.js";
import { buildTurnHistory } from "./historySummary.js";
import { appendNoToolsOverride } from "./systemPrompt.js";
import { fitToContextBudget, contextOverflowReserve, type BudgetFitResult } from "./contextBudget.js";
import {
  describeDeadline,
  NORMAL_MODE_SAFETY_TIMEOUT_MS,
  startTurnDeadline,
  streamWrapUpAnswer,
  type WrapUpReason,
} from "./reasoningDeadline.js";
import { reasoningParamsFor } from "./reasoningProfiles.js";
import { compactResearchContext, type CompactionResult } from "./contextCompaction.js";
import crypto from "node:crypto";
import { getTool, readAttachmentTool } from "../tools/index.js";
import { runTool } from "../tools/runner.js";
import { mcpToolsForOwner } from "../mcp/toolAdapter.js";
import type { ToolDefinition } from "../tools/types.js";
import { config } from "../config.js";
import { normalizeReasoningMode } from "../types.js";
import type { Conversation, ToolCallRecord, ToolResultRecord, MessageUsage } from "../types.js";

/** Retries after a context-length 400. Two is enough to walk the ladder down; more just burns time. */
const MAX_CONTEXT_RETRIES = 2;
/**
 * Model calls a turn may make with tools stopped: the tools-off request itself,
 * and the one extra round the finalAnswerForced nudge is allowed to trigger.
 */
const MAX_TOOLS_OFF_ROUNDS = 2;

export type ChatEvent =
  | { type: "reasoning"; delta: string }
  | { type: "content"; delta: string }
  | { type: "tool_call"; id: string; name: string; arguments: unknown }
  | { type: "tool_result"; id: string; name: string; ok: boolean; durationMs: number; preview: string }
  | { type: "usage"; promptTokens: number; completionTokens: number; totalTokens: number }
  // Informational, not a failure: the turn continues in a degraded form.
  | { type: "notice"; message: string }
  | { type: "error"; message: string };

export interface TurnResult {
  content: string;
  reasoning: string;
  toolCalls: ToolCallRecord[];
  toolResults: ToolResultRecord[];
  usage: MessageUsage;
  error?: string;
  notice?: string;
  contentPromotedFromReasoning: boolean;
}

interface PendingToolCall {
  id?: string;
  name?: string;
  argsText: string;
}

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
 * Sent as a trailing user message the moment a turn stops using tools, so the
 * next request writes the answer instead of announcing one.
 *
 * It goes at the tail rather than into the system prompt for the reason
 * systemPrompt.ts records: the same kind of override edited into system[0] came
 * back blank 15 times in 20 with enable_thinking:false, and 0 in 20 at the tail.
 *
 * The last sentence is what keeps the guard invisible. Without it the model
 * explains in prose that its tools were taken away, which is the very warning
 * this is trying not to show.
 */
const FINAL_ANSWER_INSTRUCTION =
  "도구를 더 이상 사용할 수 없습니다. 도구를 호출하지 말고, 지금까지 확보한 정보만으로 사용자의 질문에 대한 최종 답변을 지금 작성하세요. " +
  "확보한 정보가 부족하면 확인하지 못한 부분을 밝힌 뒤, 아는 범위에서 답하세요. 무엇을 하겠다는 예고가 아니라 답변 자체를 작성하세요. " +
  "도구 호출이 반복되었다거나 도구 사용이 중단되었다는 사정은 답변에 쓰지 말고, 질문에 대한 내용만 쓰세요.";

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.message === "aborted-by-user");
}

/**
 * Runs one full assistant turn against vLLM, including the tool-calling loop.
 * The loop is not capped at a round count: it ends when the model stops asking
 * for tools, the client aborts, or the context budget stops tools (every round
 * adds messages, so the prompt only grows and that ceiling is always reached).
 * Yields SSE-shaped events as they happen and, on completion (including a clean
 * abort), returns the final persisted-message payload via the generator's
 * return value.
 */
export async function* runConversationTurn(
  conversation: Conversation,
  ownerId: string,
  clientSignal: AbortSignal,
  /**
   * Fires when the person clicks "지금 답변하기" (answer now) on this turn.
   * Mode-agnostic — unlike the safety net below, it applies whether this turn
   * is "normal" or "external" — and separate from `clientSignal` on purpose:
   * aborting THAT tears the whole SSE response down (Stop), while this one
   * only cuts the current model call short so the turn can move to a wrap-up
   * answer instead (routes/conversations.ts tracks the two independently).
   */
  answerNowSignal: AbortSignal,
): AsyncGenerator<ChatEvent, TurnResult, void> {
  // "normal" has a safety-net ceiling on how long the model may think;
  // "external" waits to its own end. Either way, "지금 답변하기" can also stop
  // the turn early. Everything below works off the turn's signal, which
  // carries all three — shadowing the parameter is deliberate, so no call site
  // can accidentally keep using a signal that ignores them. `deadline.
  // stopReason()` tells them apart afterwards, and the wrap-up call uses
  // `clientSignal` directly.
  const reasoningMode = normalizeReasoningMode(conversation.settings.reasoningMode);
  const deadline = startTurnDeadline(
    clientSignal,
    reasoningMode === "normal" ? NORMAL_MODE_SAFETY_TIMEOUT_MS : null,
    answerNowSignal,
  );
  const signal = deadline.signal;
  // Why the round loop stopped early, if it did: "deadline" is the safety net,
  // "answer-now" is the person's own click. Neither is "Cancelled by client." —
  // both still want an answer, just from what the turn already has.
  let stopKind: "deadline" | "answer-now" | null = null;
  // Kicked off now rather than where it is actually used (further down, once
  // snapshotTools is built): it depends on nothing computed in this function —
  // not the model, not the history, not the conversation's own tool list — and
  // it never touches the network itself (mcp/discovery.ts's own cache; see the
  // comment where this is awaited). Awaiting it only where it is used meant a
  // turn paid for it AFTER resolveModel and buildTurnHistory had already run
  // one after another, even though all three could have overlapped. It never
  // rejects (mcpToolsForOwner's own contract), so holding the promise this
  // long adds no new failure mode.
  const mcpToolsPromise = mcpToolsForOwner(ownerId);
  // 그래도 아무도 기다리지 않는 채로 거절되는 일은 막아 둔다. 레지스트리 읽기는
  // 안에서 잡지만 그 뒤의 동기 코드(definitionsFor 등)까지 보장되지는 않고, 아래의
  // resolveModel·buildTurnHistory 가 먼저 던지면 이 promise 는 await 되지 않은 채
  // 남는다 — 그때 거절되면 unhandledRejection 이 된다. 결과는 바꾸지 않는다: 아래
  // await 는 여전히 같은 값을 받거나 같은 오류로 던진다.
  mcpToolsPromise.catch(() => {});
  // The conversation's chosen model decides which vLLM endpoint serves it;
  // an unknown/blank selection falls back to the first available model.
  const { model, endpoint, maxModelLen } = await resolveModel(conversation.model);
  // Asking for a model that is not in the catalogue used to be answered by a
  // different model without a word — the conversation still displayed the name
  // it was pinned to, and a single typo in a model id was enough. The fallback
  // stays, because conversations pinned to a model that has since been unserved
  // would otherwise start failing outright; what changes is that the reader is
  // told who actually answered.
  const requestedModel = (conversation.model ?? "").trim();
  const substitutedModel = requestedModel && requestedModel !== model ? model : null;
  // Attachments are read and base64-encoded here, once for the whole turn.
  // Older turns are folded into a stored summary here, once, when the window is
  // full — instead of the budget ladder dropping them, and saying so, on every
  // later turn. Never throws: any failure returns the history that
  // buildHistoryMessages would have built.
  const history = await buildTurnHistory({
    conversation,
    ownerId,
    model,
    endpoint,
    contextWindow: maxModelLen,
    signal,
  });
  let workingMessages: VllmMessage[] = history.messages;
  // The turn's starting context: system prompt + prior turns + the triggering
  // user message. Compaction rebuilds around it, so it has to be a copy — the
  // loop below pushes onto workingMessages, which starts out as the same array.
  const baseMessages: VllmMessage[] = workingMessages.slice();
  // Messages the budget ladder may never drop, held by identity rather than by
  // position. The ladder's positional rule ("keep the last user message
  // onwards") is wrong the moment a compaction has run, because the rebuilt list
  // is
  //   system | user(the question) | assistant(interim report) | user(continue) | …
  // so the last user message is the synthetic continuation instruction: the
  // first drop took the question and the second took the report, leaving the
  // model told to continue from a report that was gone (measured 2026-09-11).
  // Compaction adds its report and continuation here as it creates them.
  const protectedMessages = new Set<VllmMessage>();
  const triggeringUserMessage = baseMessages[baseMessages.length - 1];
  if (triggeringUserMessage?.role === "user") protectedMessages.add(triggeringUserMessage);
  // The summary stands in for every turn it covers, so the ladder must never
  // drop it: it sits where the oldest turn used to, and losing it would lose the
  // whole early conversation in one step.
  if (history.summaryMessage) protectedMessages.add(history.summaryMessage);

  /**
   * THE TURN'S TOOLS, TAKEN ONCE.
   *
   * One snapshot — builtins plus whatever MCP servers this owner has switched
   * on — serves both the `tools` array on the wire and the per-call lookup
   * below. It is built here, before the loop, and never rebuilt: see the
   * comment on `body.tools` about the 33s-versus-2.3s prefill recompute when
   * the array changed mid-turn. Two lists that could drift apart would be the
   * same bug with extra steps, so the map below IS the array.
   *
   * The MCP half comes from the discovery cache only (mcp/discovery.ts) and
   * never from the network: a turn must not wait on someone else's server, and
   * a tool list that arrived mid-turn would change the array.
   */
  const snapshotTools: ToolDefinition[] = (conversation.enabledTools ?? [])
    // read_attachment is not a tool the user toggles: it is added below, and
    // only when there is an attachment it could read.
    .filter((name) => name !== readAttachmentTool.name)
    .map((name) => getTool(name))
    .filter((t): t is ToolDefinition => Boolean(t));
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
  // Filtered by the same enabledTools list as every builtin, because adopting a
  // server in the library is not the same as wanting its tools in THIS
  // conversation: the composer's picker writes these names into that list, and
  // without this filter its toggles would do nothing and every adopted tool's
  // schema would ride in every prompt whether or not anyone wanted it.
  //
  // Awaited here rather than fetched here — it was already kicked off above,
  // before resolveModel and buildTurnHistory, and has been running alongside
  // them since. On an ordinary turn this await resolves immediately because
  // the promise settled minutes ago (mcp/discovery.ts's cache); the only turn
  // that ever actually waits here is the very first one after a server was
  // just added, which used to wait behind resolveModel and buildTurnHistory
  // too and now waits behind whichever of the three is actually slowest.
  const enabledNames = new Set(conversation.enabledTools ?? []);
  const mcpTools = await mcpToolsPromise;
  snapshotTools.push(...mcpTools.tools.filter((t) => enabledNames.has(t.name)));
  /**
   * The same objects the array was built from. Resolving a call through this
   * rather than through getTool() is what stops the model reaching a tool this
   * turn was never offered — including an MCP tool from a server that has since
   * been disabled, whose name a transcript still contains.
   */
  const turnTools = new Map(snapshotTools.map((t) => [t.name, t]));

  const tools =
    snapshotTools.length > 0
      ? snapshotTools.map((t) => ({
          type: "function" as const,
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }))
      : undefined;

  const totalUsage: MessageUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let content = "";
  let reasoning = "";
  const allToolCalls: ToolCallRecord[] = [];
  /** tool name + arguments → how many times this turn has already asked for it. */
  const toolCallSignatures = new Map<string, number>();
  let loopGuardTripped = false;
  const allToolResults: ToolResultRecord[] = [];
  let errorNote: string | undefined;
  let aborted = false;
  // Sticky for the rest of the turn: once the context forced tools off, letting
  // them back on would only walk into the same ceiling again — and it is what
  // makes an uncapped loop terminate.
  let toolsStopped = false;
  // Compaction resets the prompt to a small size, so on its own it could cycle
  // forever. contextMaxCompactions is the bound that keeps the uncapped loop
  // terminating: once it is spent the prompt only grows again, crosses
  // contextToolStopRatio, the ladder stops tools, and the tools-off request
  // below ends the turn.
  let compactions = 0;
  // Model calls already made with tools stopped. Termination must not rest on
  // the tools array going missing any more — the schemas stay on the wire and
  // only tool_choice changes — so this is the explicit bound: a tools-off
  // request is the last call of the turn, plus at most the one finalAnswerForced
  // nudge below.
  let toolsOffRounds = 0;
  // Set once the model is told to answer without tools, so that nudge can never
  // repeat and spin the loop.
  let finalAnswerForced = false;
  // Turned off for the rest of the turn after a failed summarisation: retrying
  // it every round would charge each one its latency for the same failure.
  let compactionAvailable = config.contextCompactRatio > 0;
  let extraReserve = 0;
  let contextRetries = 0;
  const notices: string[] = [];
  const seenNotices = new Set<string>();
  // TOOL_MAX_ROUNDS is an escape hatch only; 0 (the default) means unlimited.
  const maxRounds = config.toolMaxRounds > 0 ? config.toolMaxRounds : Number.POSITIVE_INFINITY;

  // The same notice can be produced every round (the ladder re-runs each time);
  // the user only needs to be told once.
  function* noticeEvent(message: string): Generator<ChatEvent, void, void> {
    if (seenNotices.has(message)) return;
    seenNotices.add(message);
    notices.push(message);
    yield { type: "notice", message };
  }

  // An MCP server that is down or quarantined is a degraded turn, not a failed
  // one: the model answers with the tools that are left, and the user is told
  // which server is missing.
  for (const message of mcpTools.notices) yield* noticeEvent(message);

  if (substitutedModel) {
    yield* noticeEvent(
      `요청한 모델 ${requestedModel}을(를) 찾지 못해 ${substitutedModel}이(가) 답변했습니다. 모델 목록에서 다시 선택해 주세요.`,
    );
  }

  // Only on the turn that actually summarised: from the next turn on the stored
  // summary is just part of the history, and there is nothing to announce.
  if (history.notice) yield* noticeEvent(history.notice);

  for (let round = 1; !aborted; round++) {
    // Stop, the safety net, or "지금 답변하기" may have arrived while the
    // previous round's tools were running. Check before the budget step, which
    // costs a /tokenize round-trip of its own.
    if (signal.aborted) {
      const reason = deadline.stopReason();
      if (reason) {
        stopKind = reason;
        break;
      }
      aborted = true;
      errorNote = "Cancelled by client.";
      break;
    }
    if (round > maxRounds && !toolsStopped) {
      toolsStopped = true;
      yield* noticeEvent(`도구 호출 ${maxRounds}회에 도달하여 도구 사용을 중단하고 답변을 생성합니다.`);
    }
    // Belt and braces on termination. The two `continue`s below are bounded
    // (finalAnswerForced, MAX_CONTEXT_RETRIES) and the tool-running path is
    // unreachable once tools are stopped, so this should never fire — but with
    // the schemas now staying in the request, nothing else structurally prevents
    // a round from following a tools-off one, and an uncapped loop must not
    // depend on "should never".
    if (toolsOffRounds >= MAX_TOOLS_OFF_ROUNDS) break;
    // The round's single /tokenize count, and what a compaction has to report
    // once the ladder has measured the rebuilt list. Both are per-round state.
    let preCount: PromptTokenCount | undefined;
    let compactionLog:
      | { beforeTokens: number; messagesBefore: number; compacted: CompactionResult; startedAt: number }
      | undefined;
    // Compaction runs before the ladder, because the ladder's first step is to
    // replace an oversized tool result with a 600-char excerpt — which throws
    // the research away. Summarising what has been gathered frees the same
    // space and keeps the findings (chat/contextCompaction.ts).
    // Skipped once the model has started writing its answer: replacing the
    // context underneath it makes it start the answer over, and the user would
    // see two half-answers concatenated.
    if (
      compactionAvailable &&
      compactions < config.contextMaxCompactions &&
      !toolsStopped &&
      tools &&
      content.trim().length === 0 &&
      // Nothing to compact below two tool results — a summary of one result is
      // not smaller than the result. Counted on this turn's own results, not on
      // workingMessages: when the bulk comes from earlier turns instead, the
      // rebuild keeps those verbatim, so a summary would cost ~48s and free
      // almost nothing. The ladder's drop-oldest-turns step handles that case.
      allToolResults.length >= 2
    ) {
      const messagesBefore = workingMessages.length;
      const startedAt = Date.now();
      try {
        // The one /tokenize call of a round that does not compact: the ladder
        // below is handed this exact count instead of repeating it (mean 2,769ms
        // per call on a 232k-token list, so the duplicate was ~2.8s of silence
        // every round).
        const before = await countPromptTokens(endpoint, model, workingMessages, tools, signal);
        preCount = before;
        const window = maxModelLen ?? before.maxModelLen;
        if (window !== null && before.tokens > window * config.contextCompactRatio) {
          const compacted = await compactResearchContext({
            endpoint,
            model,
            messages: workingMessages,
            baseMessages,
            contextWindow: maxModelLen,
            signal,
          });
          // Only the list sent to vLLM is replaced: allToolCalls/allToolResults
          // are what the UI shows for this turn, and the user must still see
          // every call that was made.
          workingMessages = compacted.messages;
          for (const message of compacted.protectedMessages) protectedMessages.add(message);
          compactions++;
          // `before` no longer describes this list, so the ladder must measure
          // the rebuilt one — and its count, being the prompt actually sent, is
          // what the log line below reports.
          preCount = undefined;
          compactionLog = { beforeTokens: before.tokens, messagesBefore, compacted, startedAt };
        }
      } catch (err) {
        if (isAbortError(err)) {
          const reason = deadline.stopReason();
          if (reason) {
            stopKind = reason;
            break;
          }
          aborted = true;
          errorNote = "Cancelled by client.";
          break;
        }
        // Never worse than before compaction existed: leave the messages alone
        // and let the ladder degrade this round the way it always has.
        console.warn(`[compact] round ${round} failed, falling back to the context budget ladder:`, err);
        compactionAvailable = false;
      }
    }

    const { seed, temperature, topP, maxTokens, presencePenalty, frequencyPenalty } = conversation.settings;
    // Measure the prompt against the real window before every request: the 400
    // that loses the whole turn is otherwise only discovered by hitting it.
    // Wrapped for the same reason the compaction step above is: this makes its
    // own /tokenize round-trip, and the safety net or an "answer now" click can
    // land mid-call just as easily as during the main model request.
    let fit: BudgetFitResult;
    try {
      fit = await fitToContextBudget({
        endpoint,
        model,
        messages: workingMessages,
        // Always the full schema set, stopped or not: they are on the wire either
        // way now, so measuring without them would under-count the request by the
        // ~500-900 tokens they occupy.
        ...(tools ? { tools } : {}),
        ...(preCount ? { preCount } : {}),
        protectedMessages,
        desiredMaxTokens: maxTokens,
        contextWindow: maxModelLen,
        extraReserve,
        signal,
      });
    } catch (err) {
      if (isAbortError(err)) {
        const reason = deadline.stopReason();
        if (reason) {
          stopKind = reason;
          break;
        }
        aborted = true;
        errorNote = "Cancelled by client.";
        break;
      }
      throw err;
    }
    workingMessages = fit.messages;
    if (fit.toolsStopped) toolsStopped = true;
    for (const message of fit.notices) yield* noticeEvent(message);
    if (compactionLog) {
      const { beforeTokens, messagesBefore, compacted, startedAt } = compactionLog;
      console.log(
        `[compact] round ${round}: prompt ${beforeTokens} -> ${fit.promptTokens} tokens, ` +
          `messages ${messagesBefore} -> ${workingMessages.length}, ` +
          `summary call ${compacted.usage.promptTokens} in / ${compacted.usage.completionTokens} out, ` +
          `finish_reason=${compacted.finishReason}, ${Date.now() - startedAt}ms`,
      );
    }

    // Sticky across rounds: the ladder is re-run from scratch every round and
    // only sees this one, so a round that measures smaller must not be allowed
    // to offer tools again after an earlier round stopped them.
    const toolsOffered = Boolean(fit.tools) && !toolsStopped;
    // A request the model cannot call tools from must also stop telling it that
    // it has them, or it answers with tool-call syntax instead of an answer.
    const outgoingMessages = toolsOffered ? workingMessages : appendNoToolsOverride(workingMessages);

    // Proof rather than assumption. This hash has to be IDENTICAL on every
    // round of the turn; the moment it moves, the prompt's prefix has changed
    // and the next request pays a full prefill recompute. Recomputed from the
    // array each round on purpose — hashing a value cached outside the loop
    // would prove nothing.
    if (config.mcpDebugToolsHash) {
      const toolsHash = tools ? crypto.createHash("sha256").update(JSON.stringify(tools)).digest("hex") : "none";
      console.log(
        `[toolloop] round ${round} tools sha256=${toolsHash} count=${tools?.length ?? 0} ` +
          `tool_choice=${tools ? (toolsOffered ? "auto" : "none") : "-"}`,
      );
    }

    const body: ChatCompletionRequestBody = {
      model,
      messages: outgoingMessages,
      stream: true,
      stream_options: { include_usage: true },
      temperature,
      top_p: topP,
      max_tokens: fit.maxTokens,
      presence_penalty: presencePenalty,
      frequency_penalty: frequencyPenalty,
      ...(seed !== null ? { seed } : {}),
      ...reasoningParamsFor(conversation, model),
      // The same `tools` array, byte for byte, on every request of the turn:
      // stopping tools switches tool_choice to "none" instead of removing them.
      // Removing them changed the front of the prompt and cost a full prefill
      // recompute (33s versus 2.3s on a 189k-token prompt), and the degraded
      // answer came back blank about half the time in that shape — see
      // systemPrompt.ts for the counts.
      ...(tools ? { tools, tool_choice: toolsOffered ? ("auto" as const) : ("none" as const) } : {}),
    };

    const pendingToolCalls = new Map<number, PendingToolCall>();
    let finishReason: string | null = null;
    let roundContent = "";

    try {
      const stream = await streamChatCompletion(body, signal, endpoint);
      for await (const chunk of stream) {
        if (signal.aborted) throw new Error("aborted-by-user");
        const choice = chunk.choices?.[0];
        if (chunk.usage) {
          totalUsage.promptTokens += chunk.usage.prompt_tokens ?? 0;
          totalUsage.completionTokens += chunk.usage.completion_tokens ?? 0;
          totalUsage.totalTokens += chunk.usage.total_tokens ?? 0;
        }
        if (!choice) continue;
        const delta = choice.delta ?? {};
        const reasoningDelta = delta.reasoning ?? delta.reasoning_content;
        if (reasoningDelta) {
          reasoning += reasoningDelta;
          yield { type: "reasoning", delta: reasoningDelta };
        }
        if (delta.content) {
          content += delta.content;
          roundContent += delta.content;
          yield { type: "content", delta: delta.content };
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const fragment of delta.tool_calls) {
            const index = fragment.index ?? 0;
            const existing = pendingToolCalls.get(index) ?? { argsText: "" };
            if (fragment.id) existing.id = fragment.id;
            if (fragment.function?.name) existing.name = fragment.function.name;
            if (fragment.function?.arguments) existing.argsText += fragment.function.arguments;
            pendingToolCalls.set(index, existing);
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    } catch (err) {
      if (isAbortError(err)) {
        // The safety net or an "answer now" click stopping the model is not the
        // user stopping it: the turn carries on below and writes an answer from
        // what it has.
        const reason = deadline.stopReason();
        if (reason) {
          stopKind = reason;
          break;
        }
        aborted = true;
        errorNote = "Cancelled by client.";
        break;
      }
      // The budget above should prevent this, but any drift between /tokenize
      // and the server's own count would still lose the turn. Reserve what the
      // error reports and re-run the ladder harder instead of failing.
      const reserve = contextOverflowReserve(err, fit.maxTokens, maxModelLen);
      if (reserve !== null && contextRetries < MAX_CONTEXT_RETRIES) {
        contextRetries++;
        extraReserve += reserve;
        yield* noticeEvent("컨텍스트 한도를 초과하여 이전 내용을 줄이고 다시 시도합니다.");
        continue;
      }
      throw err;
    }
    // Counted only once the call has actually completed: a context-400 retry
    // above re-runs the round without having asked the model anything.
    if (!toolsOffered) toolsOffRounds++;

    if (finishReason !== "tool_calls" || pendingToolCalls.size === 0) {
      break; // natural finish (stop/length/etc.)
    }

    // tool_choice was "none" (or the conversation has no tools at all), yet the
    // model emitted a tool call anyway: vLLM's parser still picks up the
    // tool-call syntax the transcript taught it. Breaking straight out here
    // ended the turn with no content and no error at all (measured: empty
    // assistant message). Say plainly that tools are gone and give it one chance
    // to write the answer; `finalAnswerForced` keeps that to a single extra
    // round so the loop still terminates.
    if (!toolsOffered) {
      if (finalAnswerForced || content.trim().length > 0) break;
      finalAnswerForced = true;
      workingMessages = [...workingMessages, { role: "user", content: FINAL_ANSWER_INSTRUCTION }];
      continue;
    }

    const roundToolCalls: ToolCallRecord[] = [];
    const roundToolResults: ToolResultRecord[] = [];
    for (const [index, pending] of [...pendingToolCalls.entries()].sort((a, b) => a[0] - b[0])) {
      const id = pending.id ?? `call_${index}`;
      const name = pending.name ?? "unknown";
      let parsedArgs: unknown = {};
      let parseError: string | undefined;
      try {
        parsedArgs = pending.argsText.trim().length > 0 ? JSON.parse(pending.argsText) : {};
      } catch (err) {
        parseError = `Failed to parse tool arguments as JSON: ${err instanceof Error ? err.message : String(err)}`;
      }
      const callRecord: ToolCallRecord = { id, name, arguments: parseError ? pending.argsText : parsedArgs };
      allToolCalls.push(callRecord);
      roundToolCalls.push(callRecord);
      yield { type: "tool_call", id, name, arguments: callRecord.arguments };

      // Identical to something already run this turn, or simply too many: the
      // call is refused rather than executed, and the refusal goes back to the
      // model as the tool's own result so it can see why and answer instead.
      const signature = `${name}:${parseError ? pending.argsText : JSON.stringify(parsedArgs)}`;
      const seen = (toolCallSignatures.get(signature) ?? 0) + 1;
      toolCallSignatures.set(signature, seen);
      const repeating = seen > MAX_IDENTICAL_TOOL_CALLS;
      const tooManyCalls = allToolCalls.length > MAX_TOOL_CALLS_PER_TURN;

      let resultRecord: ToolResultRecord;
      if (repeating || tooManyCalls) {
        // Nothing about this reaches the user any more, so this line is the only
        // trace of why a turn stopped researching. Once per turn: by the second
        // trip the flag is already set.
        if (!loopGuardTripped) {
          console.warn(
            `[toolloop] ${repeating ? `identical call x${seen}: ${signature.slice(0, 200)}` : `${allToolCalls.length} calls this turn`}` +
              ` — tools stopped, answering from what the turn already has (conversation ${conversation.id}, round ${round})`,
          );
        }
        loopGuardTripped = true;
        resultRecord = {
          id,
          name,
          ok: false,
          // A statement, not an instruction. What to do instead arrives below as
          // a user message, which is where the model actually acts on it.
          error: repeating
            ? `같은 도구를 같은 인자로 ${MAX_IDENTICAL_TOOL_CALLS}번 넘게 호출하여 이 호출은 실행하지 않았습니다.`
            : `이번 턴의 도구 호출이 ${MAX_TOOL_CALLS_PER_TURN}회를 넘어 이 호출은 실행하지 않았습니다.`,
          durationMs: 0,
        };
      } else if (parseError) {
        resultRecord = { id, name, ok: false, error: parseError, durationMs: 0 };
      } else {
        // The turn's own snapshot, not the global registry: a tool that was
        // not offered this turn cannot be reached by asking for it by name.
        const tool = turnTools.get(name);
        if (!tool) {
          resultRecord = { id, name, ok: false, error: `Unknown tool: ${name}`, durationMs: 0 };
        } else {
          // The context is what scopes read_attachment to this conversation's
          // own files; every other tool ignores it.
          const run = await runTool(tool, parsedArgs, { ownerId, conversationId: conversation.id });
          resultRecord = { id, name, ok: run.ok, result: run.result, error: run.error, durationMs: run.durationMs };
        }
      }
      allToolResults.push(resultRecord);
      roundToolResults.push(resultRecord);
      const preview = JSON.stringify(resultRecord.ok ? resultRecord.result : { error: resultRecord.error }).slice(0, 500);
      yield { type: "tool_result", id, name, ok: resultRecord.ok, durationMs: resultRecord.durationMs, preview };
    }

    workingMessages.push({
      role: "assistant",
      content: roundContent,
      tool_calls: roundToolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments) },
      })),
    });
    // 문서 검색 결과에는 인용 번호(ref)를 달아 보낸다. 번호는 이 턴 전체를 센
    // 것이라, 앞 라운드에서 나온 단락은 그때 번호를 그대로 받는다 — 화면은 저장된
    // 도구 결과로 같은 번호를 다시 세어 "[n]" 을 링크로 만든다(chat/citations.ts).
    const sources = citationSources(allToolResults);
    for (const tr of roundToolResults) {
      workingMessages.push({
        role: "tool",
        tool_call_id: tr.id,
        name: tr.name,
        content: JSON.stringify(tr.ok ? annotateForModel(tr, sources) : { error: tr.error ?? "tool execution failed" }),
      });
    }

    // A repeat (or the per-turn ceiling) ends the research here, and the user is
    // told nothing about it: the answer itself is the whole output. This sits
    // AFTER the append above on purpose — every tool_call of this round already
    // has its tool result there, so the message list stays contract-complete,
    // and the next round goes out with tool_choice:"none" plus this instruction.
    // That round IS the wrap-up: same budget ladder, same context-400 retry and
    // same no-tools override as every other stopped round, for free.
    if (loopGuardTripped && !toolsStopped) {
      toolsStopped = true;
      workingMessages.push({ role: "user", content: FINAL_ANSWER_INSTRUCTION });
    }
  }

  deadline.dispose();

  if (stopKind) {
    const wrapUpReason: WrapUpReason =
      stopKind === "deadline" ? { kind: "deadline", deadlineMs: NORMAL_MODE_SAFETY_TIMEOUT_MS } : { kind: "answer-now" };
    yield* noticeEvent(
      stopKind === "deadline"
        ? `추론이 ${describeDeadline(NORMAL_MODE_SAFETY_TIMEOUT_MS)}를 넘어, 그때까지 모은 정보로 답변을 정리했습니다.`
        : "'지금 답변하기' 요청에 따라, 그때까지 모은 정보로 답변을 정리했습니다.",
    );
    try {
      for await (const delta of wrapUpWithFallback(
        {
          model,
          endpoint,
          reasoning,
          temperature: conversation.settings.temperature,
          topP: conversation.settings.topP,
          reason: wrapUpReason,
          clientSignal,
        },
        messagesForWrapUp(workingMessages),
        baseMessages,
      )) {
        content += delta;
        yield { type: "content", delta };
      }
    } catch (err) {
      if (isAbortError(err)) {
        aborted = true;
        errorNote = "Cancelled by client.";
      } else {
        throw err;
      }
    }
  }

  // A turn that ends with no answer and a page of reasoning used to publish the
  // reasoning itself. Measured on wise-lloa-max, which puts its whole working-out
  // in reasoning_content and never writes a body: two of four turns were stored
  // as English stream-of-thought breaking off mid-sentence inside a tool-call
  // JSON fragment — content and reasoning byte-identical at 1,530 and 1,195
  // characters, with no error and no notice to mark them as anything but a real
  // answer. The model had done the work; it just never wrote it down, so ask it
  // to. The promotion below stays as the last resort if this produces nothing.
  if (!stopKind && !aborted && content.trim().length === 0 && reasoning.trim().length > 0) {
    try {
      for await (const delta of wrapUpWithFallback(
        {
          model,
          endpoint,
          reasoning,
          temperature: conversation.settings.temperature,
          topP: conversation.settings.topP,
          reason: { kind: "empty-answer" },
          clientSignal,
        },
        messagesForWrapUp(workingMessages),
        baseMessages,
      )) {
        content += delta;
        yield { type: "content", delta };
      }
    } catch (err) {
      if (isAbortError(err)) {
        aborted = true;
        errorNote = "Cancelled by client.";
      } else {
        // Never rethrow: the turn still has its reasoning, and publishing that
        // is worse than this call but far better than losing the turn.
        console.warn("[toolloop] empty-answer wrap-up failed; falling back to the reasoning text:", err);
      }
    }
  }

  yield {
    type: "usage",
    promptTokens: totalUsage.promptTokens,
    completionTokens: totalUsage.completionTokens,
    totalTokens: totalUsage.totalTokens,
  };

  let finalContent = content;
  let contentPromotedFromReasoning = false;
  if (finalContent.trim().length === 0 && reasoning.trim().length > 0) {
    finalContent = reasoning;
    contentPromotedFromReasoning = true;
  }

  if (errorNote) {
    yield { type: "error", message: errorNote };
  }

  return {
    content: finalContent,
    reasoning,
    toolCalls: allToolCalls,
    toolResults: allToolResults,
    usage: totalUsage,
    error: errorNote,
    notice: notices.length > 0 ? notices.join("\n") : undefined,
    contentPromotedFromReasoning,
  };
}

/**
 * 마무리 답변(지금 답변하기·안전 상한·빈 답변 복구)에 넘길 이력.
 *
 * 예전에는 도구 루프가 시작되기 **전**의 이력(baseMessages)을 넘겼다. 그래서
 * 마무리 답변은 이번 턴의 도구 결과를 한 번도 보지 못했고, 도구를 다섯 번 부른
 * 뒤에 "지금 답변하기" 를 누르면 "요청하신 도구 호출을 아직 수행하지 않았습니다"
 * 라고 답했다(2026-09-23 운영 서버 실측). 사용자가 원한 것은 "그 시점까지 모은 정보로
 * 답하라" 이고, 모은 정보의 대부분이 바로 그 도구 결과다.
 *
 * 끝에 결과가 붙지 않은 tool_calls 가 남아 있으면 뗀다. 도구 호출과 결과는 실행이
 * 끝난 뒤 한꺼번에 쌓이므로 보통은 짝이 맞지만, 짝 없는 tool_calls 는 서버가 400 으로
 * 거절하므로 한 줄로 막아 둔다.
 */
function messagesForWrapUp(messages: VllmMessage[]): VllmMessage[] {
  const out = messages.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!;
    if (m.role !== "assistant" || !m.tool_calls || m.tool_calls.length === 0) continue;
    const answered = new Set(out.slice(i + 1).filter((x) => x.role === "tool").map((x) => x.tool_call_id));
    if (m.tool_calls.every((tc) => answered.has(tc.id))) break;
    out.splice(i); // 짝 없는 호출부터 끝까지 버린다
    break;
  }
  return out;
}

/**
 * 모은 결과까지 넣어 마무리 답변을 시도하고, **첫 글자가 나오기 전에** 실패하면
 * 도구 결과 없이 한 번 더 시도한다. 결과를 넣으면 컨텍스트가 넘칠 수 있는데, 그때
 * 아무 답도 없는 것보다 추론만으로라도 답하는 편이 낫다. 이미 글자가 나간 뒤의
 * 실패는 되돌릴 수 없으므로 그대로 던진다. 사용자가 끊은 것도 그대로 던진다.
 */
async function* wrapUpWithFallback(
  args: Omit<Parameters<typeof streamWrapUpAnswer>[0], "baseMessages">,
  withResults: VllmMessage[],
  withoutResults: VllmMessage[],
): AsyncGenerator<string, void, void> {
  let yielded = false;
  try {
    for await (const delta of streamWrapUpAnswer({ ...args, baseMessages: withResults })) {
      yielded = true;
      yield delta;
    }
  } catch (err) {
    if (yielded || isAbortError(err)) throw err;
    console.warn("[chat] 도구 결과를 넣은 마무리 답변이 실패해, 결과 없이 다시 시도합니다:", err);
    yield* streamWrapUpAnswer({ ...args, baseMessages: withoutResults });
  }
}
