import crypto from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import {
  getConversation,
  mutateConversation,
  DEFAULT_CONVERSATION_TITLE,
  isDefaultConversationTitle,
} from "../storage/conversationStore.js";
import { isValidId } from "../storage/paths.js";
import {
  getAttachmentMeta,
  referencedAttachmentIds,
  sweepConversationAttachments,
} from "../storage/attachmentStore.js";
import { attachmentBudget, describeCost } from "../attachments/budget.js";
import { resolveModel } from "../vllm/client.js";
import { modelAccessFor, endpointForOwner, ModelKeyRequiredError } from "../vllm/access.js";
import { CANCELLED_BY_CLIENT, runConversationTurn } from "../chat/toolLoop.js";
import { assistantMessageFromTurn } from "../chat/turnMessage.js";
import { compactionSettled } from "../chat/compactionProgress.js";
import { summariseConversationTitle } from "../chat/titleSummary.js";
import { detectProhibition } from "../chat/prohibitionDetect.js";
import { appendPending } from "../storage/prohibitionsStore.js";
import { runEmbeddingTurn } from "../chat/embeddingTurn.js";
import { addWireUsage, sideUsageMeter, type WireUsage } from "../chat/turnUsage.js";
import { config } from "../config.js";
import type {
  Conversation,
  ConversationSettings,
  HistorySummary,
  StoredMessage,
  ConversationKind,
  MessageAttachment,
  MessageEmbedding,
} from "../types.js";
import { checkEnabledTools, checkSettings } from "./conversationFields.js";
import { activeAnswerNowSignals, activeStreams } from "./turnSignals.js";

/** A first message longer than this is clipped for the title written before the answer starts. */
const TITLE_CLIP_CHARS = 40;
/** Comment padding written before the first event; see openEventStream. */
const SSE_PADDING_BYTES = 2048;
/** How often a comment line goes out while nothing else does; see openEventStream. */
const HEARTBEAT_INTERVAL_MS = 15_000;
/** The prohibition check runs beside the answer, on its own clock rather than the turn's. */
const PROHIBITION_DETECT_TIMEOUT_MS = 120_000;

/**
 * Turn a vLLM failure into something the person reading it can act on.
 *
 * A message longer than the window comes back as the server's own English
 * sentence — "This model's maximum context length is 262144 tokens..." — which
 * is both untranslated and about a number the reader never chose. An attachment
 * in the same situation is refused up front with a Korean reason, so this is the
 * one path where the same mistake reads like a crash. The length is not checked
 * before sending because only the tokenizer knows it; the error it produces is
 * where the truth arrives, so that is where it is explained.
 *
 * Anything unrecognised is passed through untouched: an invented Korean message
 * for an error nobody has seen would be worse than the original.
 */
function readableTurnError(message: string): string {
  if (/maximum context length|context length is|reduce the length of the messages/i.test(message)) {
    return "메시지가 모델의 컨텍스트 한도를 넘습니다. 내용을 나눠서 보내거나 첨부로 올린 뒤 다시 시도해 주세요.";
  }
  return message;
}

/**
 * What the assistant message says in a transcript that only renders `content`.
 * The vector itself is on `message.embedding` for a client that can draw it;
 * this is the one line that makes the conversation readable without one.
 */
function describeEmbedding(embedding: MessageEmbedding): string {
  const head = `${embedding.dimensions}차원 임베딩을 생성했습니다.`;
  if (embedding.cosineToPrevious === null) return head;
  return `${head} 직전 임베딩과의 코사인 유사도: ${embedding.cosineToPrevious.toFixed(4)}`;
}

function titleFromContent(content: string): string {
  const collapsed = content.trim().replace(/\s+/g, " ");
  if (collapsed.length <= TITLE_CLIP_CHARS) return collapsed || DEFAULT_CONVERSATION_TITLE;
  return `${collapsed.slice(0, TITLE_CLIP_CHARS)}…`;
}

/** Index of the last user message, or -1. */
function lastUserIndex(messages: StoredMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return i;
  }
  return -1;
}

/** A refusal decided before anything is written or streamed: an ordinary JSON error. */
interface Refusal {
  ok: false;
  status: number;
  body: Record<string, unknown>;
}

function refusal(status: number, body: Record<string, unknown>): Refusal {
  return { ok: false, status, body };
}

/** Everything a turn needs once the request has passed every check. */
interface TurnPlan {
  ok: true;
  turnKind: ConversationKind;
  resolved: Awaited<ReturnType<typeof resolveModel>>;
  /** The stored message a regenerate re-runs, or null for an ordinary send. */
  regenerateTarget: StoredMessage | null;
  /** What this turn asks. */
  content: string;
  attachments: MessageAttachment[];
  userMessage: StoredMessage;
  settingsPatch: Partial<ConversationSettings> | undefined;
  enabledToolsPatch: string[] | undefined;
}

/** Validation for POST /messages: every refusal that can be decided before the transcript is touched. */
async function prepareTurn(req: Request<{ id: string }>): Promise<Refusal | TurnPlan> {
  const { id } = req.params;
  if (!isValidId(id)) return refusal(404, { error: "Not found" });

  const body = req.body ?? {};
  const regenerate = body.regenerate === true;
  const rawContent = typeof body.content === "string" ? body.content : "";
  // Deduplicated: the same file attached twice would be sent to the model twice.
  // A regenerate keeps the stored message's attachments, so none are read from the body.
  const attachmentIds =
    !regenerate && Array.isArray(body.attachmentIds)
      ? [...new Set((body.attachmentIds as unknown[]).filter((value): value is string => typeof value === "string"))]
      : [];
  // An attachment-only message is a real message ("what is in this picture?"
  // needs no words), so the emptiness check now covers both.
  if (!regenerate && rawContent.trim().length === 0 && attachmentIds.length === 0) {
    return refusal(400, { error: "content must be a non-empty string" });
  }
  if (attachmentIds.length > config.attachmentMaxPerMessage) {
    return refusal(400, {
      error: `한 메시지에는 첨부를 ${config.attachmentMaxPerMessage}개까지 넣을 수 있습니다.`,
      code: "too_many",
    });
  }

  // Loaded up front, always: which model this conversation uses decides what
  // kind of turn this is (chat or embedding) before anything is written.
  const existing = await getConversation(req.ownerId, id);
  if (!existing) return refusal(404, { error: "Not found" });

  // The message a regenerate re-runs. Refused while another turn is streaming:
  // that turn appends its answer (and possibly a history summary) to the
  // transcript this one is about to cut, so the two would interleave.
  let regenerateTarget: StoredMessage | null = null;
  if (regenerate) {
    if (activeStreams.has(id)) {
      return refusal(409, { error: "이 대화에서 답변이 진행 중입니다. 끝난 뒤 다시 시도해 주세요.", code: "turn_in_progress" });
    }
    regenerateTarget = existing.messages[lastUserIndex(existing.messages)] ?? null;
    if (!regenerateTarget) {
      return refusal(400, { error: "다시 생성할 사용자 메시지가 없습니다.", code: "no_user_message" });
    }
  }
  // What this turn asks: the body's text, or — for a plain regenerate — the
  // stored question unchanged.
  const content = regenerateTarget && rawContent.trim().length === 0 ? regenerateTarget.content : rawContent;
  const attachmentCount = regenerateTarget ? (regenerateTarget.attachments?.length ?? 0) : attachmentIds.length;

  let resolved;
  try {
    resolved = await resolveModel(existing.model, (await modelAccessFor(req.user)).allows);
  } catch (err) {
    return refusal(502, { error: err instanceof Error ? err.message : "모델 서버에 연결하지 못했습니다." });
  }

  // The model's capability is measured, not declared (vllm/capability.ts).
  if (resolved.capability === "rerank") {
    // A reranker takes a query plus a list of documents and scores them; there
    // is nothing in a chat composer that expresses that. Refused here with a
    // sentence the user can act on, instead of forwarding the gateway's raw
    // 400 "does not support Chat Completions".
    return refusal(400, {
      error: `${resolved.model} 은(는) 재순위(rerank) 전용 모델이라 대화에 사용할 수 없습니다. 질의와 문서 목록이 함께 필요합니다. 다른 모델을 선택해 주세요.`,
      code: "rerank_unsupported",
    });
  }
  // 기본(wise) 모델은 AI Product 가 아니면 본인 키로 보낸다(vllm/access.ts). 키가 없으면
  // 질문을 저장하기 전에 무엇을 하면 되는지와 함께 돌려보낸다. 이 턴이 쓰는 엔드포인트는
  // 그 사람의 키가 실린 것이다(임베딩 턴이 그대로 쓴다).
  try {
    resolved = { ...resolved, endpoint: await endpointForOwner(resolved.endpoint, req.ownerId) };
  } catch (err) {
    if (err instanceof ModelKeyRequiredError) return refusal(400, { error: err.message, code: "model_key_required" });
    throw err;
  }
  const turnKind: ConversationKind = resolved.capability === "embedding" ? "embedding" : "chat";
  // A conversation takes its kind from its first message and keeps it: an
  // embedding turn and a chat turn store completely different messages, and
  // interleaving them makes a transcript nobody can read.
  if (existing.kind && existing.kind !== turnKind) {
    return refusal(409, {
      error:
        existing.kind === "chat"
          ? "이 대화는 채팅 대화입니다. 임베딩 모델을 쓰려면 새 대화를 시작해 주세요."
          : "이 대화는 임베딩 대화입니다. 채팅 모델을 쓰려면 새 대화를 시작해 주세요.",
      code: "capability_mismatch",
    });
  }
  if (turnKind === "embedding" && attachmentCount > 0) {
    return refusal(400, {
      error: "임베딩 모델은 첨부 파일을 처리하지 않습니다. 텍스트만 입력해 주세요.",
      code: "embedding_no_attachments",
    });
  }
  if (turnKind === "embedding" && content.trim().length === 0) {
    return refusal(400, { error: "임베딩할 텍스트를 입력해 주세요.", code: "invalid_input" });
  }

  const attachments: MessageAttachment[] = regenerateTarget?.attachments ? [...regenerateTarget.attachments] : [];
  for (const attachmentId of attachmentIds) {
    const meta = isValidId(attachmentId) ? await getAttachmentMeta(req.ownerId, id, attachmentId) : null;
    if (!meta) {
      return refusal(404, { error: `첨부를 찾을 수 없습니다 (${attachmentId}). 다시 올려 주세요.` });
    }
    attachments.push(meta);
  }
  if (attachments.length > 0) {
    const attachmentBytes = attachments.reduce((sum, a) => sum + a.bytes, 0);
    if (attachmentBytes > config.attachmentMaxMessageBytes) {
      return refusal(413, {
        error: `한 메시지의 첨부 용량 한도(${(config.attachmentMaxMessageBytes / (1024 * 1024)).toFixed(0)}MB)를 넘습니다.`,
        code: "too_large",
      });
    }
    // The token ceiling is derived from the window this conversation's own model
    // reports, not from a constant: the same six files may fit one model and not
    // another. Refused here, before the turn starts, so nothing is spent on a
    // prompt that cannot be answered.
    const budget = attachmentBudget(resolved.maxModelLen);
    const attachmentTokens = attachments.reduce((sum, a) => sum + (a.estimatedTokens ?? 0), 0);
    if (attachmentTokens > budget.messageTokens) {
      return refusal(413, {
        // Every file with its own cost: with six attached, "too large" alone
        // does not tell the user which one to drop.
        error:
          `첨부가 모델 컨텍스트 한도를 넘습니다: ${attachments.map((a) => describeCost(a.name, a.estimatedTokens ?? 0)).join(", ")} ` +
          `(합계 ${attachmentTokens.toLocaleString("en-US")}토큰, 한 메시지 허용 ${budget.messageTokens.toLocaleString("en-US")}토큰` +
          `${budget.fallback ? ", 모델이 컨텍스트 길이를 알려주지 않아 기본값 적용" : ` = 컨텍스트 ${budget.contextWindow?.toLocaleString("en-US")}의 ${Math.round(config.attachmentMessageTokenRatio * 100)}%`}). ` +
          "일부 파일을 빼고 다시 보내 주세요.",
        code: "too_large",
      });
    }
  }

  // The composer sends the model controls along with the message, and what is
  // stored here is what goes to vLLM on this turn AND on every later one — so
  // it goes through the same check PATCH uses, and is refused before anything
  // is written or streamed rather than after the conversation is already broken.
  const checkedSettings = checkSettings(body.settings);
  if (!checkedSettings.ok) return refusal(400, { ...checkedSettings.problem });
  const checkedTools = checkEnabledTools(body.enabledTools);
  if (!checkedTools.ok) return refusal(400, { ...checkedTools.problem });

  // A regenerate keeps the stored message's id, attachments and createdAt; only
  // an edit changes its content.
  const userMessage: StoredMessage = regenerateTarget
    ? { ...regenerateTarget, content }
    : {
        id: crypto.randomUUID(),
        role: "user",
        content,
        ...(attachments.length > 0 ? { attachments } : {}),
        createdAt: new Date().toISOString(),
      };

  return {
    ok: true,
    turnKind,
    resolved,
    regenerateTarget,
    content,
    attachments,
    userMessage,
    settingsPatch: checkedSettings.value,
    enabledToolsPatch: checkedTools.value,
  };
}

/**
 * What a regenerate cut from the transcript: the question as it was and
 * everything after it, plus the summary the cut discarded. Kept until the new
 * answer has produced something, so a regenerate that is stopped or fails
 * before its first word can put the previous answer back (restoreRewound).
 */
interface Rewound {
  messages: StoredMessage[];
  historySummary?: HistorySummary;
}

/**
 * Write the user's message (and, for a regenerate, cut what followed it) under
 * the conversation's lock. `clippedTitle` is the title written now when this is
 * the conversation's first message, or null.
 */
async function appendUserMessage(
  ownerId: string,
  id: string,
  plan: TurnPlan,
): Promise<Refusal | { ok: true; afterUser: Conversation; clippedTitle: string | null; rewound: Rewound | null }> {
  const { regenerateTarget, turnKind, settingsPatch, enabledToolsPatch, content, attachments, userMessage } = plan;
  let clippedTitle: string | null = null;
  let rewound: Rewound | null = null;
  // Set when the transcript changed between the read above and the lock below.
  let regenerateConflict = false;
  const afterUser = await mutateConversation(ownerId, id, (conv) => {
    if (regenerateTarget) {
      const index = lastUserIndex(conv.messages);
      // Checked again under the lock: another tab may have started a turn or
      // sent a newer message since the conversation was read.
      if (activeStreams.has(id) || conv.messages[index]?.id !== regenerateTarget.id) {
        regenerateConflict = true;
        return conv;
      }
      // 요약(chat/historySummary.ts)은 늘 사용자 메시지 바로 앞에서 끊긴다
      // (planCoverage) — 이 질문에 답하던 턴이 만든 요약도 이 질문 "앞" 까지만
      // 덮는다. 그래서 그런 요약은 그대로 둔다: 지우면 다시 돌리는 바로 이 턴이
      // 같은 요약을 또 만드느라 기다린다. 덮는 범위가 이 질문 이후까지 닿거나
      // (편집한 글이 요약 속 옛 글에 가려진다) 끊는 지점이 더는 없는 요약만 버린다.
      const summary = conv.historySummary;
      rewound = { messages: conv.messages.slice(index) };
      if (summary) {
        const through = conv.messages.findIndex((m) => m.id === summary.throughMessageId);
        if (through < 0 || through >= index) {
          rewound.historySummary = summary;
          delete conv.historySummary;
        }
      }
      conv.messages = conv.messages.slice(0, index);
    }
    // Locked in on the first message, then never changed (the mismatch check
    // above refuses anything else).
    if (!conv.kind) conv.kind = turnKind;
    if (settingsPatch) conv.settings = { ...conv.settings, ...settingsPatch };
    if (enabledToolsPatch) conv.enabledTools = enabledToolsPatch;
    if (conv.messages.length === 0 && isDefaultConversationTitle(conv.title)) {
      // An attachment-only message has no words to title the conversation with,
      // so the first attachment's name is the next best handle.
      //
      // Clipped, and written NOW: the sidebar lists a conversation as soon as
      // it has a title, and the point is that the row appears when the request
      // starts rather than when the answer lands. A summarised name replaces
      // this one (renameFromSummary), once the model has produced it.
      clippedTitle = titleFromContent(content.trim() || attachments[0]?.name || "");
      conv.title = clippedTitle;
    }
    conv.messages.push(userMessage);
    return conv;
  });

  if (!afterUser) return refusal(404, { error: "Not found" });
  if (regenerateConflict) {
    return refusal(409, { error: "대화가 그사이 바뀌었습니다. 새로 고친 뒤 다시 시도해 주세요.", code: "conversation_changed" });
  }
  return { ok: true, afterUser, clippedTitle, rewound };
}

/**
 * Undo a regenerate that produced nothing: put back the question and answer it
 * cut, in place of the question it re-ran. Only while that question is still
 * the transcript's last message — anything written after it (another tab's
 * turn) is newer than what this would restore. True when it was put back.
 *
 * A summary the cut discarded comes back only if the turn did not write a new
 * one; a new one still ends before this question, so it stays valid either way.
 */
async function restoreRewound(ownerId: string, id: string, userMessageId: string, rewound: Rewound): Promise<boolean> {
  let restored = false;
  await mutateConversation(ownerId, id, (conv) => {
    const last = conv.messages.length - 1;
    if (conv.messages[last]?.id !== userMessageId) return conv;
    conv.messages = [...conv.messages.slice(0, last), ...rewound.messages];
    if (rewound.historySummary && !conv.historySummary) conv.historySummary = rewound.historySummary;
    restored = true;
    return conv;
  });
  return restored;
}

/**
 * Switch the response to an event stream and keep it flowing. Returns `send`
 * (a no-op once the client is gone) and `stopHeartbeat`.
 */
function openEventStream(res: Response): { send: (payload: unknown) => void; stopHeartbeat: () => void } {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // nginx and friends: do not buffer this response.
    "X-Accel-Buffering": "no",
    // Chrome holds the first ~1KB of a response while it MIME-sniffs, which
    // makes a stream look like it arrives all at once. nosniff disables that.
    "X-Content-Type-Options": "nosniff",
  });
  // Get the headers onto the wire before the first event, so the client can
  // open the stream immediately instead of waiting on the response body.
  res.flushHeaders?.();
  // Comment padding (ignored by SSE parsers). Some proxies and browsers only
  // release a response once a few KB have accumulated; this fills that buffer
  // up front so the first real event is delivered as soon as it is written.
  res.write(`:${" ".repeat(SSE_PADDING_BYTES)}\n\n`);

  // Keep the stream from going silent. A context compaction summarises the whole
  // prompt in one call, which measured 48s at 189k tokens and up to ~200s on a
  // fact-dense context; nothing is written to the client for that whole time.
  // nginx's default proxy_read_timeout is 60s, so without this the proxy would
  // drop the connection mid-turn. A comment line is ignored by every SSE parser.
  const heartbeat = setInterval(() => {
    if (res.writableEnded) return;
    try {
      res.write(": keep-alive\n\n");
    } catch {
      // client is gone — the close handler tears the turn down
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  const send = (payload: unknown) => {
    if (res.writableEnded) return;
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {
      // client is gone — nothing to do
    }
  };
  return { send, stopHeartbeat: () => clearInterval(heartbeat) };
}

/**
 * Replace the clipped title with a summarised one, beside the answer rather
 * than before it: the row is already in the sidebar under its clipped title,
 * and the summarised name replaces it whenever it arrives. Nothing awaits this,
 * and a failure leaves the clipped title.
 *
 * Only while the title is still the clipped one: the summary arrives seconds
 * later, and a rename made in the meantime is the person's choice.
 */
function renameFromSummary(
  ownerId: string,
  id: string,
  content: string,
  model: string,
  clippedTitle: string,
  signal: AbortSignal,
  send: (payload: unknown) => void,
  onUsage: (usage: WireUsage) => void,
): void {
  void summariseConversationTitle(content, model, signal, ownerId, onUsage)
    .then(async (title) => {
      if (!title) return;
      let applied = false;
      await mutateConversation(ownerId, id, (conv) => {
        if (conv.title !== clippedTitle) return conv;
        conv.title = title;
        applied = true;
        return conv;
      });
      if (applied) send({ type: "title", title });
    })
    .catch((err) => console.warn(`[conversations] could not store the summarised title for ${id}:`, err));
}

/**
 * "하지 말라" 는 뜻이 담긴 말이면 그 사용자의 금지 목록 검토 대기에 한 줄 보탠다.
 * 판정 대상은 방금 보낸 말과 그 앞의 답변이다 — 불만은 늘 직전 답변을 향한다.
 * 답변과 무관하게 돌도록 자체 시한을 쓴다: 사용자가 답변을 멈춰도 이미 한 말은
 * 그대로다. 검토 대기에만 들어가므로 이번 답변에도, 다음 답변에도 아직 반영되지
 * 않는다(storage/prohibitionsStore.ts).
 */
function recordProhibitionInBackground(
  ownerId: string,
  afterUser: Conversation,
  content: string,
  model: string,
  onUsage: (usage: WireUsage) => void,
): void {
  const previous = afterUser.messages
    .slice(0, -1)
    .reverse()
    .find((m) => m.role === "assistant" && typeof m.content === "string" && m.content.trim());
  if (!previous) return;
  void detectProhibition({
    assistant: previous.content,
    user: content,
    model,
    ownerId,
    signal: AbortSignal.timeout(PROHIBITION_DETECT_TIMEOUT_MS),
    onUsage,
  })
    .then((rule) => (rule ? appendPending(ownerId, rule, content, new Date()) : false))
    .then((added) => {
      if (added) console.log(`[prohibitions] ${ownerId}: 검토 대기에 한 줄 보탬`);
    })
    .catch((err) => console.warn("[prohibitions] could not record:", err instanceof Error ? err.message : err));
}

/**
 * POST /conversations/:id/messages — one turn.
 *
 * `{"regenerate": true}` 은 새 사용자 메시지를 덧붙이는 대신 마지막 사용자 메시지
 * 뒤(그 질문의 답·도구 메시지)를 잘라 내고 같은 질문으로 턴을 다시 돌린다. 첨부는
 * 그 메시지에 붙은 것을 그대로 쓴다. `content` 가 비어 있지 않으면 그 메시지의
 * 내용을 바꿔서 다시 돌린다(편집 후 재전송). 나머지 — 모델·종류·설정·도구 검사,
 * 스트림 모양(user_message → … → done) — 는 보통 전송과 같다.
 */
export const postMessage: RequestHandler<{ id: string }> = async (req, res, next) => {
  const { id } = req.params;
  const body = req.body ?? {};

  // Everything before the stream opens. A failure here (a full disk on the
  // write below, say) goes to next(): Express 4 does not do that for a
  // rejected async handler, and the client would wait for its own timeout.
  let plan: TurnPlan;
  let afterUser: Conversation;
  let clippedTitle: string | null;
  let rewound: Rewound | null;
  try {
    const prepared = await prepareTurn(req);
    if (!prepared.ok) {
      res.status(prepared.status).json(prepared.body);
      return;
    }
    plan = prepared;
    const appended = await appendUserMessage(req.ownerId, id, plan);
    if (!appended.ok) {
      res.status(appended.status).json(appended.body);
      return;
    }
    ({ afterUser, clippedTitle, rewound } = appended);
  } catch (err) {
    next(err);
    return;
  }
  const { turnKind, resolved, regenerateTarget, content, userMessage } = plan;

  // Uploads that were never sent (a composer the user abandoned) are only
  // collected here and at startup, so an account that keeps chatting cleans up
  // after itself.
  sweepConversationAttachments(req.ownerId, id, referencedAttachmentIds(afterUser)).catch((err) => {
    console.warn(`[attachments] sweep failed for ${id}:`, err);
  });

  const { send, stopHeartbeat } = openEventStream(res);
  send({ type: "user_message", message: userMessage });

  // What the user waits through, measured where the server can see it: from
  // the moment the request is ready to run to the moment the answer is whole.
  // Sent to the client right away (not once the turn actually reaches vLLM) so
  // a slow model resolution or attachment step is counted too — the person is
  // waiting the whole time, not just once a token arrives. The client uses
  // this as the clock for the "지금 답변하기" button instead of its own
  // Date.now(), so the 3-minute mark does not drift with request latency or a
  // client clock that disagrees with the server's.
  const startedAt = Date.now();
  if (turnKind === "chat") {
    send({ type: "turn_started", startedAt, answerNowAfterMs: config.answerNowThresholdMs });
  }

  const controller = new AbortController();
  activeStreams.track(id, controller);
  // "지금 답변하기": a SEPARATE controller from `controller` above, tracked in
  // its own set (turnSignals.ts, activeAnswerNowSignals). Aborting it cuts the
  // current model call short without tearing the SSE response down the way
  // Stop does — see runConversationTurn's answerNowSignal parameter. Embedding
  // turns have no tool loop or reasoning to cut short, so this is only tracked
  // (and only reachable) for a chat turn.
  const answerNowController = new AbortController();
  if (turnKind === "chat") activeAnswerNowSignals.track(id, answerNowController);
  // Cancel the vLLM call when the client goes away (Stop button, closed tab).
  // This must listen on `res`, not `req`: an IncomingMessage emits "close" as
  // soon as its body has been fully read — measured ~1ms into the handler,
  // i.e. before this line even runs — so a req-based listener is registered
  // after the event has already fired and never runs at all. `res` emits
  // "close" when the connection actually goes away. It also emits it when we
  // end the response ourselves, hence the guard: by then `finally` has already
  // removed this controller from activeStreams, so a completed turn is a no-op.
  let leftDuringCompaction = false;
  res.on("close", () => {
    if (!activeStreams.has(id, controller)) return;
    // A compaction in progress is let finish, so the summary it is writing is
    // saved and the page finds a smaller conversation when it comes back; the
    // turn itself still ends once it does. Stop (DELETE …/stream) is unaffected.
    const settled = compactionSettled(id);
    if (settled) {
      leftDuringCompaction = true;
      console.log(`[conversations] client left ${id} during compaction; finishing the compaction first`);
      void settled.then(() => controller.abort());
      return;
    }
    controller.abort();
  });

  // 제목 짓기·"하지 마" 판정도 이 질문 때문에 쓴 토큰이라 이 턴의 답에 더한다(chat/turnUsage.ts).
  const ownerId = req.ownerId;
  const sideUsage = sideUsageMeter((messageId, usage) =>
    mutateConversation(ownerId, id, (conv) => {
      const message = conv.messages.find((m) => m.id === messageId);
      if (message) message.usage = addWireUsage(message.usage, usage);
      return conv;
    }).then(() => undefined),
  );
  if (clippedTitle !== null && turnKind === "chat") {
    renameFromSummary(req.ownerId, id, content, resolved.model, clippedTitle, controller.signal, send, sideUsage.add);
  }

  // 그대로 다시 돌리는 것은 새로 한 말이 아니므로 또 판정하지 않는다(편집은 판정한다).
  const saidSomethingNew = !regenerateTarget || content !== regenerateTarget.content;
  if (turnKind === "chat" && config.feedbackDetect && content.trim() && saidSomethingNew) {
    recordProhibitionInBackground(req.ownerId, afterUser, content, resolved.model, sideUsage.add);
  }

  try {
    let assistantMessage: StoredMessage;
    if (turnKind === "embedding") {
      // Nothing from the chat path runs here: no system prompt, no tools, no
      // tool loop, no /tokenize, no context budget, no compaction. One string
      // in, one vector out.
      const { embedding, usage } = await runEmbeddingTurn(afterUser, resolved.endpoint, resolved.model, content, controller.signal);
      assistantMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: describeEmbedding(embedding),
        embedding,
        // Reported where every other turn reports it, so nothing has to read
        // token usage from two places.
        usage,
        durationMs: Date.now() - startedAt,
        createdAt: new Date().toISOString(),
      };
      // No extra SSE event type: an embedding is one response and it rides the
      // `done` event below on the assistant message, exactly like a chat turn's
      // final message. The stream shape the client already parses is unchanged
      // (user_message -> done).
    } else {
      // 크롬 제어는 이 요청을 보낸 브라우저의 사정(확장 연결 + 사용자 선택)이라 대화가
      // 아니라 요청에 실려 온다.
      const generator = runConversationTurn(afterUser, req.ownerId, controller.signal, answerNowController.signal, {
        browserControl: body.browserControl === true,
      });
      let result;
      for (;;) {
        const step = await generator.next();
        if (step.done) {
          result = step.value;
          break;
        }
        send(step.value);
      }

      // 다시 생성·편집 재전송을 첫 글자가 오기 전에 멈췄다: 새로 남길 것이 없으니
      // 지웠던 이전 답을 되돌린다. 생각만 하다 멈춘 답(생각이 본문으로 올라온 것)도
      // 답이 아니다.
      const producedNothing = result.content.trim().length === 0 || result.contentPromotedFromReasoning === true;
      if (rewound && result.error === CANCELLED_BY_CLIENT && producedNothing) {
        if (await restoreRewound(req.ownerId, id, userMessage.id, rewound)) {
          send({ type: "restored" });
          return;
        }
      }

      const finished = assistantMessageFromTurn(result, startedAt);
      if (leftDuringCompaction && result.error === CANCELLED_BY_CLIENT) {
        const { stopped: _stopped, ...rest } = finished;
        assistantMessage = {
          ...rest,
          error: "답변 도중 페이지를 떠나 이 답변은 중단되었습니다. 컨텍스트 압축은 끝까지 진행되어 저장되었으니 다시 질문해 주세요.",
        };
      } else {
        assistantMessage = finished;
      }
    }

    assistantMessage = sideUsage.settle(assistantMessage);
    await mutateConversation(req.ownerId, id, (conv) => {
      conv.messages.push(assistantMessage);
      return conv;
    });

    send({ type: "done", message: assistantMessage });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[conversations] stream error for ${id}:`, err);
    // 실패한 턴은 답을 저장하지 않는다. 다시 생성이었다면 질문만 덩그러니 남기는 대신
    // 지웠던 이전 답을 되돌린다 — 화면에서 오류를 본 사람은 그 답을 잃지 않는다.
    if (rewound) {
      try {
        if (await restoreRewound(req.ownerId, id, userMessage.id, rewound)) send({ type: "restored" });
      } catch (restoreErr) {
        console.error(`[conversations] could not restore the previous answer for ${id}:`, restoreErr);
      }
    }
    send({ type: "error", message: readableTurnError(message) });
  } finally {
    stopHeartbeat();
    activeStreams.untrack(id, controller);
    if (turnKind === "chat") activeAnswerNowSignals.untrack(id, answerNowController);
    if (!res.writableEnded) {
      res.write("data: [DONE]\n\n");
      res.end();
    }
  }
};
