import { createId } from "../state/defaults";
import { useSyncExternalStore } from "react";

/**
 * 크롬 확장 프로그램(extension/)과의 연결. 확장의 중계 스크립트(bridge.js)는
 * 사용자가 확장 창에 적은 AI Console 주소의 페이지에만 들어오고, window.postMessage
 * 로 말한다. 이 파일은 그 말을 받아 상태로 들고, 명령을 보내고 답을 기다린다.
 *
 * 받는 메시지는 이 페이지 자신(같은 window·같은 출처)에서 온 것만 믿는다.
 */

export interface ExtensionState {
  /** 중계가 인사를 보냈다 — 확장이 설치돼 있고 이 주소로 연결돼 있다. */
  available: boolean;
  /** 사용자가 확장 창에서 연결을 켜 두었다. */
  enabled: boolean;
  version: string;
}

/** 확장이 찍은 작업 화면 한 장(모델에게는 가지 않는다). */
export interface BrowserShot {
  /** data:image/jpeg URL. 확장이 폭 1280 이하로 줄여 보낸다. */
  image: string;
  /** 그때 하던 일 — "페이지 읽는 중", "누르기: 더보기" 같은. */
  caption: string;
  url: string;
  title: string;
  at: number;
}

export interface BrowserConfirmRequest {
  kind: "site" | "action";
  host: string;
  message: string;
  /** 누르거나 입력하려는 대상에 강조 상자를 그린 화면. */
  preview?: BrowserShot | null;
}

type WithVisual = { visual?: { shots: BrowserShot[] } };

export type ExtensionResponse =
  | ({ ok: true; result: unknown } & WithVisual)
  | ({ ok: false; error: string } & WithVisual)
  | { needsConfirm: BrowserConfirmRequest };

export interface BrowserCommand {
  name: string;
  args: unknown;
  /** 사용자가 허용한 것: 이 사이트(allowSite) 또는 이 한 번의 동작(action). */
  confirm?: { allowSite?: string; action?: boolean };
}

let state: ExtensionState = { available: false, enabled: false, version: "" };
const listeners = new Set<() => void>();
const waiting = new Map<string, (response: ExtensionResponse) => void>();

function emit() {
  for (const listener of listeners) listener();
}

function onMessage(event: MessageEvent) {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const data = event.data as { source?: string; type?: string; requestId?: string; response?: ExtensionResponse; enabled?: boolean; version?: string } | null;
  if (!data || data.source !== "aic-ext") return;
  if (data.type === "hello") {
    state = { available: true, enabled: data.enabled === true, version: String(data.version ?? "") };
    emit();
  } else if (data.type === "wake") {
    // 확장의 알람이 예약 시각 직전에 깨웠다(browser/scheduler.ts 가 듣는다).
    window.dispatchEvent(new Event("aic-schedule-wake"));
  } else if (data.type === "result" && data.requestId) {
    waiting.get(data.requestId)?.(data.response ?? { ok: false, error: "확장 프로그램이 빈 응답을 보냈습니다." });
    waiting.delete(data.requestId);
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("message", onMessage);
  // 중계가 먼저 들어와 인사를 했으면 놓쳤을 수 있다 — 한 번 더 불러 본다.
  window.postMessage({ source: "aic-page", type: "ping" }, window.location.origin);
}

export function getExtensionState(): ExtensionState {
  return state;
}

export function useBrowserExtension(): ExtensionState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

/** 확장에 명령 하나. 확장이 답하지 않으면 timeoutMs 뒤 실패로 끝난다. */
export function sendBrowserCommand(command: BrowserCommand, timeoutMs = 90_000): Promise<ExtensionResponse> {
  if (!state.available) return Promise.resolve({ ok: false, error: "크롬 확장 프로그램이 연결돼 있지 않습니다." });
  const requestId = createId();
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      waiting.delete(requestId);
      resolve({ ok: false, error: `크롬 확장 프로그램이 ${Math.round(timeoutMs / 1000)}초 안에 답하지 않았습니다.` });
    }, timeoutMs);
    waiting.set(requestId, (response) => {
      window.clearTimeout(timer);
      resolve(response);
    });
    window.postMessage({ source: "aic-page", type: "command", requestId, command }, window.location.origin);
  });
}
