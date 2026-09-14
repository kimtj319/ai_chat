import { config } from "../config.js";
import type { VllmEndpoint } from "../config.js";
import { streamChatCompletion, countPromptTokens, type ChatCompletionRequestBody } from "../vllm/client.js";
import { fitToContextBudget } from "./contextBudget.js";
import { dropImageParts, imagePartCount } from "./historyBuilder.js";
import type { VllmMessage } from "./historyBuilder.js";

/**
 * Compacts a tool-research turn instead of truncating it.
 *
 * The budget ladder (chat/contextBudget.ts) keeps a request inside the window,
 * but its first step replaces an oversized tool result with a 600-char excerpt:
 * a 100KB research result becomes a stub and the research is gone. When the
 * prompt approaches the window while tools are still in play, one extra model
 * call turns the research gathered so far into an interim report, and the turn's
 * context is rebuilt around that report — same space freed, findings kept.
 *
 * Only the OLDER research is summarised. The most recent tool exchanges are the
 * ones the model is actively reasoning about, so they stay verbatim while they
 * fit under config.contextKeepRecentRatio — replacing those with prose loses
 * detail exactly where it is still being used, and the summarisation call gets
 * cheaper too, because the kept exchanges are not sent to it either.
 */

/**
 * Room to ask for the report itself. Two things set this number.
 *
 * Fit: at CONTEXT_COMPACT_RATIO (0.7), 0.7 x 262144 ~= 183.5k input plus this
 * output stays inside the window, so the summarisation call can never be the
 * thing that overflows.
 *
 * Latency: this call is a silent pause in the middle of the user's turn, and it
 * is decode-bound, not prefill-bound, so the cap *is* the worst case. What the
 * report needs scales with the number of facts to emit, not with the size of the
 * input: on a 183,560-token corpus the last of 18 planted facts landed at
 * completion token 713-725, and the last of 12 at 490-502 — about 37 tokens per
 * fact plus ~86 of preamble (32-run sweep, 2026-09-11). 3/3 runs at 2048
 * retained 18/18 facts, the same as 4096, whose median latency was 80.2s; every
 * token past ~725 was paid-for silence. 2048 leaves room for roughly 50 facts
 * and roughly halves the worst-case stall.
 */
const SUMMARY_MAX_TOKENS = 2048;
/** Copying findings out of the context is transcription, not creative writing. */
const SUMMARY_TEMPERATURE = 0.2;
/**
 * The app's own default (DEFAULT_SETTINGS.topP) and Qwen's recommendation for
 * non-thinking mode. Temperature 0.2 with top_p 1.0 is near-greedy decoding,
 * which Qwen's model card warns degenerates into repetition — and a report that
 * repeats is one that burns the whole 8192-token budget.
 */
const SUMMARY_TOP_P = 0.8;
/**
 * Ceiling on how many recent exchange groups may be kept verbatim, and so on how
 * many /tokenize round-trips the split costs (one per candidate, plus one that
 * fails). A /tokenize call on a large message list measured a mean of 2,769ms
 * (232k-token list, the 27B endpoint), so at 4 the split search could stall the
 * turn for ~14s before the summarisation call even starts — silent latency in
 * the middle of the very turn compaction exists to speed up.
 * Two is already past the realistic case: at 0.15 x 262144 ~= 39k tokens, one
 * or two 100KB results (~25k tokens each) fill the allowance, so groups three
 * and four were round-trips that could only ever be refused.
 */
const MAX_KEEP_GROUPS = 2;

/**
 * Korean: this app's conversations are Korean, and the report is read back by
 * the same model in the same turn. It asks for preservation, not prettiness —
 * an "improved" summary that rounds a number or paraphrases a URL is worse than
 * the truncation it replaces, because it still looks authoritative.
 *
 * The last three constraints are the fix for the failure mode that actually
 * loses research. In 5 of 22 full-corpus runs (2026-09-11) the model stopped
 * summarising and transcribed the raw filler rows of the *first* tool result
 * verbatim, never reaching the later groups, and kept 3 of 18 planted facts. It
 * happened at an output budget of 1024 and of 4096 alike, so no budget buys it
 * back — the prompt has to forbid the row-copying, require every tool result to
 * be covered in order, and require sections 3 and 4 to be written (which is also
 * what isSubstantiveSummary() below checks for).
 */
const SUMMARY_INSTRUCTION = `지금까지 이 턴에서 도구로 수집한 내용을 "중간 조사 보고"로 정리하세요. 최종 답변은 아직 쓰지 말고, 아래 네 항목만 채우세요.

1. 원래 질문: 사용자가 물은 것을 한 줄로 다시 적으세요.
2. 확인된 사실: 수집한 구체적 사실·수치·날짜·이름·인용문을 빠짐없이 나열하고, 각 항목 끝에 그 정보가 나온 출처 URL을 함께 적으세요.
3. 이미 확인한 것: 어떤 도구로 무엇을 조회했고 무엇이 확인되었는지.
4. 아직 확인이 필요한 것: 남은 질문, 실패했거나 불충분했던 조회.

제약:
- 평가하거나 해석하지 말고, 미사여구를 붙이지 마세요. 수집한 내용만 옮기세요.
- 구체적인 정보를 버리지 마세요. 숫자·날짜·이름·URL은 원문 그대로 한 글자도 바꾸지 말고 적으세요. 반올림, 단위 변환, 축약, 생략 금지.
- "여러 자료에서", "대부분" 같은 일반화로 구체적인 값을 대체하지 마세요.
- 도구 결과에 없는 내용을 추측해서 채우지 마세요.
- 로그 줄이나 표의 행을 원문 그대로 옮겨 적지 마세요. 반복되는 줄은 건너뛰고 그 안에서 새로 확인된 값만 뽑아 적으세요.
- 도구 결과를 순서대로 하나도 빠뜨리지 말고 모두 다루세요. 첫 번째 결과에 오래 머물지 말고, 각 결과에서 새로 확인된 것만 적은 뒤 다음 결과로 넘어가세요.
- 네 항목을 모두 작성하세요. 2번이 길어져도 3번과 4번을 반드시 적으세요.`;

/**
 * Marks the report as this turn's own working notes, not a finished answer, and
 * says what happened to the original tool output. Two wordings because the model
 * can see which one is true: with recent results still sitting below the report,
 * a header claiming they were all dropped contradicts its own context.
 */
const SUMMARY_HEADER_ALL_DROPPED =
  "지금까지 조사한 내용의 중간 보고입니다. (앞선 도구 결과 원문은 컨텍스트에서 제외되었고, 아래 정리본이 그 대체본입니다.)";
const SUMMARY_HEADER_RECENT_KEPT =
  "지금까지 조사한 내용의 중간 보고입니다. (오래된 도구 결과 원문은 이 보고로 대체되었고, 최근 도구 결과 원문은 아래에 그대로 남아 있습니다.)";

/**
 * "…if you cannot use a tool, answer now" is not padding: by the time this is
 * read again the budget ladder may have stopped offering tools, and a model
 * that asks for one anyway ends the turn with an empty answer.
 */
const CONTINUATION_INSTRUCTION =
  "위 중간 보고에서 이어서 계속 진행하세요. 더 확인할 것이 있으면 도구를 더 사용하고, 충분하거나 도구를 쓸 수 없으면 지금까지 확인한 내용만으로 원래 질문에 대한 최종 답변을 작성하세요.";

export interface CompactionInput {
  endpoint: VllmEndpoint;
  model: string;
  /** The turn's working messages as they stand now; the older part is what gets summarised. */
  messages: VllmMessage[];
  /** system + prior turns + the triggering user message, exactly as this turn started. */
  baseMessages: VllmMessage[];
  /** The model's context window (catalog value); the tokenizer's own value is used when null. */
  contextWindow: number | null;
  /** The turn's abort signal, so Stop cancels the summarisation too. */
  signal: AbortSignal;
}

export interface CompactionResult {
  /** The rebuilt working message list to send from the next request on. */
  messages: VllmMessage[];
  /**
   * The interim report and the continuation instruction. The caller marks these
   * as protected so the budget ladder cannot drop them — see chat/toolLoop.ts.
   */
  protectedMessages: VllmMessage[];
  /** vLLM's own accounting for the summarisation call (0 if it reported none). */
  usage: { promptTokens: number; completionTokens: number };
  /** The summarisation's finish_reason ("stop", "length", …); logged by the caller. */
  finishReason: string | null;
  /** How many recent exchange groups survived verbatim (0 = everything summarised). */
  keptGroups?: number;
}

/** Every image part replaced by the placeholder; messages without images are returned as they are. */
function withoutImages(message: VllmMessage): VllmMessage {
  return imagePartCount(message) > 0 ? dropImageParts(message, imagePartCount(message)) : message;
}

/** One assistant(tool_calls) message plus its tool results; `end` is exclusive. */
interface ExchangeGroup {
  start: number;
  end: number;
}

/**
 * The run of complete exchange groups at the end of the list, oldest first.
 *
 * Scanning backwards and stopping at the first message that is not part of a
 * group is what keeps the kept-verbatim slice contiguous with the end of the
 * list: it is re-appended as one slice, so anything between two groups would
 * otherwise be dropped silently. A half group (an assistant with tool_calls and
 * no results, or results with no assistant) is never returned — either half
 * alone breaks the chat template.
 */
function trailingExchangeGroups(messages: VllmMessage[]): ExchangeGroup[] {
  const groups: ExchangeGroup[] = [];
  let end = messages.length;
  while (end > 0) {
    let head = end - 1;
    while (head >= 0 && messages[head]!.role === "tool") head--;
    if (head < 0 || head === end - 1) break;
    const candidate = messages[head]!;
    if (candidate.role !== "assistant" || !candidate.tool_calls?.length) break;
    groups.unshift({ start: head, end });
    end = head;
  }
  return groups;
}

/**
 * A later section (3 or 4) has been started: its number at the start of a line,
 * with or without Markdown list/heading/emphasis markup in front of it…
 */
const SUMMARY_LATER_SECTION = /^[ \t]*(?:[-*>#]+[ \t]*)?(?:\*\*)?[ \t]*[34][ \t]*[.)]/m;
/**
 * …or its title from SUMMARY_INSTRUCTION, for the reports that write the
 * headings without renumbering them. One measured report (finish_reason=stop,
 * 783 tokens, a complete four-part report) was thrown away by the numbered form
 * alone, and a false rejection costs more than a lenient one: it falls back to
 * the ladder, which shreds the same tool results into 600-char excerpts.
 */
const SUMMARY_LATER_HEADING = /이미 확인한 것|확인이 필요한 것/;

/**
 * Is this report worth keeping?
 *
 * Not a length test. Measured 2026-09-11 on a 183,560-token corpus with 18
 * planted facts: at output budgets of 1024 and 2048 *every* run ended with
 * finish_reason "length" and at 4096 three of six did, yet most of them carried
 * all 18 facts. Rejecting on finish_reason would throw those away and fall back
 * to the ladder, which shreds the same tool results into 600-char excerpts —
 * strictly worse than a report whose trailing section was clipped.
 *
 * The failure that does destroy research is different: in 5 of 22 runs the model
 * transcribed the raw filler rows of the first tool result verbatim, never
 * reached the later tool results, and kept 3 of 18 facts. Those runs never get
 * out of section 2, because copying rows is unbounded. So the test is structural
 * and deterministic: SUMMARY_INSTRUCTION asks for four numbered sections and
 * says explicitly to write 3 and 4, and a report that has started one of them
 * has by definition stopped enumerating and moved on. At 2048 tokens — room for
 * ~50 facts at the measured ~37 tokens each — a report still inside section 2 at
 * the cap is dwelling, not merely thorough.
 */
function isSubstantiveSummary(summary: string): boolean {
  return SUMMARY_LATER_SECTION.test(summary) || SUMMARY_LATER_HEADING.test(summary);
}

/**
 * Summarise the turn's older research and return the rebuilt working messages.
 *
 * Throws on any failure — an empty report, a degenerate one (see
 * isSubstantiveSummary), a dead endpoint, a client abort —
 * and the caller falls back to the existing ladder (an abort is re-thrown as
 * such so the turn's abort path, not the failure path, handles it). "Every
 * exchange is recent enough to keep" throws the same way: there is nothing to
 * summarise, and the ladder is a better answer than a model call that frees
 * nothing.
 */
export async function compactResearchContext(input: CompactionInput): Promise<CompactionResult> {
  const groups = trailingExchangeGroups(input.messages);
  let splitIndex = input.messages.length;
  let keptGroups = 0;
  if (groups.length > 0) {
    // Everything is measured on top of baseMessages and counted as the delta,
    // for two reasons. The groups alone cannot be measured at all: /tokenize
    // applies the chat template, and a list with no user message comes back
    // 400 "No user query found in messages." (measured against
    // the 27B endpoint). And the delta is the number that matters anyway — what
    // the kept groups will add to the rebuilt prompt, template markup included.
    const base = await countPromptTokens(input.endpoint, input.model, input.baseMessages, undefined, input.signal);
    const window = input.contextWindow ?? base.maxModelLen;
    // No window, or an estimate instead of a real count (tokenizer outage):
    // keeping a slice whose size is a guess is how compaction ends up freeing
    // nothing, so summarise everything, which is what this always did.
    const allowance = window === null || !base.exact ? 0 : window * config.contextKeepRecentRatio;
    // Newest group first, growing the candidate by one whole group at a time
    // and stopping at the first that does not fit: a 100KB JSON tool result is
    // ~25k tokens, so one group too many is the difference between freeing the
    // window and refilling it.
    for (let i = groups.length - 1; i >= 0 && keptGroups < MAX_KEEP_GROUPS && allowance > 0; i--) {
      const candidate = [...input.baseMessages, ...input.messages.slice(groups[i]!.start)];
      const count = await countPromptTokens(input.endpoint, input.model, candidate, undefined, input.signal);
      if (!count.exact || count.tokens - base.tokens > allowance) break;
      splitIndex = groups[i]!.start;
      keptGroups = groups.length - i;
    }
  }

  const olderMessages = input.messages.slice(0, splitIndex);
  const keptMessages = input.messages.slice(splitIndex);
  // Nothing older than the kept exchanges means the report would summarise the
  // question and the prior turns only. A summarisation call measures 65-210s
  // against the 27B endpoint; paying that to free nothing is worse than the
  // ladder, so tell the caller the same way a failure is told.
  if (!olderMessages.some((m) => m.role === "assistant" && m.tool_calls?.length)) {
    throw new Error("nothing older than the kept tool results to summarise");
  }

  // Belt and braces: a pathological turn (one enormous prior history) could put
  // even this request over the window, and a 400 here would waste the call.
  // The ladder's notices are dropped on purpose — they describe this internal
  // request, not anything the user asked for.
  // Only the older half is sent: the kept exchanges are already staying, so
  // paying to prefill them here would be paying twice for the same tokens.
  const fit = await fitToContextBudget({
    endpoint: input.endpoint,
    model: input.model,
    // Images go to the summariser as the placeholder, in this copy only. The
    // report is transcription of tool results — an image cannot be transcribed
    // into it, so sending one buys nothing and costs its tokens twice (here and
    // again in the rebuilt list) plus the /tokenize penalty image content
    // carries. The rebuilt list below starts from input.baseMessages, which
    // still holds them verbatim.
    messages: [...olderMessages.map(withoutImages), { role: "user", content: SUMMARY_INSTRUCTION }],
    desiredMaxTokens: SUMMARY_MAX_TOKENS,
    contextWindow: input.contextWindow,
    signal: input.signal,
  });

  const body: ChatCompletionRequestBody = {
    model: input.model,
    messages: fit.messages,
    stream: true,
    stream_options: { include_usage: true },
    temperature: SUMMARY_TEMPERATURE,
    top_p: SUMMARY_TOP_P,
    max_tokens: fit.maxTokens,
    presence_penalty: 0,
    frequency_penalty: 0,
    // No tools: this call must not start another research round.
    // No thinking either — the work is transcription, and thinking here is
    // latency the user waits through mid-turn for nothing.
    chat_template_kwargs: { enable_thinking: false },
  };

  let summary = "";
  let finishReason: string | null = null;
  const usage = { promptTokens: 0, completionTokens: 0 };
  const stream = await streamChatCompletion(body, input.signal, input.endpoint);
  for await (const chunk of stream) {
    if (input.signal.aborted) throw new Error("aborted-by-user");
    if (chunk.usage) {
      usage.promptTokens += chunk.usage.prompt_tokens ?? 0;
      usage.completionTokens += chunk.usage.completion_tokens ?? 0;
    }
    // Reasoning deltas are ignored: only the report survives this call.
    const choice = chunk.choices?.[0];
    if (choice?.delta?.content) summary += choice.delta.content;
    if (choice?.finish_reason) finishReason = choice.finish_reason;
  }
  if (summary.trim().length === 0) throw new Error("summarisation returned no content");
  if (!isSubstantiveSummary(summary)) {
    console.warn(
      `[compact] discarding a degenerate summary: it never reached section 3 or 4 of the report ` +
        `(finish_reason=${finishReason}, ${usage.completionTokens} completion tokens, ${summary.length} chars)`,
    );
    throw new Error("summarisation never reached the later sections of the report");
  }

  // … user -> assistant(report) -> user(continue) -> the kept exchanges in their
  // original order, which is the ordinary shape of a turn that called tools
  // after a user message. No group is ever split: the kept slice starts at an
  // assistant(tool_calls) and carries its own tool results, so the rebuilt list
  // has no orphan on either side.
  const header = keptMessages.length > 0 ? SUMMARY_HEADER_RECENT_KEPT : SUMMARY_HEADER_ALL_DROPPED;
  const report: VllmMessage = { role: "assistant", content: `${header}\n\n${summary.trim()}` };
  const continuation: VllmMessage = { role: "user", content: CONTINUATION_INSTRUCTION };
  return {
    messages: [...input.baseMessages, report, continuation, ...keptMessages],
    protectedMessages: [report, continuation],
    usage,
    finishReason,
    keptGroups,
  };
}
