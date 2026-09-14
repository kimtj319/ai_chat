import { config } from "../config.js";
import type { VllmEndpoint } from "../config.js";
import { countPromptTokens, type ChatToolDef, type PromptTokenCount } from "../vllm/client.js";
import { dropImageParts, imagePartCount } from "./historyBuilder.js";
import { IMAGE_TOKEN_CEILING } from "../attachments/sniff.js";
import type { VllmMessage } from "./historyBuilder.js";

/**
 * Keeps a request inside the model's context window.
 *
 * The failure this exists for (production, 2026-09-11): six http_fetch results
 * at the runner's 100KB-per-result cap added up to ~245k input tokens, and with
 * max_tokens 16384 on top the server rejected the whole turn with
 *   400 "This model's maximum context length is 262144 tokens..."
 * Nothing capped the aggregate. Rather than fail, we measure the prompt with
 * vLLM's /tokenize before every request and degrade in steps until it fits.
 */

/** Head-room for the generation prompt and for tokenizer drift between /tokenize and the server. */
export const SAFETY_MARGIN_TOKENS = 2048;
/** Floor for max_tokens: below this the answer is too short to be worth sending. */
const MIN_COMPLETION_TOKENS = 512;
/** Characters of the original payload kept when a tool result is shrunk. */
const TOOL_RESULT_EXCERPT_CHARS = 600;
/**
 * Tool results at or below this size are not worth shrinking. It must stay well
 * above the stand-in's own size so a shrunk result can never be picked again.
 */
const TOOL_RESULT_SHRINK_THRESHOLD_CHARS = 1200;
/** Extra reserve after a context 400 whose reported token count we could not parse. */
const BLIND_RETRY_RESERVE_TOKENS = 8192;

const NOTICE_TOOLS_STOPPED = "컨텍스트 한도에 근접하여 도구 호출을 중단하고 답변을 생성합니다.";
const NOTICE_MIN_OUTPUT = "컨텍스트 여유가 부족하여 답변 길이를 최소한으로 제한합니다.";

export interface BudgetFitInput {
  endpoint: VllmEndpoint;
  model: string;
  messages: VllmMessage[];
  /**
   * The tool schemas the request carries. They are sent on every request of the
   * turn — a stopped round keeps them and sends tool_choice:"none" instead — so
   * they are part of every measurement here, stopped or not.
   */
  tools?: ChatToolDef[];
  desiredMaxTokens: number;
  /** The model's context window (catalog value); the tokenizer's own value is used when null. */
  contextWindow: number | null;
  /** Tokens to hold back on top of the safety margin, raised after a context 400. */
  extraReserve?: number;
  /**
   * Messages that must survive step 2, identified by object identity rather than
   * by position. Positional protection ("the last user message onwards") drops
   * the wrong thing after a compaction, where the last user message is the
   * synthetic continuation instruction — see chat/toolLoop.ts.
   */
  protectedMessages?: ReadonlySet<VllmMessage>;
  /**
   * A /tokenize count the caller has already taken of exactly these `messages`
   * and `tools`. Saves this function's own first call — a /tokenize round-trip
   * measured at a mean of 2,769ms on a 232k-token list — when the caller had to
   * measure the same request a moment earlier anyway (the compaction gate in
   * chat/toolLoop.ts). It MUST describe the same request, or the ladder degrades
   * against a stale number.
   */
  preCount?: PromptTokenCount;
  /** The turn's abort signal; the ladder makes one /tokenize call per step. */
  signal?: AbortSignal;
}

export interface BudgetFitResult {
  messages: VllmMessage[];
  tools?: ChatToolDef[];
  maxTokens: number;
  promptTokens: number;
  /** True once tools had to be dropped — the caller must keep them off for the rest of the turn. */
  toolsStopped: boolean;
  notices: string[];
}

/**
 * Measure the request and, if it does not fit, degrade in this order, stopping
 * as soon as it does:
 *   1. shrink tool results (oldest first — the newest ones are the ones the
 *      model is actually reasoning about),
 *   2. evict old images (oldest first, never on a protected message), leaving a
 *      placeholder that says so,
 *   3. drop the oldest history turns (never the system prompt, never the
 *      triggering user message, never a protected message, never half of an
 *      assistant/tool pair),
 *   4. stop offering tools so the model answers from what it already has.
 *
 * Step 4 no longer frees the schema tokens: a stopped request still carries the
 * schemas (with tool_choice:"none"), so `count` includes them from the first
 * measurement to the last and stopping tools is a decision, not a saving. The
 * schemas are ~500-900 tokens for the 7 tools a conversation typically enables,
 * against a 262,144-token window and SAFETY_MARGIN_TOKENS of 2048 — but the
 * point is that they are *measured*, not that they are small.
 */
export async function fitToContextBudget(input: BudgetFitInput): Promise<BudgetFitResult> {
  const notices: string[] = [];
  let messages = input.messages;
  let toolsStopped = false;

  let count =
    input.preCount ??
    (await countPromptTokens(input.endpoint, input.model, messages, input.tools, input.signal));
  /** The tools this round may actually call; the wire payload keeps input.tools either way. */
  const offeredTools = () => (toolsStopped ? undefined : input.tools);
  const window = input.contextWindow ?? count.maxModelLen;
  if (window === null) {
    // Neither the catalog nor the tokenizer reports a window; budgeting would
    // be guesswork, so send the request unchanged as before.
    return {
      messages,
      tools: offeredTools(),
      maxTokens: input.desiredMaxTokens,
      promptTokens: count.tokens,
      toolsStopped,
      notices,
    };
  }
  const budget = Math.max(0, window - (input.extraReserve ?? 0));
  const recount = async () => {
    count = await countPromptTokens(input.endpoint, input.model, messages, input.tools, input.signal);
  };
  /**
   * What the WINDOW still has room for, independent of how long an answer the
   * caller wanted. Every rung below is a response to the window filling up, so
   * each one has to test this and not the caller's ceiling.
   *
   * They used to be the same number — `min(desiredMaxTokens, room)` — which
   * meant a conversation whose maxTokens was set low read as "the window is
   * full" from its very first turn: the ladder shrank tool results and dropped
   * old turns to make space that was already there, and the answer came with
   * "컨텍스트 여유가 부족하여…" against a 99% empty window.
   */
  const windowRoom = () => budget - count.tokens - SAFETY_MARGIN_TOKENS;

  // Proactive step 3: one more tool round would append another result and push
  // the request over the window, so stop while there is still room to answer.
  // No recount: the schemas stay in the request, so nothing about the prompt
  // changed here.
  if (input.tools && count.tokens > budget * config.contextToolStopRatio) {
    toolsStopped = true;
    notices.push(NOTICE_TOOLS_STOPPED);
  }

  // Step 1 — shrink tool results, oldest first.
  let shrunk = 0;
  for (;;) {
    if (windowRoom() >= MIN_COMPLETION_TOKENS) break;
    const index = nextShrinkableToolResult(messages);
    if (index === -1) break;
    messages = messages.slice();
    messages[index] = { ...messages[index]!, content: shrinkToolContent(String(messages[index]!.content)) };
    shrunk++;
    await recount();
  }
  if (shrunk > 0) notices.push(`컨텍스트 한도를 넘지 않도록 도구 결과 ${shrunk}건을 요약본으로 줄였습니다.`);

  // Step 2 — evict old images, oldest first, before dropping whole turns: an
  // image is a self-contained 66-16,386 tokens, and losing one costs less of
  // the conversation than losing the question and answer around it.
  //
  // Planned in one batch off the recorded imageTokens and recounted ONCE. One
  // image at a time would be a /tokenize per image, and /tokenize is far slower
  // on image content than on text of the same size: 1.2-7.7s for a 16-image
  // list against 0.15-0.86s for the same token count as text (measured
  // 2026-09-11).
  if (windowRoom() < MIN_COMPLETION_TOKENS) {
    // The deficit is charged at the recorded image costs; the Korean
    // placeholder left behind costs ~66 tokens per image, which the single
    // recount below picks up (and the next rung covers if it still does not
    // fit). Measured: evicting 2 x 2,074 freed 4,016.
    const plan = planImageEviction(messages, MIN_COMPLETION_TOKENS - windowRoom(), input.protectedMessages);
    if (plan.evicted > 0) {
      messages = plan.messages;
      await recount();
      notices.push(`컨텍스트 한도를 넘지 않도록 오래된 이미지 ${plan.evicted}장을 제외했습니다.`);
    }
  }

  // Step 3 — drop the oldest history.
  let dropped = 0;
  while (windowRoom() < MIN_COMPLETION_TOKENS) {
    const next = dropOldestTurn(messages, input.protectedMessages);
    if (!next) break;
    messages = next;
    dropped++;
    await recount();
  }
  if (dropped > 0) notices.push(`컨텍스트 한도를 넘지 않도록 오래된 대화 ${dropped}개를 제외했습니다.`);

  // Step 4 — reactive: still no room, so stop asking for tools and let the model
  // answer with what it has. No recount here either (see the header): the
  // schemas are still sent, only tool_choice changes.
  if (windowRoom() < MIN_COMPLETION_TOKENS && input.tools && !toolsStopped) {
    toolsStopped = true;
    notices.push(NOTICE_TOOLS_STOPPED);
  }

  // The caller's ceiling is honoured whenever the window can pay for it; the
  // floor only applies when the window is what is short. The notice now marks
  // the one case a reader cares about — being given less than was asked for.
  const granted = Math.min(input.desiredMaxTokens, Math.max(MIN_COMPLETION_TOKENS, windowRoom()));
  if (granted < input.desiredMaxTokens) notices.push(NOTICE_MIN_OUTPUT);
  return {
    messages,
    tools: offeredTools(),
    maxTokens: granted,
    promptTokens: count.tokens,
    toolsStopped,
    notices,
  };
}

/**
 * Index of the oldest tool result still worth shrinking, or -1. A stand-in is
 * always shorter than the threshold, so an already-shrunk result is never
 * picked twice.
 */
function nextShrinkableToolResult(messages: VllmMessage[]): number {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    // A tool result is always a JSON string; the typeof guard is what tells the
    // compiler that, now that a user message may carry content parts instead.
    if (m.role === "tool" && typeof m.content === "string" && m.content.length > TOOL_RESULT_SHRINK_THRESHOLD_CHARS) {
      return i;
    }
  }
  return -1;
}

/**
 * Choose the images to evict: oldest first, skipping protected messages, until
 * their recorded cost covers the deficit. Returns the rewritten list — nothing
 * is measured here, so the caller recounts once for the whole batch.
 */
function planImageEviction(
  messages: VllmMessage[],
  deficitTokens: number,
  protectedMessages?: ReadonlySet<VllmMessage>,
): { messages: VllmMessage[]; evicted: number } {
  const next = messages.slice();
  let freed = 0;
  let evicted = 0;
  for (let i = 0; i < next.length && freed < deficitTokens; i++) {
    const message = next[i]!;
    // Identity, like dropOldestTurn: a protected message is never rewritten, so
    // the caller's set keeps matching it across rounds.
    if (protectedMessages?.has(message)) continue;
    const images = imagePartCount(message);
    if (images === 0) continue;
    let take = 0;
    while (take < images && freed < deficitTokens) {
      freed += message.imageTokens?.[take] ?? IMAGE_TOKEN_CEILING;
      take++;
    }
    next[i] = dropImageParts(message, take);
    evicted += take;
  }
  return { messages: next, evicted };
}

/**
 * Tool content is sent as JSON (see historyBuilder), so the stand-in has to be
 * valid JSON too, and it has to say what happened — otherwise the model reads a
 * truncated page as the whole page.
 */
function shrinkToolContent(content: string): string {
  return JSON.stringify({
    truncated: true,
    note: "This tool result was shortened to fit the context window. Only the excerpt below remains; call the tool again if you need the rest.",
    excerpt: content.slice(0, TOOL_RESULT_EXCERPT_CHARS),
  });
}

/**
 * Drop the oldest droppable turn, returning the new list (null when there is
 * nothing left to drop). The system prompt stays, and so does everything from
 * the first message that must be kept onwards: the last user message, or any
 * message the caller marked protected, whichever comes first. An
 * assistant(tool_calls) message is dropped together with its tool results —
 * either one alone breaks the chat template.
 *
 * "The last user message onwards" alone was wrong after a compaction, whose
 * rebuilt list is
 *   system | user(the question) | assistant(interim report) | user(continue) | …
 * so the last user message is the synthetic continuation instruction: drop #1
 * took the question and drop #2 took the report, leaving the model told to
 * continue from a report that was no longer there (measured 2026-09-11). The
 * protected set is matched by identity, so it survives earlier drops and the
 * slicing here without depending on any position.
 */
function dropOldestTurn(
  messages: VllmMessage[],
  protectedMessages?: ReadonlySet<VllmMessage>,
): VllmMessage[] | null {
  let keepFrom = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      keepFrom = i;
      break;
    }
  }
  if (protectedMessages?.size) {
    for (let i = 0; i < keepFrom; i++) {
      if (protectedMessages.has(messages[i]!)) {
        keepFrom = i;
        break;
      }
    }
  }
  const start = messages[0]?.role === "system" ? 1 : 0;
  if (start >= keepFrom) return null;

  let end = start + 1;
  if (messages[start]!.tool_calls?.length) {
    while (end < keepFrom && messages[end]!.role === "tool") end++;
  }
  const next = messages.slice();
  next.splice(start, end - start);
  return next;
}

/**
 * How many extra tokens to reserve after a failed request, or null when the
 * error is not a context-length 400 (other 4xx are real errors — never retried).
 */
export function contextOverflowReserve(
  err: unknown,
  requestedOutputTokens: number,
  window: number | null,
): number | null {
  if (!(err instanceof Error)) return null;
  if (!/responded 400/.test(err.message) || !/maximum context length/i.test(err.message)) return null;
  const reported =
    /at least (\d+) input tokens/.exec(err.message) ?? /input_tokens, value=(\d+)/.exec(err.message);
  const inputTokens = reported ? Number.parseInt(reported[1]!, 10) : NaN;
  if (window !== null && Number.isFinite(inputTokens)) {
    const overflow = inputTokens + requestedOutputTokens - window;
    if (overflow > 0) return overflow + SAFETY_MARGIN_TOKENS;
  }
  return BLIND_RETRY_RESERVE_TOKENS;
}
