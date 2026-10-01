/**
 * 대화 공유. 공유하는 순간의 대화를 **사본**으로 떠 둔다(Gemini 의 공개 링크와 같다).
 *
 * 원본을 그대로 보여 주지 않는 이유: 링크를 건넨 뒤에 이어 간 대화까지 받는 사람에게
 * 보이면 안 된다 — 사용자는 "지금 이 대화" 를 건넸다고 생각한다. 다시 공유하면 같은
 * 링크의 사본이 지금 모습으로 바뀐다. 원본 대화를 지워도 사본은 남는다.
 *
 * 첨부도 사본을 둔다. 원본 첨부는 대화를 지우거나 정리할 때 함께 사라지므로, 원본을
 * 가리키면 링크 속 그림이 언젠가 깨진다.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { readJsonFile, writeFileAtomic, writeJsonFileAtomic } from "./atomic.js";
import { getAttachmentMeta, readAttachmentBytes, referencedAttachmentIds } from "./attachmentStore.js";
import { withLock } from "./mutex.js";
import { isValidId, shareAttachmentsDir, shareFile, sharesIndexFile } from "./paths.js";
import type { Conversation, MessageAttachment, StoredMessage } from "../types.js";

/**
 * 토큰은 링크를 받은 사람만 아는 비밀이다(로그인 없이 열린다). 브라우저가 누르는
 * 순간에 만들어 보낸다 — http 에서는 복사가 누른 그 순간에만 되므로, 서버 응답을
 * 기다렸다 복사하면 iOS Safari 에서 복사가 거절된다. 그래서 길이로 추측을 막는다:
 * 22자 이상(base64url 로 128비트 이상).
 */
export const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22,64}$/;

export function isValidShareToken(token: unknown): token is string {
  return typeof token === "string" && SHARE_TOKEN_PATTERN.test(token);
}

export interface SharedConversation {
  token: string;
  title: string;
  /** 대화가 쓴 모델. "" 이면 서버 기본값이었다. */
  model: string;
  sharedAt: string;
  messages: StoredMessage[];
}

type ShareIndex = Record<string, string>;

const INDEX_LOCK = "shares:index";
const indexKey = (ownerId: string, conversationId: string) => `${ownerId}/${conversationId}`;

async function readIndex(): Promise<ShareIndex> {
  return (await readJsonFile<ShareIndex>(sharesIndexFile())) ?? {};
}

/** 이 대화에 이미 있는 공유 토큰. 없으면 null. */
export async function shareTokenFor(ownerId: string, conversationId: string): Promise<string | null> {
  return (await readIndex())[indexKey(ownerId, conversationId)] ?? null;
}

export class ShareTokenTakenError extends Error {}

/**
 * 사본을 뜨거나 고친다. 이미 공유한 대화면 그 토큰을 그대로 쓰고(보낸 토큰은 버린다),
 * 처음이면 보낸 토큰을 쓴다. 쓰인 토큰을 돌려준다.
 */
export async function saveShare(ownerId: string, conversation: Conversation, proposedToken: string): Promise<string> {
  return withLock(INDEX_LOCK, async () => {
    const index = await readIndex();
    const key = indexKey(ownerId, conversation.id);
    const token = index[key] ?? proposedToken;
    // 남의 공유와 같은 토큰을 고르면 남의 사본을 덮어쓰게 된다.
    if (!index[key] && Object.values(index).includes(token)) throw new ShareTokenTakenError("이미 쓰인 공유 토큰입니다.");

    // 첨부 사본을 새로 뜬다. 지난 공유 뒤에 지워진 첨부가 남지 않게 칸을 비우고 시작한다.
    const attachmentsDir = shareAttachmentsDir(token);
    await fs.rm(attachmentsDir, { recursive: true, force: true });
    for (const attachmentId of referencedAttachmentIds(conversation)) {
      const meta = await getAttachmentMeta(ownerId, conversation.id, attachmentId);
      const bytes = meta ? await readAttachmentBytes(ownerId, conversation.id, attachmentId) : null;
      if (!meta || !bytes) continue;
      await writeFileAtomic(path.join(attachmentsDir, `${attachmentId}.bin`), bytes);
      await writeJsonFileAtomic(path.join(attachmentsDir, `${attachmentId}.json`), meta);
    }

    const share: SharedConversation = {
      token,
      title: conversation.title,
      model: conversation.model ?? "",
      sharedAt: new Date().toISOString(),
      messages: conversation.messages,
    };
    await writeJsonFileAtomic(shareFile(token), share);
    if (!index[key]) await writeJsonFileAtomic(sharesIndexFile(), { ...index, [key]: token });
    return token;
  });
}

export async function getShare(token: string): Promise<SharedConversation | null> {
  if (!isValidShareToken(token)) return null;
  return readJsonFile<SharedConversation>(shareFile(token));
}

export async function readShareAttachment(
  token: string,
  attachmentId: string,
): Promise<{ meta: MessageAttachment; bytes: Buffer } | null> {
  if (!isValidShareToken(token) || !isValidId(attachmentId)) return null;
  const dir = shareAttachmentsDir(token);
  const meta = await readJsonFile<MessageAttachment>(path.join(dir, `${attachmentId}.json`)).catch(() => null);
  if (!meta) return null;
  const bytes = await fs.readFile(path.join(dir, `${attachmentId}.bin`)).catch(() => null);
  return bytes ? { meta, bytes } : null;
}

