/**
 * 답변 👍/👎 기록. `{DATA_DIR}/owners/<id>/feedback.jsonl`, 바뀔 때마다 한 줄씩 덧붙인다.
 *
 * 지금 상태는 메시지 자체(StoredMessage.feedback)가 들고 있어 다시 열면 그대로 보인다.
 * 이 파일은 그와 별개로 "언제 무엇을 눌렀나" 의 이력이다 — 사내 모델을 평가할 때 대화
 * 파일을 전부 뒤지지 않고 이것만 모으면 된다. 지운 것(rating null)도 한 줄로 남긴다:
 * 마음을 바꾼 것도 신호다. 계정과 함께 지워지도록 소유자 폴더 안에 둔다.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { withLock } from "./mutex.js";
import { ownerDir } from "./paths.js";

export interface FeedbackRecord {
  at: string;
  conversationId: string;
  messageId: string;
  /** 대화의 모델. 모델을 비워 둔 대화는 평가할 때의 서버 기본 모델, 그것도 모르면 빈 문자열. */
  model: string;
  rating: "up" | "down" | null;
  reason?: string;
}

export function ownerFeedbackFile(ownerId: string): string {
  return path.join(ownerDir(ownerId), "feedback.jsonl");
}

export async function appendFeedback(ownerId: string, record: FeedbackRecord): Promise<void> {
  const file = ownerFeedbackFile(ownerId);
  await withLock(`feedback:${ownerId}`, async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
  });
}
