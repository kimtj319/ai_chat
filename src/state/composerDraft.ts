/**
 * 대화마다 따로 두는 입력창 초안. 다른 대화를 보고 오면 쓰던 글이 그대로 있어야 한다
 * (ChatGPT·Claude 가 그렇다). 예전에는 대화를 옮기는 순간 버려졌다(감사 A1-06).
 *
 * 메모리가 먼저이고 sessionStorage 는 새로 고침을 넘기 위한 사본이다 — 탭을 닫으면
 * 사라지는 것이 맞다(남의 자리에서 연 탭에 초안이 남지 않게). 저장소가 막혀 있으면
 * (사생활 보호 창 등) 이 탭 안에서만 남는다. 보내면(빈 글) 지운다.
 */
const PREFIX = "composer-draft:";
const memory = new Map<string, string>();

export function readDraft(conversationId: string): string {
  const held = memory.get(conversationId);
  if (held !== undefined) return held;
  try {
    return sessionStorage.getItem(PREFIX + conversationId) ?? "";
  } catch {
    return "";
  }
}

export function writeDraft(conversationId: string, text: string): void {
  if (text.length === 0) memory.delete(conversationId);
  else memory.set(conversationId, text);
  try {
    if (text.length === 0) sessionStorage.removeItem(PREFIX + conversationId);
    else sessionStorage.setItem(PREFIX + conversationId, text);
  } catch {
    // 막힌 저장소 — 메모리의 것으로 충분하다.
  }
}

/** 검사용: 새로 고침처럼 메모리만 비운다. */
export function forgetDraftsInMemory(): void {
  memory.clear();
}
