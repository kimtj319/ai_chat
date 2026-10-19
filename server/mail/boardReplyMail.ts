/**
 * 문의 게시판: 남이 답변을 달면 글쓴이에게 메일로 알린다.
 *
 * 답변 요청은 기다리지 않는다 — 메일 서버가 느리거나 죽어 있어도 답변은 이미
 * 저장됐고, 그것이 사람이 한 일의 전부다. 실패는 경고 한 줄로 남긴다.
 */
import { getUser, normalizeEmail, userNamesById } from "../storage/userStore.js";
import type { BoardPost, BoardReply } from "../types.js";
import { mailConfigFromEnv, sendMail } from "./smtp.js";

/** 답변이 아주 길면 메일에는 앞부분만. 나머지는 링크를 눌러 게시판에서 읽는다. */
const MAX_REPLY_CHARS = 4_000;

/**
 * 메일 속 링크의 앞부분. APP_BASE_URL 이 우선이고, 없으면 공유 링크용
 * SHARE_BASE_URL 을 빌린다 — 둘 다 "바깥에서 이 서버를 여는 주소" 다. 메일을 읽는
 * 사람이 어느 주소로 들어오는지 서버는 모르므로, 둘 다 없으면 링크를 뺀다.
 */
export function appBaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const raw of [env.APP_BASE_URL, env.SHARE_BASE_URL]) {
    const value = raw?.trim();
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.protocol === "http:" || url.protocol === "https:") return url.toString().replace(/\/+$/, "");
    } catch {
      // 주소가 아니면 다음 후보. configCheck 가 기동 때 이미 말했다.
    }
  }
  return undefined;
}

export function composeReplyMail(input: {
  post: Pick<BoardPost, "id" | "number" | "title">;
  reply: Pick<BoardReply, "body" | "authorId">;
  postAuthorName: string;
  replierName: string;
  baseUrl?: string;
}): { subject: string; text: string } {
  const { post, reply } = input;
  const ref = post.number ? `#${post.number} ` : "";
  const body =
    reply.body.length > MAX_REPLY_CHARS
      ? `${reply.body.slice(0, MAX_REPLY_CHARS)}\n…(답변이 길어 앞 ${MAX_REPLY_CHARS.toLocaleString()}자만 실었습니다. 전체는 게시판에서 보세요.)`
      : reply.body;
  const lines = [
    `${input.postAuthorName} 님, 문의 게시판에 올리신 글에 답변이 달렸습니다.`,
    "",
    `글: ${ref}${post.title}`,
    `답변한 사람: ${input.replierName} (@${reply.authorId})`,
    "",
    "----- 답변 -----",
    body,
    "----------------",
    "",
  ];
  if (input.baseUrl) lines.push(`글 보기: ${input.baseUrl}/#/board/${encodeURIComponent(post.id)}`, "");
  lines.push("이 메일은 보내기 전용입니다. 이어서 묻거나 답하려면 게시판에 남겨 주세요.");
  return { subject: `[AI Console 문의 게시판] ${ref}${post.title} 에 답변이 달렸습니다`, text: lines.join("\n") };
}

/**
 * 답변 하나를 글쓴이에게 알린다. 보내지 않는 경우: 메일이 꺼져 있다, 글쓴이가
 * 직접 답했다, 글쓴이 계정이 없거나 막혔다, 등록된 주소가 주소 모양이 아니다.
 *
 * 절대 던지지 않는다 — 부르는 쪽은 기다리지 않고 버린다(void). 돌려주는 약속은
 * 검사가 끝을 기다릴 때만 쓴다.
 */
export async function notifyBoardReply(post: BoardPost, reply: BoardReply): Promise<void> {
  const cfg = mailConfigFromEnv();
  if (!cfg || reply.authorId === post.authorId) return;
  try {
    const author = await getUser(post.authorId);
    if (!author || author.status === "blocked") return;
    const to = normalizeEmail(author.email);
    if (!to) return;
    const names = await userNamesById([reply.authorId]);
    const mail = composeReplyMail({
      post,
      reply,
      postAuthorName: author.name || author.id,
      replierName: names.get(reply.authorId) ?? reply.authorId,
      baseUrl: appBaseUrl(),
    });
    await sendMail(cfg, { to, ...mail });
    console.log(`[mail] 답변 알림 보냄 ${post.number ? `#${post.number}` : post.id} → ${author.id}`);
  } catch (err) {
    const reason = (err as Error)?.message ?? String(err);
    console.warn(`[mail] 답변 알림을 보내지 못했습니다 (${post.number ? `#${post.number}` : post.id} → ${post.authorId}): ${reason.replace(/\s+/g, " ")}`);
  }
}
