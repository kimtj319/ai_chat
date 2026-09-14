import { resolveModel, streamChatCompletion, type ChatCompletionRequestBody } from "../vllm/client.js";

/**
 * A short name for a conversation, summarised from the request that started it.
 *
 * The fallback everywhere else is the first message clipped to 40 characters,
 * which for a long question is the opening clause and nothing about the
 * subject — "'한글'과 '한글' 두 문자열이 눈으로는 같은데 비교…" tells a reader
 * scanning the sidebar nothing they can use. This asks the model for a name
 * instead.
 *
 * Everything here is written so a failure costs nothing: it never throws, it
 * caps its own output, and a refusal, an empty answer or a model that ignores
 * the instruction all return null and leave the clipped title in place. It
 * runs beside the answer rather than before it, so the user never waits on it.
 */

const MAX_TITLE_CHARS = 28;
/** Room for the title plus the slop a model adds before you cut it off. */
const MAX_TOKENS = 40;
/**
 * Second attempt, for a model that thinks anyway.
 *
 * `enable_thinking: false` is a request, not a guarantee: wise-lloa-max
 * answered this prompt with reasoning_content and no content at all, hit the
 * 40-token ceiling mid-thought, and the conversation kept its clipped title.
 * Given room to finish thinking it produces the title after it. Once, and only
 * when the first attempt actually showed that behaviour — every model that
 * honours the flag still costs 40 tokens.
 */
const THINKING_RETRY_MAX_TOKENS = 512;
/** Past this there is no more subject to find, and the prompt stays cheap. */
const MAX_REQUEST_CHARS = 800;

const INSTRUCTION = [
  "아래는 사용자가 새 대화에서 보낸 첫 요청이다. 대화 목록에서 이 대화를 알아볼 수 있도록 제목을 지어라.",
  "",
  "- 한국어 명사구 하나로, 공백 포함 " + MAX_TITLE_CHARS + "자 이내.",
  "- 요청의 주제를 말한다. 인사말, \"질문\", \"요청\", \"방법\" 같은 군더더기는 빼라.",
  "- 따옴표로 감싸지 말고, 마침표로 끝내지 마라.",
  "- 제목만 출력한다. 설명이나 다른 문장을 덧붙이지 마라.",
  "",
  "요청:",
].join("\n");

/**
 * Models say "제목: X", wrap the thing in quotes, or add a line of commentary
 * underneath. Take the first line, strip the decorations, and cut to length.
 */
function cleanTitle(raw: string): string | null {
  let text = raw.trim();
  // A thinking model that ignored enable_thinking:false leaves its block here.
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const firstLine = text.split("\n").map((line) => line.trim()).find((line) => line.length > 0);
  if (!firstLine) return null;
  text = firstLine
    .replace(/^(제목|title)\s*[:：]\s*/i, "")
    .replace(/^["'“”‘’「『]+|["'“”‘’」』]+$/g, "")
    .replace(/[.。]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length === 0) return null;
  // A model that answered the question instead of naming it produces a
  // paragraph; clipping that would just be the old behaviour with extra
  // latency, so it is rejected outright.
  if (text.length > MAX_TITLE_CHARS * 3) return null;
  return text.length > MAX_TITLE_CHARS ? `${text.slice(0, MAX_TITLE_CHARS)}…` : text;
}

export async function summariseConversationTitle(
  request: string,
  requestedModel: string,
  signal: AbortSignal,
): Promise<string | null> {
  const trimmed = request.trim();
  if (trimmed.length === 0) return null;

  try {
    const { model, endpoint } = await resolveModel(requestedModel);
    const prompt = `${INSTRUCTION}\n${trimmed.slice(0, MAX_REQUEST_CHARS)}`;

    async function attempt(maxTokens: number): Promise<{ text: string; thought: boolean }> {
      const body: ChatCompletionRequestBody = {
        model,
        messages: [{ role: "user", content: prompt }],
        stream: true,
        // Required by the request type. Nothing here reads the usage back — the
        // turn beside this one is what reports tokens — but the field is part of
        // the shape every call to this endpoint sends.
        stream_options: { include_usage: true },
        temperature: 0.2,
        top_p: 0.9,
        max_tokens: maxTokens,
        presence_penalty: 0,
        frequency_penalty: 0,
        // Naming something is not a reasoning task, and thinking tokens here are
        // latency and load spent beside a turn the user is actually waiting for.
        // Not every model obeys it; see THINKING_RETRY_MAX_TOKENS.
        chat_template_kwargs: { enable_thinking: false },
      };

      let text = "";
      let thought = false;
      const stream = await streamChatCompletion(body, signal, endpoint);
      for await (const chunk of stream) {
        if (signal.aborted) break;
        const delta = chunk.choices?.[0]?.delta;
        if (delta?.reasoning ?? delta?.reasoning_content) thought = true;
        if (delta?.content) text += delta.content;
      }
      return { text, thought };
    }

    const first = await attempt(MAX_TOKENS);
    if (signal.aborted) return null;
    const title = cleanTitle(first.text);
    if (title) return title;
    // No title AND it spent the budget thinking: the only case worth paying for
    // a second call, and the one measured on wise-lloa-max.
    if (!first.thought) return null;
    const second = await attempt(THINKING_RETRY_MAX_TOKENS);
    if (signal.aborted) return null;
    return cleanTitle(second.text);
  } catch (err) {
    // Including an abort: the user stopping the answer should not produce an
    // error line about a title nobody asked for.
    console.warn("[title] could not summarise a conversation title:", err instanceof Error ? err.message : err);
    return null;
  }
}
