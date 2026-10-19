import { modelAccessForOwner, endpointForOwner } from "../vllm/access.js";
import { citationSources } from "./citations.js";
import {
  resolveModel,
  modelQueueAhead,
  streamChatCompletion,
  countPromptTokens,
  type ChatCompletionRequestBody,
  type PromptTokenCount,
  thinkingBudgetRefused,
  type VllmStreamChunk,
} from "../vllm/client.js";
import { toolResultMessage, type VllmMessage } from "./historyBuilder.js";
import { buildTurnHistory } from "./historySummary.js";
import { appendNoToolsOverride } from "./systemPrompt.js";
import { fitToContextBudget, contextOverflowReserve, type BudgetFitResult } from "./contextBudget.js";
import {
  describeDeadline,
  isAbortError,
  messagesForWrapUp,
  NORMAL_MODE_SAFETY_TIMEOUT_MS,
  startTurnDeadline,
  wrapUpWithFallback,
  type WrapUpReason,
} from "./reasoningDeadline.js";
import { reasoningParamsFor } from "./reasoningProfiles.js";
import { compactResearchContext, type CompactionResult } from "./contextCompaction.js";
import { withCompactionEvents, type CompactionEvent } from "./compactionProgress.js";
import { BudgetLeakGate } from "./budgetLeak.js";
import { isMissingKeyError } from "../tools/missingKey.js";
import crypto from "node:crypto";
import { runTool, truncateToolResult } from "../tools/runner.js";
import { isBrowserTool } from "../tools/browser.js";
import { startBrowserAction } from "./browserBridge.js";
import { buildTurnTools, displayToolName } from "./turnTools.js";
import { mcpToolsForOwner } from "../mcp/toolAdapter.js";
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
  // 사용자의 크롬에서 실행할 명령(tools/browser.ts). 웹페이지가 확장 프로그램에 넘겨 실행하고
  // 결과를 /conversations/:id/browser-actions/:callId 로 돌려준다.
  | { type: "browser_action"; callId: string; toolCallId: string; name: string; arguments: unknown }
  | { type: "usage"; promptTokens: number; completionTokens: number; totalTokens: number }
  // Informational, not a failure: the turn continues in a degraded form.
  | { type: "notice"; message: string }
  // 컨텍스트 압축 진행률(chat/compactionProgress.ts). 그동안 화면은 입력을 막는다.
  | CompactionEvent
  // 모델이 동시 요청 상한에 차 있어 줄을 선다(vllm/concurrency.ts). ahead = 앞에 선 요청 수.
  | { type: "queued"; ahead: number }
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
 * The error a turn ends with when the person stopped it (or the connection
 * closed). routes/conversations.ts compares against it to tell a Stop apart
 * from a real failure.
 */
export const CANCELLED_BY_CLIENT = "Cancelled by client.";

export interface TurnOptions {
  /** 이 턴을 보낸 브라우저에 크롬 확장이 연결돼 있고 사용자가 "크롬 제어" 를 켰다. */
  browserControl?: boolean;
}

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
  options: TurnOptions = {},
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
  // Kicked off now rather than where it is actually used (further down, where
  // the turn's tools are built): it depends on nothing computed in this function —
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
  // Only among the models this account may use (vllm/access.ts) — the same
  // rule for a turn sent from the page and one a schedule runs.
  const resolved = await resolveModel(conversation.model, (await modelAccessForOwner(ownerId)).allows);
  const { model, maxModelLen } = resolved;
  // 기본(wise) 모델은 AI Product 가 아니면 그 사람의 키로(vllm/access.ts). 화면에서 보낸 턴은
  // conversationTurn 이 미리 거른다 — 여기서 걸리는 것은 키를 지운 뒤에 돈 예약 작업이다.
  const endpoint = await endpointForOwner(resolved.endpoint, ownerId);
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
  const totalUsage: MessageUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  // Every model call of the turn that reports usage: the history summary, the
  // rounds, the research compactions and the wrap-up — the tokens the turn
  // actually spent, input and output.
  const addUsage = (usage: NonNullable<VllmStreamChunk["usage"]>): void => {
    const prompt = usage.prompt_tokens ?? 0;
    const completion = usage.completion_tokens ?? 0;
    totalUsage.promptTokens += prompt;
    totalUsage.completionTokens += completion;
    totalUsage.totalTokens += usage.total_tokens ?? prompt + completion;
  };
  const history = yield* withCompactionEvents(
    { ownerId, conversationId: conversation.id, kind: "history" },
    (onProgress) =>
      buildTurnHistory({
        conversation,
        ownerId,
        model,
        endpoint,
        contextWindow: maxModelLen,
        signal,
        onProgress,
        onUsage: addUsage,
      }),
    (built) => Boolean(built.notice),
  );
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

  // Awaited here rather than fetched here — it was already kicked off above,
  // before resolveModel and buildTurnHistory, and has been running alongside
  // them since. On an ordinary turn this await resolves immediately because
  // the promise settled minutes ago (mcp/discovery.ts's cache); the only turn
  // that ever actually waits here is the very first one after a server was
  // just added, which used to wait behind resolveModel and buildTurnHistory
  // too and now waits behind whichever of the three is actually slowest.
  const mcpTools = await mcpToolsPromise;
  // The turn's tool snapshot, taken once (chat/turnTools.ts).
  const { turnTools, tools, maxToolCalls: maxToolCallsThisTurn, identicalLimit } = buildTurnTools(
    conversation,
    mcpTools.tools,
    options.browserControl === true,
  );

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
  // Turned off for the rest of the turn after a second failed summarisation:
  // retrying every round would charge each one its latency for the same
  // failure, but giving up after one meant a single over-long report stopped
  // tools for the rest of the turn (production, 2026-10-16).
  let compactionAvailable = config.contextCompactRatio > 0;
  let compactionFailures = 0;
  const missingKeyNoticed = new Set<string>();
  let extraReserve = 0;
  let contextRetries = 0;
  const notices: string[] = [];
  const seenNotices = new Set<string>();
  // TOOL_MAX_ROUNDS is an escape hatch only; 0 (the default) means unlimited.
  const maxRounds = config.toolMaxRounds > 0 ? config.toolMaxRounds : Number.POSITIVE_INFINITY;

  // How a round ends when the turn's signal fired. The safety net or an
  // "answer now" click stopping the model is not the user stopping it: the turn
  // carries on after the loop and writes an answer from what it has. The caller
  // still `break`s, so the loop's exits stay visible where they happen.
  const endRoundOnAbort = (): void => {
    const reason = deadline.stopReason();
    if (reason) {
      stopKind = reason;
      return;
    }
    aborted = true;
    errorNote = CANCELLED_BY_CLIENT;
  };

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

  // The summary is not announced in the answer (2026-10-16, user request): the
  // compaction progress bar already showed it happening, and a standing note
  // under every summarised turn read as a warning. `history.notice` still marks
  // the turn that summarised — it is what tells the compaction events it worked.

  for (let round = 1; !aborted; round++) {
    // Stop, the safety net, or "지금 답변하기" may have arrived while the
    // previous round's tools were running. Check before the budget step, which
    // costs a /tokenize round-trip of its own.
    if (signal.aborted) {
      endRoundOnAbort();
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
          const compacted = yield* withCompactionEvents(
            { ownerId, conversationId: conversation.id, kind: "research" },
            (onProgress) =>
              compactResearchContext({
                endpoint,
                model,
                messages: workingMessages,
                baseMessages,
                contextWindow: maxModelLen,
                signal,
                onProgress,
              }),
            () => true,
          );
          // Only the list sent to vLLM is replaced: allToolCalls/allToolResults
          // are what the UI shows for this turn, and the user must still see
          // every call that was made.
          workingMessages = compacted.messages;
          addUsage({ prompt_tokens: compacted.usage.promptTokens, completion_tokens: compacted.usage.completionTokens });
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
          endRoundOnAbort();
          break;
        }
        // Never worse than before compaction existed: leave the messages alone
        // and let the ladder degrade this round the way it always has.
        console.warn(`[compact] round ${round} failed, falling back to the context budget ladder:`, err);
        compactionFailures++;
        // Nothing older to summarise will not change by retrying; anything else gets one more go.
        if (compactionFailures >= 2 || /nothing older/.test(String(err))) compactionAvailable = false;
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
        endRoundOnAbort();
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
    // Thinking that runs on past a thinking_token_budget cut is moved back into
    // reasoning (chat/budgetLeak.ts). Decided at the round's first content delta.
    let roundReasoning = "";
    let leakGate: BudgetLeakGate | null = null;

    try {
      const ahead = modelQueueAhead(endpoint, body.model);
      if (ahead >= 0) yield { type: "queued", ahead };
      const stream = await streamChatCompletion(body, signal, endpoint);
      for await (const chunk of stream) {
        if (signal.aborted) throw new Error("aborted-by-user");
        const choice = chunk.choices?.[0];
        if (chunk.usage) addUsage(chunk.usage);
        if (!choice) continue;
        const delta = choice.delta ?? {};
        const reasoningDelta = delta.reasoning ?? delta.reasoning_content;
        if (reasoningDelta) {
          reasoning += reasoningDelta;
          roundReasoning += reasoningDelta;
          yield { type: "reasoning", delta: reasoningDelta };
        }
        if (delta.content) {
          leakGate ??= new BudgetLeakGate({
            budgetSet: "thinking_token_budget" in body && !thinkingBudgetRefused(endpoint, model),
            reasoning: roundReasoning,
            question: lastUserText(conversation),
          });
          const routed = leakGate.feed(delta.content);
          if (routed.reasoning) {
            reasoning += routed.reasoning;
            yield { type: "reasoning", delta: routed.reasoning };
          }
          if (routed.content) {
            content += routed.content;
            roundContent += routed.content;
            yield { type: "content", delta: routed.content };
          }
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
      const rest = leakGate?.end();
      if (rest?.reasoning) {
        reasoning += rest.reasoning;
        yield { type: "reasoning", delta: rest.reasoning };
      }
      if (rest?.content) {
        content += rest.content;
        roundContent += rest.content;
        yield { type: "content", delta: rest.content };
      }
    } catch (err) {
      if (isAbortError(err)) {
        endRoundOnAbort();
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
      const repeating = seen > identicalLimit(name);
      const tooManyCalls = allToolCalls.length > maxToolCallsThisTurn;

      let resultRecord: ToolResultRecord;
      if (signal.aborted) {
        // Stop, the safety net or "지금 답변하기" arrived during an earlier call
        // of this round. The rest are not run: each could take up to
        // TOOL_TIMEOUT_MS, and the wrap-up answer (or the Stop) waits behind
        // them. Still recorded, so every tool_call keeps its tool result.
        resultRecord = { id, name, ok: false, error: "턴이 중지되어 이 호출은 실행하지 않았습니다.", durationMs: 0 };
      } else if (repeating || tooManyCalls) {
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
            ? `같은 도구를 같은 인자로 ${identicalLimit(name)}번 넘게 호출하여 이 호출은 실행하지 않았습니다.`
            : `이번 턴의 도구 호출이 ${maxToolCallsThisTurn}회를 넘어 이 호출은 실행하지 않았습니다.`,
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
        } else if (isBrowserTool(name)) {
          // 서버에서 실행할 수 없는 도구다. 웹페이지에 넘기고, 사용자의 크롬이 실행해
          // 돌려줄 때까지 기다린다. 사용자가 확인 창에서 고민하는 시간도 여기에 든다.
          // 중지·지금 답변하기가 오면 기다림이 바로 끝난다(chat/browserBridge.ts).
          const startedAt = Date.now();
          const action = startBrowserAction(ownerId, conversation.id, signal);
          yield { type: "browser_action", callId: action.callId, toolCallId: id, name, arguments: parsedArgs };
          const outcome = await action.result;
          resultRecord = {
            id,
            name,
            ok: outcome.ok,
            result: outcome.ok ? truncateToolResult(outcome.result) : undefined,
            error: outcome.ok ? undefined : outcome.error,
            durationMs: Date.now() - startedAt,
          };
        } else {
          // The context scopes a call to its account and conversation: read_attachment
          // reads this conversation's files, web_search picks the owner's key, the
          // schedule tools file under this conversation, and MCP tools carry the owner.
          const run = await runTool(tool, parsedArgs, {
            ownerId,
            conversationId: conversation.id,
            browserControl: options.browserControl === true,
          });
          resultRecord = { id, name, ok: run.ok, result: run.result, error: run.error, durationMs: run.durationMs };
        }
      }
      allToolResults.push(resultRecord);
      // 키가 없어 거절된 도구는 모델의 말과 별개로 화면에 직접 알린다(도구마다 한 번).
      if (!resultRecord.ok && isMissingKeyError(resultRecord.error) && !missingKeyNoticed.has(name)) {
        missingKeyNoticed.add(name);
        yield* noticeEvent(
          `API 키가 등록되어 있지 않아 ${displayToolName(name)} 도구를 사용할 수 없습니다. 설정 › 개인 키 (API 키·토큰)에서 본인 키를 등록하면 사용할 수 있습니다.`,
        );
      }
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
    for (const tr of roundToolResults) workingMessages.push(toolResultMessage(tr, sources));

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

  // The two wrap-up calls below differ only in their reason; what each does when
  // the call fails is deliberately different and stays at the call site.
  const wrapUp = (reason: WrapUpReason) =>
    wrapUpWithFallback(
      {
        model,
        endpoint,
        reasoning,
        temperature: conversation.settings.temperature,
        topP: conversation.settings.topP,
        reason,
        clientSignal,
        onUsage: addUsage,
      },
      messagesForWrapUp(workingMessages),
      baseMessages,
    );

  if (stopKind) {
    const wrapUpReason: WrapUpReason =
      stopKind === "deadline" ? { kind: "deadline", deadlineMs: NORMAL_MODE_SAFETY_TIMEOUT_MS } : { kind: "answer-now" };
    yield* noticeEvent(
      stopKind === "deadline"
        ? `추론이 ${describeDeadline(NORMAL_MODE_SAFETY_TIMEOUT_MS)}를 넘어, 그때까지 모은 정보로 답변을 정리했습니다.`
        : "'지금 답변하기' 요청에 따라, 그때까지 모은 정보로 답변을 정리했습니다.",
    );
    try {
      for await (const delta of wrapUp(wrapUpReason)) {
        content += delta;
        yield { type: "content", delta };
      }
      // The stream ends quietly, not with an AbortError, when Stop lands between
      // two chunks. Without this the half-written wrap-up was stored as a
      // finished answer with no error.
      if (clientSignal.aborted) {
        aborted = true;
        errorNote = CANCELLED_BY_CLIENT;
      }
    } catch (err) {
      if (isAbortError(err)) {
        aborted = true;
        errorNote = CANCELLED_BY_CLIENT;
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
      for await (const delta of wrapUp({ kind: "empty-answer" })) {
        content += delta;
        yield { type: "content", delta };
      }
      // Same as above: a Stop between chunks ends the stream without an error.
      if (clientSignal.aborted) {
        aborted = true;
        errorNote = CANCELLED_BY_CLIENT;
      }
    } catch (err) {
      if (isAbortError(err)) {
        aborted = true;
        errorNote = CANCELLED_BY_CLIENT;
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

/** The question this turn answers — the gate compares its script with the reasoning's. */
function lastUserText(conversation: Conversation): string {
  for (let i = conversation.messages.length - 1; i >= 0; i--) {
    const message = conversation.messages[i]!;
    if (message.role === "user") return message.content;
  }
  return "";
}
