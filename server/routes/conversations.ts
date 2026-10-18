import { Router, type Request, type Response } from "express";
import {
  listConversations,
  getConversation,
  createConversation,
  updateConversation,
  deleteConversation,
  mutateConversation,
} from "../storage/conversationStore.js";
import { appendFeedback } from "../storage/feedbackStore.js";
import { isValidId } from "../storage/paths.js";
import { modelAccessFor, modelIsForbidden } from "../vllm/access.js";
import { resolveModel } from "../vllm/client.js";
import { compactionStatus } from "../chat/compactionProgress.js";
import type { Conversation, ConversationSettings, ConversationKind, MessageFeedback } from "../types.js";
import { checkEnabledTools, checkSettings, checkTextField } from "./conversationFields.js";
import { postMessage } from "./conversationTurn.js";
import { activeAnswerNowSignals, activeStreams } from "./turnSignals.js";

export const conversationsRouter = Router();

/**
 * The caller's own conversation named in the path, or null once a 404 has been
 * sent. A stranger's id gets the same 404 as a missing one, so it does not
 * confirm that the id exists.
 */
export async function ownConversationOr404(req: Request<{ id: string }>, res: Response): Promise<Conversation | null> {
  const conversation = isValidId(req.params.id) ? await getConversation(req.ownerId, req.params.id) : null;
  if (!conversation) res.status(404).json({ error: "Not found" });
  return conversation;
}

/**
 * A conversation is only given a `kind` by its first message, so a freshly
 * created one has none. The API never publishes that gap: it reports "chat",
 * which is what a conversation without one behaves as, and never null — the
 * sidebar renders an icon from this field and has nothing to fall back to.
 */
function withKind<T extends { kind?: ConversationKind }>(conversation: T): T & { kind: ConversationKind } {
  return { ...conversation, kind: conversation.kind ?? "chat" };
}

conversationsRouter.get("/conversations", async (req, res, next) => {
  try {
    res.json((await listConversations(req.ownerId)).map(withKind));
  } catch (err) {
    next(err);
  }
});

conversationsRouter.post("/conversations", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    // The same bounds PATCH applies. Creating with an over-long title used to be
    // the way around them: POST accepted 5,000 characters and 60,000-character
    // system prompts that PATCH would have refused.
    for (const field of ["title", "systemPrompt"] as const) {
      if (typeof body[field] !== "string") continue;
      const problem = checkTextField(field, body[field] as string);
      if (problem) return res.status(400).json(problem);
    }
    if (typeof body.model === "string" && (await modelIsForbidden(await modelAccessFor(req.user), body.model))) {
      return res.status(403).json({ error: "이 계정에서는 쓸 수 없는 모델입니다.", code: "model_forbidden" });
    }
    const conv = await createConversation(req.ownerId, {
      title: typeof body.title === "string" ? body.title : undefined,
      systemPrompt: typeof body.systemPrompt === "string" ? body.systemPrompt : undefined,
      model: typeof body.model === "string" ? body.model : undefined,
    });
    res.status(201).json(withKind(conv));
  } catch (err) {
    next(err);
  }
});

conversationsRouter.get("/conversations/:id", async (req, res, next) => {
  try {
    const conv = await ownConversationOr404(req, res);
    if (!conv) return;
    res.json(withKind(conv));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /conversations/:id/compaction — the compaction running for this
 * conversation, or { active: false }. A page opened (or reloaded) mid-compaction
 * polls this to show the progress bar and keep the composer locked.
 */
conversationsRouter.get("/conversations/:id/compaction", async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) return res.status(404).json({ error: "Not found" });
    const status = compactionStatus(req.ownerId, req.params.id);
    res.json(status ? { active: true, ...status } : { active: false });
  } catch (err) {
    next(err);
  }
});

conversationsRouter.patch("/conversations/:id", async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) return res.status(404).json({ error: "Not found" });
    const body = req.body ?? {};
    const patch: {
      title?: string;
      systemPrompt?: string;
      model?: string;
      settings?: Partial<ConversationSettings>;
      enabledTools?: string[];
      pinned?: boolean;
    } = {};
    for (const field of ["title", "systemPrompt"] as const) {
      if (typeof body[field] !== "string") continue;
      const problem = checkTextField(field, body[field] as string);
      if (problem) return res.status(400).json(problem);
      patch[field] = body[field] as string;
    }
    if (typeof body.model === "string") {
      if (await modelIsForbidden(await modelAccessFor(req.user), body.model)) {
        return res.status(403).json({ error: "이 계정에서는 쓸 수 없는 모델입니다.", code: "model_forbidden" });
      }
      patch.model = body.model;
    }
    const settings = checkSettings(body.settings);
    if (!settings.ok) return res.status(400).json(settings.problem);
    if (settings.value) patch.settings = settings.value;
    const enabledTools = checkEnabledTools(body.enabledTools);
    if (!enabledTools.ok) return res.status(400).json(enabledTools.problem);
    if (enabledTools.value) patch.enabledTools = enabledTools.value;
    if (body.pinned !== undefined) {
      if (typeof body.pinned !== "boolean") {
        return res.status(400).json({ error: "pinned 는 true 나 false 여야 합니다.", field: "pinned" });
      }
      patch.pinned = body.pinned;
    }

    const updated = await updateConversation(req.ownerId, req.params.id, patch);
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(withKind(updated));
  } catch (err) {
    next(err);
  }
});

conversationsRouter.delete("/conversations/:id", async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) return res.status(404).json({ error: "Not found" });
    // Read before unlinking so the line below can say what was lost. This is the
    // only irreversible operation a signed-in account can perform on its own
    // data, and until now it left no trace at all: 19 conversations went missing
    // in one evening and the log could not say who removed them or when.
    const doomed = await getConversation(req.ownerId, req.params.id);
    const deleted = await deleteConversation(req.ownerId, req.params.id);
    if (!deleted) return res.status(404).json({ error: "Not found" });
    console.log(
      `[conversations] ${req.ownerId} deleted ${req.params.id} ` +
        `(${doomed?.messages.length ?? 0} message(s), title ${JSON.stringify(doomed?.title ?? "")}) from ${req.ip ?? "?"}`,
    );
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

conversationsRouter.delete("/conversations/:id/stream", async (req, res, next) => {
  try {
    // Keyed by conversation id alone, so without this check any signed-in
    // account that knew an id could stop someone else's answer mid-sentence —
    // measured: a second account cut an admin's stream off at 81 characters.
    // Every other route on this conversation already 404s for a stranger; this
    // one was the exception. 404 rather than 403, so it does not confirm that
    // the id exists either.
    if (!(await ownConversationOr404(req, res))) return;
    if (!activeStreams.abortAll(req.params.id)) {
      return res.status(404).json({ error: "No active stream for this conversation" });
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

conversationsRouter.post("/conversations/:id/answer-now", async (req, res, next) => {
  try {
    // Same ownership rule as Stop above, for the same reason: an id is not a
    // secret, and being signed in must not be enough to reach into someone
    // else's turn.
    if (!(await ownConversationOr404(req, res))) return;
    if (!activeAnswerNowSignals.abortAll(req.params.id)) {
      // No turn running (already finished, or never started) — the same shape
      // as Stop's 404 above, and just as harmless: the client fires this and
      // ignores the response either way (useChatStream.ts).
      return res.status(404).json({ error: "No active turn for this conversation" });
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/** 👎 와 함께 받는 이유의 길이 한계. 한두 문장이면 충분하다. */
const FEEDBACK_REASON_MAX_CHARS = 500;

/**
 * PUT /conversations/:id/messages/:messageId/feedback — 답변 하나의 👍/👎.
 * body `{ rating: "up" | "down" | null, reason?: string }`. null 은 지우기다(같은 단추를
 * 다시 누르면 꺼진다). 메시지에 저장하고, 바뀐 것을 소유자의 feedback.jsonl 에 한 줄 덧붙인다.
 */
conversationsRouter.put("/conversations/:id/messages/:messageId/feedback", async (req, res, next) => {
  try {
    if (!isValidId(req.params.id) || !isValidId(req.params.messageId)) return res.status(404).json({ error: "Not found" });
    const body = req.body ?? {};
    const rating = body.rating;
    if (rating !== "up" && rating !== "down" && rating !== null) {
      return res.status(400).json({ error: "rating 은 \"up\", \"down\", null 중 하나여야 합니다.", code: "invalid_rating" });
    }
    if (body.reason !== undefined && typeof body.reason !== "string") {
      return res.status(400).json({ error: "reason 은 문자열이어야 합니다.", code: "invalid_reason" });
    }
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (reason.length > FEEDBACK_REASON_MAX_CHARS) {
      return res.status(400).json({ error: `이유는 ${FEEDBACK_REASON_MAX_CHARS}자까지 쓸 수 있습니다.`, code: "invalid_reason" });
    }
    const feedback: MessageFeedback | null = rating ? { rating, ...(reason ? { reason } : {}) } : null;

    const conversation = await ownConversationOr404(req, res);
    if (!conversation) return;
    const target = conversation.messages.find((m) => m.id === req.params.messageId);
    if (!target) return res.status(404).json({ error: "Not found" });
    if (target.role !== "assistant") {
      return res.status(400).json({ error: "답변에만 평가를 남길 수 있습니다.", code: "not_assistant" });
    }

    let applied = false;
    // updatedAt 은 그대로 둔다: 지난 답에 👍 하나 눌렀다고 대화가 목록 맨 위로 오면 안 된다.
    const updated = await mutateConversation(
      req.ownerId,
      req.params.id,
      (conv) => {
        const message = conv.messages.find((m) => m.id === req.params.messageId);
        if (!message) return conv;
        if (feedback) message.feedback = feedback;
        else delete message.feedback;
        applied = true;
        return conv;
      },
      { touch: false },
    );
    // 읽은 뒤 잠그기 전에 그 답이 지워졌다(다시 생성).
    if (!updated || !applied) return res.status(404).json({ error: "Not found" });
    // 모델을 비워 둔 대화는 서버 기본 모델이 답했다. 평가 기록에는 그 이름을 남긴다 — 목록은
    // 캐시에서 오므로 대개 네트워크를 타지 않고, 못 알아내면 빈 값으로 둔다.
    const model = updated.model || (await resolveModel().then((r) => r.model).catch(() => ""));
    await appendFeedback(req.ownerId, {
      at: new Date().toISOString(),
      conversationId: req.params.id,
      messageId: req.params.messageId,
      model,
      rating: feedback?.rating ?? null,
      ...(feedback?.reason ? { reason: feedback.reason } : {}),
    });
    res.json({ feedback });
  } catch (err) {
    next(err);
  }
});

// POST /conversations/:id/messages — one turn (conversationTurn.ts).
conversationsRouter.post("/conversations/:id/messages", postMessage);
