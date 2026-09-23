import { streamChatCompletion, countPromptTokens, estimatePromptTokens, type ChatCompletionRequestBody } from "../vllm/client.js";
import { config } from "../config.js";
import type { VllmEndpoint } from "../config.js";
import { SAFETY_MARGIN_TOKENS } from "./contextBudget.js";
import { buildHistoryMessages, type HistoryBuildOptions, type VllmMessage } from "./historyBuilder.js";
import { saveHistorySummary } from "../storage/conversationStore.js";
import { DEFAULT_SETTINGS } from "../types.js";
import type { Conversation, HistorySummary, StoredMessage } from "../types.js";

export type { HistorySummary } from "../types.js";

/**
 * Summarises a conversation's older turns ONCE, stores the summary on the
 * conversation, and carries every later turn on from it.
 *
 * The failure this exists for: chat/contextBudget.ts keeps a request inside the
 * window by degrading a throwaway copy of it — shrink tool results, evict
 * images, drop the oldest turns — and writes none of that back. So the ladder
 * re-runs from scratch on the next turn: the same turns are dropped again, the
 * same notice ("컨텍스트 한도를 넘지 않도록 오래된 대화 N개를 제외했습니다.")
 * is shown again on answer after answer, and the dropped turns are simply gone
 * — never summarised, never seen again.
 *
 * One model call at the moment the window fills replaces all of that: what those
 * turns said survives as prose, the result is persisted, and the later turns pay
 * nothing and say nothing because the prompt they build is small again.
 *
 * Unlike chat/contextCompaction.ts, which summarises ONE turn's tool research
 * mid-turn and throws the result away at the end of the turn, this summary is
 * conversation state: it is re-sent on every later turn, which is why its size
 * is capped far harder than the interim report's.
 */

/**
 * Room for the summary itself.
 *
 * Below contextCompaction's 2048 on purpose: that report is read once, inside
 * the turn that paid for it, while this text is prefilled again on every later
 * turn of the conversation — a permanent tax on the window, not a one-off.
 *
 * Measured 2026-09-12 against the 27B endpoint on a 30-message Korean
 * conversation with 14 planted facts (numbers, paths, a branch name, a date):
 * the first summary ran 686-747 completion tokens / 1,191-1,312 characters and
 * kept 14 of 14; folding it together with 8 more messages ran 747-806 tokens /
 * 1,281-1,390 characters and again kept 14 of 14 plus the new ones (3 runs).
 * Every run finished on its own (finish_reason=stop) in 11-13s. The fold is what sets this number, not the
 * first pass — it grows by the facts the new turns added — so the cap has to
 * leave a fold room to finish its sentence rather than be cut off mid-line.
 */
const SUMMARY_MAX_TOKENS = 1536;
/** Copying decisions and numbers forward is transcription, not creative writing. */
const SUMMARY_TEMPERATURE = 0.2;
/**
 * The app's own default (DEFAULT_SETTINGS.topP) and Qwen's recommendation for
 * non-thinking mode — near-greedy decoding degenerates into repetition, and a
 * summary that repeats spends the whole budget saying one thing.
 */
const SUMMARY_TOP_P = 0.8;

/**
 * Hard clamp on what is STORED, independent of max_tokens: a model that ignores
 * the length instruction must not be able to write a summary that is itself the
 * context problem. 3,000 chars is twice the 1,390 measured on a second fold and
 * still ~1,800 tokens — 0.7% of a 262k window — when it is re-sent. (Measured
 * cost of the rendered summary message, header included: 803 tokens.)
 *
 * Together with SUMMARY_MAX_TOKENS this is the answer to "what if the summary
 * itself grows too large": it cannot. Each fold rewrites the whole text under
 * both ceilings, so the stored summary is bounded no matter how many times the
 * conversation fills the window.
 */
const MAX_SUMMARY_CHARS = 3_000;
/** Below this it is a refusal or a stub ("요약할 내용이 없습니다"), not a summary. */
const MIN_SUMMARY_CHARS = 40;

/**
 * Messages left verbatim below the summary: two full exchanges, plus whatever
 * the cut-to-a-user-boundary rule adds. The most recent turns are the ones the
 * next question is usually about, and prose is a poor substitute for them.
 */
const KEEP_RECENT_MESSAGES = 4;
/** Fewer new messages than this is not worth a model call that costs tens of seconds. */
const MIN_NEW_MESSAGES = 2;

/**
 * Ceiling on the transcript handed to the summariser.
 *
 * Charged in characters, not tokens, so it costs no /tokenize round-trip. One
 * character per token is the safe floor for Korean (measured on this corpus:
 * 6,548 chars -> 3,477 tokens, i.e. 1.88 chars per token), so 60,000 characters
 * cannot exceed 60,000 tokens even in the worst case — well inside every window
 * this app serves, alongside SUMMARY_MAX_TOKENS of output.
 */
const MAX_TRANSCRIPT_CHARS = 60_000;
/** Per-message ceiling, and the floor it may shrink to when there are many messages. */
const MAX_MESSAGE_CHARS = 1_500;
const MIN_MESSAGE_CHARS = 300;

/**
 * Korean, because the conversations are: the summary is read back by the same
 * model as the earlier half of the very conversation it describes.
 *
 * The constraints are the ones that matter for a summary that REPLACES the
 * original: no invention (the model cannot check it later — the messages are
 * gone), verbatim numbers/paths/URLs (a rounded number reads as authoritative),
 * and an explicit fold-in rule, because from the second summarisation on the
 * input is "previous summary + new turns" and the output has to be one text of
 * the same size rather than a growing pile.
 *
 * The fold-in rule names WHICH section may be compressed. Told only to "shorten
 * what is finished", the model dropped the error code SFL_0322, the document
 * count and the cache hit rate from a second fold — 10 of 14 planted facts kept,
 * against 14 of 14 when it was told to carry section 2 over intact and compress
 * section 3 instead (measured 2026-09-12, same corpus).
 */
const SUMMARY_INSTRUCTION = `아래는 한 대화의 앞부분 기록입니다. 이 대화를 이어서 진행할 수 있도록 "이전 대화 요약"을 작성하세요. 이 요약은 원본 대화를 대신하게 되며, 원문은 더 이상 남지 않습니다.

1. 대화 주제: 이 대화가 무엇에 대한 것인지 한두 줄.
2. 확인된 사실과 결정: 지금까지 확정된 내용·수치·이름·파일 경로·설정값·결론을 빠짐없이 나열하세요.
3. 사용자의 요청과 답변: 사용자가 무엇을 요청했고 무엇이 답변되었는지. 한 턴씩 나열하지 말고 3~5줄로 묶어 쓰세요.
4. 진행 중인 일과 남은 것: 아직 끝나지 않은 작업, 미해결 질문, 다음에 이어질 것으로 보이는 일.

제약:
- 한국어로 쓰세요.
- 기록에 없는 내용을 추측해서 채우지 마세요. 해당 항목에 적을 것이 없으면 "없음"이라고 쓰세요.
- 숫자·날짜·이름·파일 경로·URL·설정값·오류 메시지는 원문 그대로 옮기세요. 반올림, 단위 변환, 축약 금지.
- 대화를 평가하거나 감상을 덧붙이지 말고, 뒤에서 다시 필요할 내용만 남기세요.
- 원문을 그대로 옮겨 적지 말고 요약하세요. 같은 내용이 반복되면 한 번만 쓰세요.
- 기록 맨 앞에 "[이전 요약]"이 있으면, 그 내용과 이후 대화를 하나의 요약으로 합치세요. 이전 요약의 2번 항목에 있는 수치·이름·경로·오류 코드·결정은 하나도 빠뜨리지 말고 그대로 옮긴 뒤, 새로 확정된 것을 덧붙이세요. 분량을 줄여야 하면 2번이 아니라 3번 항목을 줄이세요.
- 전체 ${MAX_SUMMARY_CHARS}자 이내로 쓰세요.
- 제목이나 머리말 없이 1번 항목부터 바로 시작하세요.

기록:`;

/**
 * Says what this message is and what it replaced. Without the second half the
 * model reads a suspiciously tidy assistant turn and answers as though it had
 * just said all of that; with it, it treats the text as notes about a
 * conversation whose original is gone.
 */
function summaryHeader(summary: HistorySummary): string {
  return `[이전 대화 요약 — 이 대화의 앞부분 메시지 ${summary.coveredMessages}개를 대신합니다. 원문은 컨텍스트 한도 때문에 더 이상 포함되지 않습니다. 아래 내용을 앞선 대화로 삼아 이어서 답하세요.]`;
}

/** Shown once, on the turn that actually summarised. */
function summaryNotice(summary: HistorySummary): string {
  return `컨텍스트 한도에 도달하여 이전 대화 ${summary.coveredMessages}개를 요약해 이어갑니다. 이후 답변은 이 요약을 바탕으로 이어집니다.`;
}

/** The stored summary and where it sits, or null when it cannot be placed. */
function activeSummary(conversation: Conversation): { summary: HistorySummary; index: number } | null {
  const summary = conversation.historySummary;
  if (!summary || summary.text.trim().length === 0) return null;
  const index = conversation.messages.findIndex((m) => m.id === summary.throughMessageId);
  // A cut point that is no longer in the transcript cannot be placed: using it
  // would hide messages it never covered. Ignoring it costs one summarisation.
  if (index < 0) {
    console.warn(
      `[history] ignoring a summary for conversation ${conversation.id}: ` +
        `its throughMessageId is no longer in the transcript`,
    );
    return null;
  }
  return { summary, index };
}

/** Where the covered part ends (exclusive) and what is already covered. */
interface Coverage {
  /** First message not already covered by the stored summary. */
  from: number;
  /** Exclusive end of what this summarisation would cover. */
  to: number;
  previous: HistorySummary | null;
}

function planCoverage(conversation: Conversation): Coverage | null {
  const messages = conversation.messages;
  // The tail must start at a user message: cutting between a question and its
  // answer leaves an assistant message whose question exists only in the
  // summary — the same "orphan half of an exchange" the budget ladder avoids.
  let to = messages.length - KEEP_RECENT_MESSAGES;
  while (to > 0 && messages[to]?.role !== "user") to--;
  const active = activeSummary(conversation);
  const from = active ? active.index + 1 : 0;
  if (to - from < MIN_NEW_MESSAGES) return null;
  return { from, to, previous: active?.summary ?? null };
}

/**
 * Is there anything a summarisation could fold in? Pure and free, so the caller
 * can ask before paying for the /tokenize round-trip that `needsSummary` needs
 * (a mean of 2,769ms on a 232k-token list — see vllm/client.ts).
 */
export function couldSummarise(conversation: Conversation): boolean {
  return planCoverage(conversation) !== null;
}

/**
 * Is the window full enough to summarise? A pure decision from numbers the
 * caller already has.
 *
 * Two ways to answer yes:
 *
 * 1. Full outright: the conversation's own max_tokens no longer fits beside
 *    the prompt. This is the original, hard-floor test — it fires even if
 *    ratio-based summarisation below is somehow disabled or skipped, so a
 *    request that could not otherwise be sent still gets one last chance to
 *    shrink instead of failing outright.
 *
 * 2. Proactively, at contextToolStopRatio (chat/contextBudget.ts's default
 *    0.8): the same fraction that makes chat/toolLoop.ts stop offering tools
 *    for the rest of the turn.
 *
 *    Why the same number: this function used to fire only at the hard floor
 *    above — ~99% of the window, i.e. essentially the same point the budget
 *    ladder starts silently dropping old turns. That is well PAST 0.8, so on
 *    a long-running conversation the tool-stop ratio always tripped first.
 *    Once it does, chat/contextCompaction.ts's own in-turn compaction can
 *    never take over either, because its gate requires two tool RESULTS
 *    gathered by the CURRENT turn (see the comment there) — and a turn that
 *    opens with tools already stopped never gets to make any. The result,
 *    measured on real deployments: once a conversation's history alone
 *    crossed 0.8 x window, every later turn opened past the ratio, tools were
 *    stopped on round 1 before a single one could run, and nothing ever
 *    shrank the history back down — the same "컨텍스트 한도에 근접하여 도구
 *    호출을 중단합니다" notice on turn after turn, forever.
 *
 *    Firing here at the same ratio closes that gap: buildTurnHistory (which
 *    calls this) runs once, before chat/toolLoop.ts's round loop even starts,
 *    so folding the old turns into a summary here shrinks the prompt BEFORE
 *    the tool-stop check ever sees it — the turn that would have opened
 *    already stopped instead opens with room to spare, and calls tools like
 *    any other.
 *
 * The tool schemas are not counted here even when the caller measured without
 * them: they are ~500-900 tokens for a typical conversation, inside the
 * SAFETY_MARGIN_TOKENS this threshold already holds back.
 */
export function needsSummary(
  conversation: Conversation,
  promptTokens: number,
  contextWindow: number | null,
): boolean {
  // No window means budgeting is guesswork; contextBudget.ts gives up the same
  // way rather than degrading against a number nobody reported.
  if (contextWindow === null) return false;
  if (!couldSummarise(conversation)) return false;
  const desiredOutput = conversation.settings?.maxTokens ?? DEFAULT_SETTINGS.maxTokens;
  if (promptTokens + desiredOutput + SAFETY_MARGIN_TOKENS > contextWindow) return true;
  return promptTokens > contextWindow * config.contextToolStopRatio;
}

/** The summary as the model sees it: one assistant message, ahead of the tail. */
export function renderHistorySummary(summary: HistorySummary): VllmMessage {
  // Assistant, not user: the tail after it starts at a user message (see
  // planCoverage), so this keeps the alternation the chat template expects —
  // and it is the role contextCompaction.ts gives its own interim report.
  return { role: "assistant", content: `${summaryHeader(summary)}\n\n${summary.text}` };
}

/**
 * How historyBuilder should build this conversation: the summary in place of
 * everything it covers, then the messages after it. Undefined when there is no
 * usable summary, which is the ordinary case and builds the full history.
 */
export function historyBuildOptions(conversation: Conversation): HistoryBuildOptions | undefined {
  const active = activeSummary(conversation);
  if (!active) return undefined;
  return { prelude: renderHistorySummary(active.summary), fromIndex: active.index + 1 };
}

/** system prompt -> stored summary (if any) -> the messages after it. */
export async function buildHistoryWithSummary(
  conversation: Conversation,
  ownerId: string,
): Promise<VllmMessage[]> {
  return buildHistoryMessages(conversation, ownerId, historyBuildOptions(conversation));
}

export interface HistorySummaryInput {
  conversation: Conversation;
  model: string;
  endpoint: VllmEndpoint;
  /** The turn's abort signal, so Stop cancels the summarisation too. */
  signal: AbortSignal;
}

/**
 * Summarise the older part of the conversation.
 *
 * NEVER throws — an abort, a dead endpoint, an empty or degenerate answer all
 * return null, and the caller falls back to today's budget ladder, which is
 * exactly what happened before this existed.
 */
export async function summariseHistory(input: HistorySummaryInput): Promise<HistorySummary | null> {
  const plan = planCoverage(input.conversation);
  if (!plan) return null;
  const through = input.conversation.messages[plan.to - 1];
  if (!through) return null;

  const startedAt = Date.now();
  try {
    const body: ChatCompletionRequestBody = {
      model: input.model,
      messages: [
        {
          role: "user",
          content: `${SUMMARY_INSTRUCTION}\n${transcript(input.conversation.messages.slice(plan.from, plan.to), plan.previous)}`,
        },
      ],
      stream: true,
      stream_options: { include_usage: true },
      temperature: SUMMARY_TEMPERATURE,
      top_p: SUMMARY_TOP_P,
      max_tokens: SUMMARY_MAX_TOKENS,
      presence_penalty: 0,
      frequency_penalty: 0,
      // No tools and no thinking, like every other summariser here: this call
      // must not start a research round, and thinking would be latency the user
      // waits through for a transcription job.
      chat_template_kwargs: { enable_thinking: false },
    };

    let text = "";
    let finishReason: string | null = null;
    let completionTokens = 0;
    const stream = await streamChatCompletion(body, input.signal, input.endpoint);
    for await (const chunk of stream) {
      if (input.signal.aborted) return null;
      if (chunk.usage) completionTokens += chunk.usage.completion_tokens ?? 0;
      const choice = chunk.choices?.[0];
      // Reasoning deltas are ignored: only the summary survives this call.
      if (choice?.delta?.content) text += choice.delta.content;
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    }

    const cleaned = cleanSummary(text);
    if (!cleaned) {
      console.warn(
        `[history] discarding an unusable summary for conversation ${input.conversation.id} ` +
          `(finish_reason=${finishReason}, ${completionTokens} completion tokens, ${text.length} chars)`,
      );
      return null;
    }
    console.log(
      `[history] summarised messages ${plan.from}-${plan.to - 1} of conversation ${input.conversation.id}: ` +
        `${cleaned.length} chars, ${completionTokens} completion tokens, finish_reason=${finishReason}, ` +
        `${Date.now() - startedAt}ms`,
    );
    return {
      text: cleaned,
      throughMessageId: through.id,
      coveredMessages: plan.to,
      createdAt: new Date().toISOString(),
      ...(completionTokens > 0 ? { tokens: completionTokens } : {}),
    };
  } catch (err) {
    // Including an abort: the caller's own abort path ends the turn, and a
    // summary nobody asked for must never be the thing that fails it.
    console.warn(
      `[history] could not summarise conversation ${input.conversation.id}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export interface TurnHistoryInput {
  conversation: Conversation;
  ownerId: string;
  model: string;
  endpoint: VllmEndpoint;
  /** The model's context window (catalog value); null disables summarisation. */
  contextWindow: number | null;
  signal: AbortSignal;
}

export interface TurnHistory {
  messages: VllmMessage[];
  /**
   * The rendered summary INSIDE `messages`, by identity, so the caller can add
   * it to the budget ladder's protected set — it stands in for every turn it
   * covers, and dropping it would lose the whole early conversation at once.
   */
  summaryMessage?: VllmMessage;
  /** Present only on the turn that actually summarised; emit it once. */
  notice?: string;
}

/**
 * Build this turn's history, summarising first if the window is full.
 *
 * The whole decision lives here rather than at the call site: measure, decide,
 * summarise, persist, rebuild. Every failure degrades to the history the caller
 * would have built anyway.
 */
export async function buildTurnHistory(input: TurnHistoryInput): Promise<TurnHistory> {
  const { conversation, ownerId } = input;
  // The prelude object is the one historyBuilder pushes into the list, so this
  // is the summary message by identity — what the caller's protected set needs.
  let options = historyBuildOptions(conversation);
  let messages = await buildHistoryMessages(conversation, ownerId, options);
  let summaryMessage = options?.prelude;

  // The cheap half of the decision first: an ordinary conversation must not pay
  // a /tokenize round-trip per turn for a feature it will never reach.
  if (input.contextWindow === null || !couldSummarise(conversation)) return { messages, summaryMessage };

  // Cheaper still, before paying for the network round-trip: the character
  // estimate vllm/client.ts already computes for a tokenizer outage. It is
  // measured (see its own comment) to never come in UNDER the real count for
  // any payload shape tried — punctuation-heavy JSON included — so if even
  // this pessimistic number is not enough to need a summary, the real count
  // (which can only be smaller) certainly is not either. A conversation only
  // reaches this line once it is already long enough to fold something in
  // (couldSummarise above), which used to mean every one of its later turns
  // paid a real /tokenize call (mean 2,769ms on a 232k-token list) just to
  // learn "not yet" — often for many turns in a row before the window
  // actually filled. Skipping straight to "not yet" here costs nothing but a
  // string length and a loop over it.
  if (!needsSummary(conversation, estimatePromptTokens(messages), input.contextWindow)) {
    return { messages, summaryMessage };
  }

  const count = await countPromptTokens(input.endpoint, input.model, messages, undefined, input.signal).catch(
    // A tokenizer outage is not a reason to fail the turn: without a number
    // there is no decision to make, so carry on exactly as before.
    () => null,
  );
  if (!count || !needsSummary(conversation, count.tokens, input.contextWindow)) {
    return { messages, summaryMessage };
  }

  const summary = await summariseHistory({
    conversation,
    model: input.model,
    endpoint: input.endpoint,
    signal: input.signal,
  });
  if (!summary) return { messages, summaryMessage };

  // Persisted before it is used, so a restart — or the next turn — sees the same
  // summary rather than paying for another one. A write failure is survivable:
  // the turn still runs on the summary, the next one summarises again.
  try {
    await saveHistorySummary(ownerId, conversation.id, summary);
  } catch (err) {
    console.warn(`[history] could not persist the summary for conversation ${conversation.id}:`, err);
  }
  // The route's own snapshot, so the rest of this turn builds from the summary too.
  conversation.historySummary = summary;
  options = historyBuildOptions(conversation);
  messages = await buildHistoryMessages(conversation, ownerId, options);
  summaryMessage = options?.prelude;
  return { messages, summaryMessage, notice: summaryNotice(summary) };
}

/**
 * Models wrap the answer in a think block when they ignore
 * enable_thinking:false (measured on wise-lloa-max — see titleSummary.ts), and
 * a runaway one must not be stored at full length whatever max_tokens did.
 */
function cleanSummary(raw: string): string | null {
  const text = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    // The model copies the "[이전 요약]" marker off the transcript it was given
    // (measured), which then sits under this module's own header as a second,
    // contradictory label. One line, always at the top when it appears.
    .replace(/^\s*\[[^\]\n]{0,40}\]\s*\n/, "")
    .trim();
  if (text.length < MIN_SUMMARY_CHARS) return null;
  if (text.length <= MAX_SUMMARY_CHARS) return text;
  const clipped = text.slice(0, MAX_SUMMARY_CHARS);
  // Cut at the last line break so the stored text never ends mid-sentence.
  const lastBreak = clipped.lastIndexOf("\n");
  return `${lastBreak > MAX_SUMMARY_CHARS / 2 ? clipped.slice(0, lastBreak) : clipped}\n…(길이 제한으로 이후 생략)`;
}

/**
 * The covered messages as plain text, with the previous summary in front of
 * them when there is one.
 *
 * Plain text rather than a message list: the summariser needs what was SAID,
 * and rebuilding the wire messages would re-read every attachment from disk and
 * base64 every image into a prompt that cannot use them. Tool RESULTS are left
 * out for the same reason — they are the biggest thing in a transcript, and the
 * assistant's own answer already carries whatever it took from them.
 */
function transcript(messages: StoredMessage[], previous: HistorySummary | null): string {
  const head: string[] = [];
  let used = 0;
  if (previous) {
    head.push(`[이전 요약 — 이 대화의 첫 메시지 ${previous.coveredMessages}개]\n${previous.text}`);
    used += previous.text.length;
  }

  // An equal share each, floored: 200 short messages must not each claim 1,500
  // characters and blow the transcript cap between them.
  const budget = Math.min(
    MAX_MESSAGE_CHARS,
    Math.max(MIN_MESSAGE_CHARS, Math.floor(MAX_TRANSCRIPT_CHARS / Math.max(1, messages.length))),
  );
  const rendered: string[] = [];
  let skipped = 0;
  // Newest first, so what the cap drops is the oldest — the part the previous
  // summary (when there is one) already covers.
  for (let i = messages.length - 1; i >= 0; i--) {
    const block = renderMessage(messages[i]!, budget);
    if (used + block.length > MAX_TRANSCRIPT_CHARS) {
      skipped = i + 1;
      break;
    }
    used += block.length;
    rendered.push(block);
  }
  rendered.reverse();
  // Said out loud, so the summary does not claim to cover what it never saw.
  if (skipped > 0) head.push(`[길이 제한으로 이 구간의 앞선 메시지 ${skipped}개는 아래에 포함되지 않았습니다.]`);
  return [...head, ...rendered].join("\n\n");
}

function renderMessage(message: StoredMessage, budget: number): string {
  const notes: string[] = [];
  if (message.toolCalls?.length) {
    notes.push(`도구 사용: ${[...new Set(message.toolCalls.map((c) => c.name))].join(", ")}`);
  }
  if (message.attachments?.length) {
    notes.push(`첨부: ${message.attachments.map((a) => a.name).join(", ")}`);
  }
  const who = message.role === "user" ? "사용자" : "어시스턴트";
  const head = notes.length > 0 ? `${who} (${notes.join(" · ")})` : who;
  return `${head}: ${clip(message.content.trim(), budget)}`;
}

/** Head and tail, because a long answer's conclusion is usually at the end. */
function clip(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const head = Math.floor(budget * 0.6);
  const tail = budget - head;
  return `${text.slice(0, head)}\n…(${text.length - budget}자 생략)…\n${text.slice(-tail)}`;
}
