import { useSyncExternalStore } from "react";
import { getExtensionState } from "./extension";

/**
 * 입력창의 "크롬 제어" 스위치. 새로고침하면 꺼진다 — 모델이 사용자의 브라우저를
 * 만지는 일은 매번 스스로 켜고 시작하는 편이 맞다.
 */
let enabled = false;
const listeners = new Set<() => void>();

export function setBrowserControl(next: boolean): void {
  enabled = next;
  for (const listener of listeners) listener();
}

export function useBrowserControl(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => enabled,
  );
}

/** 이번 턴에 크롬 도구를 실을지: 스위치가 켜져 있고 확장이 연결·활성 상태일 때. */
export function browserControlActive(): boolean {
  const ext = getExtensionState();
  return enabled && ext.available && ext.enabled;
}
