import crypto from "node:crypto";
import { Router } from "express";
import {
  listConversations,
  getConversation,
  createConversation,
  updateConversation,
  deleteConversation,
  mutateConversation,
} from "../storage/conversationStore.js";
import { isValidId } from "../storage/paths.js";
import {
  getAttachmentMeta,
  referencedAttachmentIds,
  sweepConversationAttachments,
} from "../storage/attachmentStore.js";
import { attachmentBudget, describeCost } from "../attachments/budget.js";
import { resolveModel } from "../vllm/client.js";
import { runConversationTurn } from "../chat/toolLoop.js";
import { summariseConversationTitle } from "../chat/titleSummary.js";
import { runEmbeddingTurn } from "../chat/embeddingTurn.js";
import { config } from "../config.js";
import { validateSettingsPatch } from "../types.js";
import type {
  StoredMessage,
  ConversationSettings,
  ConversationKind,
  MessageAttachment,
  MessageEmbedding,
} from "../types.js";

/** A sidebar row, not a document. */
const MAX_TITLE_CHARS = 200;
/** Rides in every prompt of every later turn, so it is charged for forever. */
const MAX_SYSTEM_PROMPT_CHARS = 20_000;
/** The registry holds a few dozen; this is room for MCP servers on top. */
const MAX_ENABLED_TOOLS = 500;

export const conversationsRouter = Router();

/** A refusal the caller can act on: which field was wrong, and why. */
interface FieldProblem {
  error: string;
  field: string;
}

/**
 * The rules for the four stored fields, in ONE place, because PATCH is not the
 * only route that writes them: POST /conversations writes a title and a system
 * prompt, and POST /conversations/:id/messages carries a `settings` and an
 * `enabledTools` patch of its own. Both of those wrote straight through, so
 * every limit below could be walked around by sending the same value to a
 * different route — measured on the deployment:
 *
 *   POST /conversations/:id/messages {"content":"hi","settings":{"topP":99,"seed":"abc"}}
 *
 * stored topP 99 and seed "abc", and the conversation then answered
 * 400 "Input should be a valid integer, unable to parse string as an integer"
 * on EVERY later turn — the exact breakage validateSettingsPatch exists to
 * prevent, reachable through the route next to the one that was fixed.
 */
function checkTextField(field: "title" | "systemPrompt", value: string): FieldProblem | null {
  // Bounded because both are stored and replayed: a title rides in the sidebar,
  // a system prompt rides in EVERY prompt of every later turn. 100,000-character
  // titles and 500,000-character system prompts were accepted before this.
  if (field === "title") {
    return value.length > MAX_TITLE_CHARS
      ? { error: `제목은 ${MAX_TITLE_CHARS}자를 넘을 수 없습니다.`, field }
      : null;
  }
  return value.length > MAX_SYSTEM_PROMPT_CHARS
    ? { error: `시스템 프롬프트는 ${MAX_SYSTEM_PROMPT_CHARS}자를 넘을 수 없습니다.`, field }
    : null;
}

function checkSettings(
  raw: unknown,
): { ok: true; value?: Partial<ConversationSettings> } | { ok: false; problem: FieldProblem } {
  if (!raw || typeof raw !== "object") return { ok: true };
  // Checked, not spread: whatever is stored here is what goes to vLLM on every
  // later turn. The legacy "high" level still normalises to what the servers
  // take, and an unknown key is dropped rather than stored.
  const checked = validateSettingsPatch(raw as Record<string, unknown>);
  if (checked.ok) return { ok: true, value: checked.value };
  return { ok: false, problem: { error: checked.problem.message, field: checked.problem.field } };
}

function checkEnabledTools(raw: unknown): { ok: true; value?: string[] } | { ok: false; problem: FieldProblem } {
  if (!Array.isArray(raw)) return { ok: true };
  // A tool list is walked once per turn, so it is bounded too.
  if (raw.length > MAX_ENABLED_TOOLS) {
    return { ok: false, problem: { error: `도구는 ${MAX_ENABLED_TOOLS}개를 넘을 수 없습니다.`, field: "enabledTools" } };
  }
  // Names only, and no longer than a tool name can be: anything else could
  // never resolve to a tool anyway.
  return {
    ok: true,
    value: (raw as unknown[]).filter(
      (name): name is string => typeof name === "string" && name.length > 0 && name.length <= 64,
    ),
  };
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
    if (!isValidId(req.params.id)) return res.status(404).json({ error: "Not found" });
    const conv = await getConversation(req.ownerId, req.params.id);
    if (!conv) return res.status(404).json({ error: "Not found" });
    res.json(withKind(conv));
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
    if (typeof body.model === "string") patch.model = body.model;
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

// Active SSE streams keyed by conversation id, so DELETE .../stream can abort the in-flight vLLM call.
/**
 * Every turn currently streaming, grouped by conversation.
 *
 * A set, not one controller: two turns can be live on one conversation (two tabs
 * on the same chat), and with a single slot the second overwrote the first —
 * measured, Stop reached only the newer one while the older ran to 6,325
 * characters, and a second Stop answered "no active stream" while it was still
 * going. Stop now abandons every turn on the conversation, which is what the
 * button says it does.
 */
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

const activeStreams = new Map<string, Set<AbortController>>();

function trackStream(conversationId: string, controller: AbortController): void {
  const live = activeStreams.get(conversationId) ?? new Set<AbortController>();
  live.add(controller);
  activeStreams.set(conversationId, live);
}

/** Removes only this turn's controller, so a finished turn never frees another's slot. */
function untrackStream(conversationId: string, controller: AbortController): void {
  const live = activeStreams.get(conversationId);
  if (!live) return;
  live.delete(controller);
  if (live.size === 0) activeStreams.delete(conversationId);
}

conversationsRouter.delete("/conversations/:id/stream", async (req, res, next) => {
  try {
    // Keyed by conversation id alone, so without this check any signed-in
    // account that knew an id could stop someone else's answer mid-sentence —
    // measured: a second account cut an admin's stream off at 81 characters.
    // Every other route on this conversation already 404s for a stranger; this
    // one was the exception. 404 rather than 403, so it does not confirm that
    // the id exists either.
    if (!isValidId(req.params.id)) return res.status(404).json({ error: "Not found" });
    if (!(await getConversation(req.ownerId, req.params.id))) {
      return res.status(404).json({ error: "Not found" });
    }
    const live = activeStreams.get(req.params.id);
    if (!live || live.size === 0) {
      return res.status(404).json({ error: "No active stream for this conversation" });
    }
    for (const controller of live) controller.abort();
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

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
  if (collapsed.length <= 40) return collapsed || "New Chat";
  return `${collapsed.slice(0, 40)}…`;
}

conversationsRouter.post("/conversations/:id/messages", async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) return res.status(404).json({ error: "Not found" });

  const body = req.body ?? {};
  const content = typeof body.content === "string" ? body.content : "";
  // Deduplicated: the same file attached twice would be sent to the model twice.
  const attachmentIds = Array.isArray(body.attachmentIds)
    ? [...new Set((body.attachmentIds as unknown[]).filter((value): value is string => typeof value === "string"))]
    : [];
  // An attachment-only message is a real message ("what is in this picture?"
  // needs no words), so the emptiness check now covers both.
  if (content.trim().length === 0 && attachmentIds.length === 0) {
    return res.status(400).json({ error: "content must be a non-empty string" });
  }
  if (attachmentIds.length > config.attachmentMaxPerMessage) {
    return res.status(400).json({
      error: `한 메시지에는 첨부를 ${config.attachmentMaxPerMessage}개까지 넣을 수 있습니다.`,
      code: "too_many",
    });
  }

  // Loaded up front, always: which model this conversation uses decides what
  // kind of turn this is (chat or embedding) before anything is written.
  const existing = await getConversation(req.ownerId, id);
  if (!existing) return res.status(404).json({ error: "Not found" });

  let resolved;
  try {
    resolved = await resolveModel(existing.model);
  } catch (err) {
    return res.status(502).json({ error: err instanceof Error ? err.message : "모델 서버에 연결하지 못했습니다." });
  }

  // The model's capability is measured, not declared (vllm/capability.ts).
  if (resolved.capability === "rerank") {
    // A reranker takes a query plus a list of documents and scores them; there
    // is nothing in a chat composer that expresses that. Refused here with a
    // sentence the user can act on, instead of forwarding the gateway's raw
    // 400 "does not support Chat Completions".
    return res.status(400).json({
      error: `${resolved.model} 은(는) 재순위(rerank) 전용 모델이라 대화에 사용할 수 없습니다. 질의와 문서 목록이 함께 필요합니다. 다른 모델을 선택해 주세요.`,
      code: "rerank_unsupported",
    });
  }
  const turnKind: ConversationKind = resolved.capability === "embedding" ? "embedding" : "chat";
  // A conversation takes its kind from its first message and keeps it: an
  // embedding turn and a chat turn store completely different messages, and
  // interleaving them makes a transcript nobody can read.
  if (existing.kind && existing.kind !== turnKind) {
    return res.status(409).json({
      error:
        existing.kind === "chat"
          ? "이 대화는 채팅 대화입니다. 임베딩 모델을 쓰려면 새 대화를 시작해 주세요."
          : "이 대화는 임베딩 대화입니다. 채팅 모델을 쓰려면 새 대화를 시작해 주세요.",
      code: "capability_mismatch",
    });
  }
  if (turnKind === "embedding" && attachmentIds.length > 0) {
    return res.status(400).json({
      error: "임베딩 모델은 첨부 파일을 처리하지 않습니다. 텍스트만 입력해 주세요.",
      code: "embedding_no_attachments",
    });
  }
  if (turnKind === "embedding" && content.trim().length === 0) {
    return res.status(400).json({ error: "임베딩할 텍스트를 입력해 주세요.", code: "invalid_input" });
  }

  const attachments: MessageAttachment[] = [];
  for (const attachmentId of attachmentIds) {
    const meta = isValidId(attachmentId) ? await getAttachmentMeta(req.ownerId, id, attachmentId) : null;
    if (!meta) {
      return res.status(404).json({ error: `첨부를 찾을 수 없습니다 (${attachmentId}). 다시 올려 주세요.` });
    }
    attachments.push(meta);
  }
  if (attachments.length > 0) {
    const attachmentBytes = attachments.reduce((sum, a) => sum + a.bytes, 0);
    if (attachmentBytes > config.attachmentMaxMessageBytes) {
      return res.status(413).json({
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
      return res.status(413).json({
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
  if (!checkedSettings.ok) return res.status(400).json(checkedSettings.problem);
  const settingsPatch = checkedSettings.value;
  const checkedTools = checkEnabledTools(body.enabledTools);
  if (!checkedTools.ok) return res.status(400).json(checkedTools.problem);
  const enabledToolsPatch = checkedTools.value;

  const userMessage: StoredMessage = {
    id: crypto.randomUUID(),
    role: "user",
    content,
    ...(attachments.length > 0 ? { attachments } : {}),
    createdAt: new Date().toISOString(),
  };

  let openedConversation = false;
  const afterUser = await mutateConversation(req.ownerId, id, (conv) => {
    // Locked in on the first message, then never changed (the mismatch check
    // above refuses anything else).
    if (!conv.kind) conv.kind = turnKind;
    if (settingsPatch) conv.settings = { ...conv.settings, ...settingsPatch };
    if (enabledToolsPatch) conv.enabledTools = enabledToolsPatch;
    if (conv.messages.length === 0 && (conv.title === "New Chat" || conv.title.trim().length === 0)) {
      // An attachment-only message has no words to title the conversation with,
      // so the first attachment's name is the next best handle.
      //
      // Clipped, and written NOW: the sidebar lists a conversation as soon as
      // it has a title, and the point is that the row appears when the request
      // starts rather than when the answer lands. A summarised name replaces
      // this one below, once the model has produced it.
      conv.title = titleFromContent(content.trim() || attachments[0]?.name || "");
      openedConversation = true;
    }
    conv.messages.push(userMessage);
    return conv;
  });

  if (!afterUser) return res.status(404).json({ error: "Not found" });

  // Uploads that were never sent (a composer the user abandoned) are only
  // collected here and at startup, so an account that keeps chatting cleans up
  // after itself.
  sweepConversationAttachments(req.ownerId, id, referencedAttachmentIds(afterUser)).catch((err) => {
    console.warn(`[attachments] sweep failed for ${id}:`, err);
  });

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
  res.write(`:${" ".repeat(2048)}\n\n`);

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
      // client is gone — the close handler below tears the turn down
    }
  }, 15_000);
  heartbeat.unref?.();

  const send = (payload: unknown) => {
    if (res.writableEnded) return;
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {
      // client is gone — nothing to do
    }
  };
  send({ type: "user_message", message: userMessage });

  const controller = new AbortController();
  trackStream(id, controller);
  // Cancel the vLLM call when the client goes away (Stop button, closed tab).
  // This must listen on `res`, not `req`: an IncomingMessage emits "close" as
  // soon as its body has been fully read — measured ~1ms into the handler,
  // i.e. before this line even runs — so a req-based listener is registered
  // after the event has already fired and never runs at all. `res` emits
  // "close" when the connection actually goes away. It also emits it when we
  // end the response ourselves, hence the guard: by then `finally` has already
  // removed this controller from activeStreams, so a completed turn is a no-op.
  res.on("close", () => {
    if (activeStreams.get(id)?.has(controller)) controller.abort();
  });

  // Runs beside the answer, not before it: the row is already in the sidebar
  // under its clipped title, and the summarised name replaces it whenever it
  // arrives. Nothing awaits this, and a failure leaves the clipped title.
  if (openedConversation && turnKind === "chat") {
    void summariseConversationTitle(content, afterUser.model ?? "", controller.signal).then(async (title) => {
      if (!title) return;
      const renamed = await mutateConversation(req.ownerId, id, (conv) => {
        conv.title = title;
        return conv;
      });
      if (renamed) send({ type: "title", title });
    });
  }

  // What the user waited through, measured where the server can see it: from
  // the moment the request is ready to run to the moment the answer is whole.
  const startedAt = Date.now();

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
      const generator = runConversationTurn(afterUser, req.ownerId, controller.signal);
      let result;
      for (;;) {
        const step = await generator.next();
        if (step.done) {
          result = step.value;
          break;
        }
        send(step.value);
      }

      assistantMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: result.content,
        ...(result.reasoning ? { reasoning: result.reasoning } : {}),
        ...(result.toolCalls.length ? { toolCalls: result.toolCalls } : {}),
        ...(result.toolResults.length ? { toolResults: result.toolResults } : {}),
        usage: result.usage,
        ...(result.error ? { error: result.error } : {}),
        ...(result.notice ? { notice: result.notice } : {}),
        ...(result.contentPromotedFromReasoning ? { contentPromotedFromReasoning: true } : {}),
        durationMs: Date.now() - startedAt,
        createdAt: new Date().toISOString(),
      };
    }

    await mutateConversation(req.ownerId, id, (conv) => {
      conv.messages.push(assistantMessage);
      return conv;
    });

    send({ type: "done", message: assistantMessage });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[conversations] stream error for ${id}:`, err);
    send({ type: "error", message: readableTurnError(message) });
  } finally {
    clearInterval(heartbeat);
    untrackStream(id, controller);
    if (!res.writableEnded) {
      res.write("data: [DONE]\n\n");
      res.end();
    }
  }
});
