import path from "node:path";
import { config } from "../config.js";

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidId(id: unknown): id is string {
  return typeof id === "string" && ID_PATTERN.test(id);
}

/** All session records. Only enumerated to sign a user's other browsers out. */
export function sessionsDir(): string {
  return path.join(config.dataDir, "sessions");
}

/** The browser session record itself — still keyed by the `sid` cookie. */
export function sessionDir(sessionId: string): string {
  return path.join(config.dataDir, "sessions", sessionId);
}

export function sessionFile(sessionId: string): string {
  return path.join(sessionDir(sessionId), "session.json");
}

/** Account records: one JSON file per user, `{DATA_DIR}/auth/users/{id}.json`. */
export function usersDir(): string {
  return path.join(config.dataDir, "auth", "users");
}

export function userFile(userId: string): string {
  return path.join(usersDir(), `${userId}.json`);
}

/** Groups: one JSON file per group, alongside the accounts they file. */
export function groupsDir(): string {
  return path.join(config.dataDir, "auth", "groups");
}

export function groupFile(groupId: string): string {
  return path.join(groupsDir(), `${groupId}.json`);
}

/**
 * Conversations and attachments are keyed by their OWNER (the account id), not
 * by the browser session that happened to create them: a user who signs in from
 * a second browser gets a second `sid`, and session-keyed storage would show
 * them an empty app.
 *
 * The pre-accounts layout was {DATA_DIR}/sessions/{sid}/conversations/... . The
 * 21 anonymous session directories on the deployed server cannot be attributed
 * to any account, so nothing reads that path any more — they stay on disk,
 * untouched and unreachable, rather than being migrated onto a guessed owner or
 * deleted (README, "Storage").
 */
export function ownersRoot(): string {
  return path.join(config.dataDir, "owners");
}

export function ownerDir(ownerId: string): string {
  return path.join(ownersRoot(), ownerId);
}

export function conversationsDir(ownerId: string): string {
  return path.join(ownerDir(ownerId), "conversations");
}

export function conversationFile(ownerId: string, conversationId: string): string {
  return path.join(conversationsDir(ownerId), `${conversationId}.json`);
}

/**
 * Attachment bytes and their metadata sidecar. Every path segment below is
 * either a literal or an id the caller has already put through isValidId(), so
 * a filename — which arrives from the user and may be anything, including
 * "../../etc/passwd" — never reaches the filesystem.
 */
export function ownerAttachmentsDir(ownerId: string): string {
  return path.join(ownerDir(ownerId), "attachments");
}

export function attachmentsDir(ownerId: string, conversationId: string): string {
  return path.join(ownerAttachmentsDir(ownerId), conversationId);
}

export function attachmentBinFile(ownerId: string, conversationId: string, attachmentId: string): string {
  return path.join(attachmentsDir(ownerId, conversationId), `${attachmentId}.bin`);
}

export function attachmentMetaFile(ownerId: string, conversationId: string, attachmentId: string): string {
  return path.join(attachmentsDir(ownerId, conversationId), `${attachmentId}.json`);
}

/**
 * Uploaded RAG documents: the source text and its metadata sidecar.
 *
 * The text is kept even though the engine holds the chunks, because the engine
 * holds a DERIVED thing — re-chunking it, or re-indexing it under a different
 * permission when the owner publishes it, needs the original back. Same shape
 * as attachments above, and the same rule: only literals and ids that have been
 * through isValidId() ever become path segments.
 */
export function documentsDir(ownerId: string): string {
  return path.join(ownerDir(ownerId), "documents");
}

export function documentTextFile(ownerId: string, documentId: string): string {
  return path.join(documentsDir(ownerId), `${documentId}.txt`);
}

export function documentMetaFile(ownerId: string, documentId: string): string {
  return path.join(documentsDir(ownerId), `${documentId}.json`);
}

/**
 * The chunk bodies exactly as they were indexed.
 *
 * Kept rather than recomputed because the boundaries may have come from a
 * model: running the chunker again would produce a DIFFERENT cut, so a viewer
 * built on recomputation would show something the engine never held.
 */
export function documentChunksFile(ownerId: string, documentId: string): string {
  return path.join(documentsDir(ownerId), `${documentId}.chunks.json`);
}

/**
 * Every owner directory. Only enumerated to answer "how many people adopted
 * this MCP server?" — the count that decides whether a server can be deleted.
 */
export function ownersDir(): string {
  return path.join(config.dataDir, "owners");
}

/**
 * The GLOBAL MCP registry: one JSON file per server,
 * {DATA_DIR}/mcp/servers/{id}.json, in the same one-file-per-record shape as
 * accounts and groups. Under DATA_DIR rather than in the image because that is
 * the only path the container bind-mounts (the same reasoning as
 * {DATA_DIR}/.model in vllm/endpoints.ts): a registry baked into the image
 * would be lost on the next deploy.
 */
export function mcpDir(): string {
  return path.join(config.dataDir, "mcp");
}

export function mcpServersDir(): string {
  return path.join(mcpDir(), "servers");
}

export function mcpServerFile(serverId: string): string {
  return path.join(mcpServersDir(), `${serverId}.json`);
}

/**
 * Marker listing the builtin slugs this deployment has already seeded, so a
 * builtin an admin deleted stays deleted instead of coming back at every boot.
 */
export function mcpSeedMarkerFile(): string {
  return path.join(mcpDir(), "seeded.json");
}

/**
 * One owner's MCP preferences and credentials. Beside their conversations, in
 * the tree that deleteOwnerData() removes with the account — a credential must
 * not outlive the person who entered it.
 */
export function ownerMcpFile(ownerId: string): string {
  return path.join(ownerDir(ownerId), "mcp.json");
}

/**
 * 이 사용자가 "하지 말라" 고 한 것들의 목록. 사람이 직접 읽고 고치는 파일이라
 * JSON 이 아니라 markdown 이다. 계정과 함께 지워지도록 소유자 폴더 안에 둔다.
 */
export function ownerProhibitionsFile(ownerId: string): string {
  return path.join(ownerDir(ownerId), "prohibitions.md");
}

/**
 * 문의 게시판. 소유자별이 아니라 **전역**이다 — 글은 모두가 보는 것이고,
 * 누가 썼는지는 파일 위치가 아니라 레코드의 authorId 가 말한다.
 */
export function boardDir(): string {
  return path.join(config.dataDir, "board");
}

export function boardPostsDir(): string {
  return path.join(boardDir(), "posts");
}

export function boardPostFile(postId: string): string {
  return path.join(boardPostsDir(), `${postId}.json`);
}
