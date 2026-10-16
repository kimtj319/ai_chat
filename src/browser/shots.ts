import { useSyncExternalStore } from "react";
import type { BrowserShot } from "./extension";

/**
 * 크롬 동작마다 확장이 찍어 보낸 화면. 도구 호출 id 별로 모은다 — 대화 속 도구 기록과
 * 같은 id 라, 답변 하나에 딸린 화면을 그 답변 아래에 모아 보여 줄 수 있다.
 *
 * 이 브라우저의 메모리에만 있다. 서버에 저장하지 않으므로 새로고침하면 사라진다 —
 * 한 장에 수십~백 KB 라 대화 기록에 쌓으면 대화 파일이 금방 커진다.
 */
export interface ShotEntry extends BrowserShot {
  toolCallId: string;
  key: string;
}

const MAX_SHOTS = 80;
let entries: ShotEntry[] = [];
let version = 0;
const listeners = new Set<() => void>();

export function addBrowserShots(toolCallId: string, shots: BrowserShot[] | undefined | null): void {
  const list = (shots ?? []).filter((s): s is BrowserShot => Boolean(s?.image));
  if (list.length === 0) return;
  entries = [...entries, ...list.map((shot, i) => ({ ...shot, toolCallId, key: `${toolCallId}:${shot.at}:${i}` }))].slice(-MAX_SHOTS);
  version++;
  for (const listener of listeners) listener();
}

/** 이 도구 호출들에 딸린 화면을 찍힌 순서대로. */
export function useBrowserShots(toolCallIds: readonly string[]): ShotEntry[] {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
  );
  if (toolCallIds.length === 0) return [];
  const wanted = new Set(toolCallIds);
  return entries.filter((entry) => wanted.has(entry.toolCallId));
}
