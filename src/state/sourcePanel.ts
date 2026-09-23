import { useSyncExternalStore } from "react";
import type { CitationSource } from "./citations";

/**
 * 오른쪽 출처 창에 지금 띄운 단락. 답변 속 "[n]" 을 누르면 열리고, 닫기·Esc 로
 * 닫힌다. 창은 앱 레이아웃(App)이 그리고 링크는 메시지 안에 있어서, 둘 사이를
 * props 로 잇는 대신 이 작은 저장소 하나를 같이 본다.
 */
let current: CitationSource | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function openSource(source: CitationSource): void {
  current = source;
  emit();
}

export function closeSource(): void {
  if (current === null) return;
  current = null;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useOpenSource(): CitationSource | null {
  return useSyncExternalStore(subscribe, () => current);
}
