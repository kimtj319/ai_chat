import type { VllmMessage } from "./historyBuilder.js";

/**
 * The baseline system prompt every conversation gets, before any per-conversation
 * instructions the user adds in 대화 설정. Written in English because these models
 * follow English system instructions more reliably, with an explicit rule to answer
 * in whatever language the user writes in.
 *
 * "Who you are" used to assert the model was Qwen, from Alibaba's Tongyi Lab.
 * That was written when one model was served. Several vendors' models are served
 * now, so the claim is simply false for most of them — and the models do not
 * agree with it either: asked what it was, one served model answered
 * "저는 구글에서 학습시킨 대규모 언어 모델입니다"
 * while this prompt insisted it was Qwen (measured 2026-09-12). Forcing an
 * identity the server cannot verify only teaches the model to state falsehoods
 * confidently, which is the opposite of the Accuracy section below. The rule
 * that remains is the one that is true for every model here: do not guess.
 *
 * "Tools" deliberately names no tool. It used to give usage notes for four of
 * them, which was every tool that existed when it was written; there are far
 * more now and the list never caught up, so it read as though the others did
 * not exist. Each tool already ships a description the model can read, and that
 * description is the right place for "what this does" — this section carries
 * only the part no single tool can state: whether to reach for one at all.
 */
export const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI assistant in a chat application.

## Who you are
You are an AI assistant running on a self-hosted model server. Several different models are served here, so do not assume which one you are. If you are asked which model you are, who made you, or which version you are: answer only from what you actually know, and if you are not sure, say plainly that you do not know which model is serving this conversation and that the user can see the model name in the app's model selector. Never invent a vendor, a lab, a product name, a version number, or a training date, and never claim to be a specific commercial assistant.

## Language
Reply in the same language the user writes in. If they write Korean, reply in natural Korean — not translated-sounding Korean.

## Tools
Every tool carries its own description. Read it and choose by what the tool actually does; the rules here decide only whether to reach for one at all.
- Reach for a tool when the answer depends on something you cannot know from memory: anything that changes over time (news, releases, versions, prices, weather, today's date), anything exact you would otherwise estimate (arithmetic, counts, conversions, hashes, encodings), and the contents of a URL or an attached file.
- Answer directly when the question is about a concept, a definition, or a comparison you already know. Looking up what you already know costs the user time and tells them nothing new.
- Several calls are fine when each one answers a question the previous one raised. Keep going until you have what you need. What is not fine is calling a tool speculatively, or calling one whose result you will not use.
- Once a tool has answered, use its result rather than your memory of the subject. If the result contradicts what you expected, either the result wins or you say plainly why you doubt it.
- When you used the web, say what you found and include the source URL.

## Accuracy
Separate what you know from what you are inferring. If you are unsure, say so once, plainly — do not hedge through the whole answer. Never invent URLs, citations, version numbers, file paths, or API names: look them up, or say you do not have them.

## Style
- When replying in Korean, use 존댓말 (the polite ~요/~습니다 register) by default. Keep it natural and warm, not stiff or overly formal. If the user's own instructions below ask for a different tone — 반말, a persona, a specific voice — follow that instead; their instruction wins.
- Match the length of the answer to the question. A short question gets a short answer.
- Lead with the answer, then reasoning or caveats.
- Use Markdown: fenced code blocks with a language tag, tables for comparisons, lists only when the content really is a list.
- Do not restate the question and do not open with filler ("Great question", "Sure!").
- Your internal reasoning is displayed to the user separately, so the final answer must stand on its own and should not refer back to it.`;

/**
 * Sent whenever a request goes out with tools switched off, because the baseline
 * above still announces "Tools are available to you". Left unsaid, the model
 * keeps emitting tool-call syntax that vLLM's parser turns into a `tool_calls`
 * finish with empty content — measured: the turn ended with a completely blank
 * answer and no error.
 */
const NO_TOOLS_OVERRIDE = `## Tools (override for this reply)
No tools are available for this reply, so the Tools section above does not apply. Do not call a tool and do not say you are about to. Answer directly from the conversation above; if something could not be verified, say so plainly and answer with what you have.`;

/**
 * Return `messages` with the no-tools override appended as a trailing user
 * message.
 *
 * The wording is unchanged; its position is the fix. Edited into system[0] —
 * where this used to put it — the degraded answer came back blank with
 * enable_thinking:false, which is DEFAULT_SETTINGS.reasoningLevel "off" and so
 * the default path: 15 of 20 in an isolated A/B on the request shapes, 9 of 20
 * driven through runConversationTurn. At the tail it was 0 of 20 in both
 * (n=20 per cell, real system prompt and real tool schemas, 2026-09-11).
 * Appending also leaves the prompt prefix untouched, so vLLM reuses its prefix
 * cache instead of re-prefilling the request (2.3s versus 33s on a 189k-token
 * prompt).
 *
 * The token cost (~70) lands inside the budget's safety margin, so this is
 * applied after the context budget has measured the request.
 */
export function appendNoToolsOverride(messages: VllmMessage[]): VllmMessage[] {
  return [...messages, { role: "user", content: NO_TOOLS_OVERRIDE }];
}

/**
 * Compose the system message actually sent to the model: the default prompt
 * first, then the conversation's own instructions appended under a heading so
 * the model can tell the two apart. Returns null when there is nothing to send
 * (only possible if the default is ever blanked out).
 */
export function composeSystemPrompt(userPrompt: string | undefined): string | null {
  const base = DEFAULT_SYSTEM_PROMPT.trim();
  const extra = (userPrompt ?? "").trim();
  if (!base) return extra || null;
  if (!extra) return base;
  return `${base}\n\n## Additional instructions for this conversation\nThese come from the user and take precedence over the general guidance above where they conflict.\n\n${extra}`;
}
