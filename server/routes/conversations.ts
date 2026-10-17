import { Router, type Request, type Response } from "express";
import {
  listConversations,
  getConversation,
  createConversation,
  updateConversation,
  deleteConversation,
} from "../storage/conversationStore.js";
import { isValidId } from "../storage/paths.js";
import { modelAccessFor, modelIsForbidden } from "../vllm/access.js";
import { compactionStatus } from "../chat/compactionProgress.js";
import type { Conversation, ConversationSettings, ConversationKind } from "../types.js";
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

// POST /conversations/:id/messages — one turn (conversationTurn.ts).
conversationsRouter.post("/conversations/:id/messages", postMessage);
