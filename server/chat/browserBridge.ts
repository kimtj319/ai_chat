import crypto from "node:crypto";

/**
 * 서버 ↔ 사용자 브라우저 사이에 걸린 크롬 명령들.
 *
 * 크롬 도구(tools/browser.ts)는 서버에서 실행할 수 없다. 도구 루프는 명령을 하나
 * 걸어 두고(start), 그 턴의 스트림으로 웹페이지에 알린다. 페이지가 확장 프로그램에
 * 실행시키고 결과를 POST 하면(complete) 걸어 둔 약속이 풀리고 루프가 이어 간다.
 *
 * 기다림이 끝나는 길은 셋뿐이다: 결과가 오거나, 턴이 중지되거나(사용자의 중지·
 * 지금 답변하기·안전 상한), 시간이 다 되거나. 어느 쪽이든 한 번만 끝난다.
 */

/** 사용자 확인 창을 띄우고 기다리는 시간까지 포함한다. */
export const BROWSER_ACTION_TIMEOUT_MS = 5 * 60 * 1000;

export interface BrowserOutcome {
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface Pending {
  ownerId: string;
  conversationId: string;
  finish: (outcome: BrowserOutcome) => void;
}

const pending = new Map<string, Pending>();

export function startBrowserAction(
  ownerId: string,
  conversationId: string,
  signal: AbortSignal,
  timeoutMs = BROWSER_ACTION_TIMEOUT_MS,
): { callId: string; result: Promise<BrowserOutcome> } {
  const callId = crypto.randomUUID();
  let resolveOutcome!: (outcome: BrowserOutcome) => void;
  const result = new Promise<BrowserOutcome>((resolve) => {
    resolveOutcome = resolve;
  });
  const onAbort = () => finish({ ok: false, error: "턴이 중지되어 브라우저 동작의 결과를 기다리지 않았습니다." });
  const timer = setTimeout(
    () =>
      finish({
        ok: false,
        error: `브라우저가 ${Math.round(timeoutMs / 1000)}초 안에 응답하지 않았습니다. 확장 프로그램 연결을 확인해 주세요.`,
      }),
    timeoutMs,
  );
  timer.unref?.();
  function finish(outcome: BrowserOutcome) {
    if (!pending.delete(callId)) return;
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    resolveOutcome(outcome);
  }
  pending.set(callId, { ownerId, conversationId, finish });
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return { callId, result };
}

/** 페이지가 보낸 결과로 걸린 명령을 푼다. 그 계정·대화의 것이 아니면 false. */
export function completeBrowserAction(ownerId: string, conversationId: string, callId: string, outcome: BrowserOutcome): boolean {
  const entry = pending.get(callId);
  if (!entry || entry.ownerId !== ownerId || entry.conversationId !== conversationId) return false;
  entry.finish(outcome);
  return true;
}
