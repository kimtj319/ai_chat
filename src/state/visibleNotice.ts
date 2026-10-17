/**
 * The part of a message's notice that is still shown.
 *
 * The context-summary announcement ("컨텍스트 한도에 도달하여 이전 대화 N개를
 * 요약해 이어갑니다…") is no longer sent, but answers stored before that change
 * still carry it, joined with "\n" to any other notice of the same turn. Those
 * lines are dropped here; everything else stays.
 */
const SUMMARY_NOTICE = /^컨텍스트 한도에 도달하여 이전 대화 \d+개를 요약해 이어갑니다\./;

export function visibleNotice(notice: string | undefined): string | null {
  if (!notice) return null;
  const kept = notice.split("\n").filter((line) => !SUMMARY_NOTICE.test(line.trim()));
  const text = kept.join("\n").trim();
  return text.length > 0 ? text : null;
}

/**
 * MCP 서버를 쓰지 못한 턴의 안내(mcp/toolAdapter.ts 가 서버마다 한 줄씩 보낸다).
 * 답변 아래에 문단으로 쌓이면 답보다 눈에 띄어, 한 줄 표시로 접고 펼치면 원문을 보인다.
 */
const MCP_FAILURE = /^MCP 서버 .*(사용할 수 없습니다|확인하지 못했습니다)/;

export interface NoticeParts {
  /** MCP 서버를 쓰지 못했다는 줄들(원문 그대로). */
  toolFailures: string[];
  /** 그 밖의 안내. 없으면 null. */
  other: string | null;
}

/** visibleNotice 가 남긴 글을 MCP 실패 줄과 나머지로 나눈다. */
export function partitionNotice(notice: string | null): NoticeParts {
  if (!notice) return { toolFailures: [], other: null };
  const toolFailures: string[] = [];
  const rest: string[] = [];
  for (const line of notice.split("\n")) {
    if (MCP_FAILURE.test(line.trim())) toolFailures.push(line.trim());
    else rest.push(line);
  }
  const other = rest.join("\n").trim();
  return { toolFailures, other: other.length > 0 ? other : null };
}
