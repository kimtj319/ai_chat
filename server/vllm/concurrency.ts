/**
 * 모델 하나에 한꺼번에 보내는 요청 수의 상한.
 *
 * 모델 서버는 동시 요청이 어느 선을 넘으면 느려지는 것이 아니라 무너진다.
 * 운영 게이트웨이의 wise-lloa-ultra 로 실제 턴과 같은 본문(시스템 프롬프트 +
 * 도구 48개, 약 40KB)을 동시에 보냈을 때 30 개까지는 전부 13초 안에 끝났고,
 * 40 개에서는 19 개가 6분 넘게 걸리다 끊겼다(2026-10-18). 넘친 요청을 이쪽에서
 * 줄 세우면 늦게 온 사람이 몇 초 기다리는 것으로 끝난다.
 *
 * 줄은 둘이다: 사용자가 기다리는 답("turn")이 먼저, 그 옆의 곁 호출(제목 만들기·
 * 금지 문구 찾기, "side")은 그 뒤. 50 명이 한꺼번에 첫 질문을 하면 곁 호출이 자리의
 * 절반을 먼저 차지해 답의 첫 글자가 그만큼 늦었다.
 *
 * 열쇠는 "주소 + 모델" — 게이트웨이 하나가 모델마다 다른 GPU 로 보낸다.
 * 프로세스 하나 안의 상한이다(이 앱은 프로세스 하나로 돈다).
 */

export type SlotPriority = "turn" | "side";

interface Waiter {
  priority: SlotPriority;
  grant: () => void;
  signal: AbortSignal;
  onAbort: () => void;
}

interface Lane {
  active: number;
  queue: Waiter[];
}

const lanes = new Map<string, Lane>();

function lane(key: string): Lane {
  let found = lanes.get(key);
  if (!found) {
    found = { active: 0, queue: [] };
    lanes.set(key, found);
  }
  return found;
}

function abortError(): Error {
  const err = new Error("aborted while waiting for a model slot");
  err.name = "AbortError";
  return err;
}

/**
 * 사용자의 답이 지금 받으면 기다려야 하는가: 기다릴 필요가 없으면 -1, 있으면 앞에 선
 * 답의 수(곁 호출은 뒤로 밀리므로 세지 않는다).
 */
export function waitingAhead(key: string, limit: number): number {
  if (limit <= 0) return -1;
  const found = lanes.get(key);
  if (!found || found.active < limit) return -1;
  return found.queue.filter((w) => w.priority === "turn").length;
}

/**
 * 자리를 하나 받는다. 돌려받은 함수로 놓는다 — 두 번 불러도 한 번만 놓는다.
 * 기다리는 동안 signal 이 끊기면 줄에서 빠지고 AbortError 로 끝난다.
 */
export function acquireModelSlot(
  key: string,
  signal: AbortSignal,
  limit: number,
  priority: SlotPriority = "turn",
): Promise<() => void> {
  if (signal.aborted) return Promise.reject(abortError());
  const l = lane(key);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    l.active--;
    // 그만둔 사람은 abort 처리기가 이미 빼냈다. 답을 기다리는 맨 앞 사람, 없으면 곁 호출.
    const at = l.queue.findIndex((w) => w.priority === "turn");
    const next = l.queue.splice(at >= 0 ? at : 0, 1)[0];
    if (next) {
      next.signal.removeEventListener("abort", next.onAbort);
      next.grant();
    } else if (l.active === 0) {
      lanes.delete(key);
    }
  };
  if (limit <= 0 || l.active < limit) {
    l.active++;
    return Promise.resolve(release);
  }
  return new Promise((resolve, reject) => {
    const waiter: Waiter = {
      priority,
      signal,
      grant: () => {
        l.active++;
        resolve(release);
      },
      onAbort: () => {
        const at = l.queue.indexOf(waiter);
        if (at >= 0) l.queue.splice(at, 1);
        reject(abortError());
      },
    };
    signal.addEventListener("abort", waiter.onAbort, { once: true });
    l.queue.push(waiter);
  });
}
