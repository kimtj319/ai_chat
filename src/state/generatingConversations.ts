import { useSyncExternalStore } from "react";

/**
 * 지금 답을 만들고 있는 대화들의 id. useChatStream 이 턴을 시작하고 끝낼 때 고친다.
 *
 * 흐르는 상태는 ChatShell 의 useChatStream 안에 있어 사이드바까지 내려가지 않는다.
 * 사이드바 줄에 "답변 중" 표시를 하려고 그 훅을 줄마다 넘기는 대신 이 작은 저장소를
 * 읽는다 — 집합이 실제로 바뀔 때만 알리므로, 토큰이 흐르는 동안 사이드바는 그대로다.
 */
let current: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

export function setGeneratingConversations(ids: Iterable<string>): void {
  const next = new Set(ids);
  if (next.size === current.size && [...next].every((id) => current.has(id))) return;
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => current;

/** 답을 만들고 있는 대화 id 들. `useGeneratingConversationIds().has(conversation.id)` 처럼 쓴다. */
export function useGeneratingConversationIds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
