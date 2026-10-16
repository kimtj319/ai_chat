import { createId } from "../state/defaults";
import { useSyncExternalStore } from "react";
import type { BrowserConfirmRequest } from "./extension";

/**
 * 크롬 동작 확인 창의 대기열. 확인은 사용자만 할 수 있다 — 모델의 명령이 확장에서
 * "확인 필요" 로 돌아오면 여기에 올리고, 사용자가 고를 때까지 기다린다.
 * 화면은 components/BrowserConfirmHost.tsx 가 그린다.
 */
export interface PendingConfirm {
  id: string;
  request: BrowserConfirmRequest;
  resolve: (allowed: boolean) => void;
}

let queue: PendingConfirm[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function askBrowserConfirm(request: BrowserConfirmRequest, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const id = createId();
    const done = (allowed: boolean) => {
      if (!queue.some((item) => item.id === id)) return;
      queue = queue.filter((item) => item.id !== id);
      emit();
      resolve(allowed);
    };
    // 중지를 누르면 떠 있던 확인 창도 거절로 닫는다.
    signal?.addEventListener("abort", () => done(false), { once: true });
    queue = [...queue, { id, request, resolve: done }];
    emit();
    if (signal?.aborted) done(false);
  });
}

export function usePendingBrowserConfirm(): PendingConfirm | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => queue[0] ?? null,
  );
}
