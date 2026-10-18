import { useEffect, useRef, useSyncExternalStore } from "react";
import { claimSchedule, finishSchedule, listSchedules, type ScheduledTask } from "../api/client";
import { showToast } from "../components/Toast";
import { getExtensionState, sendBrowserCommand } from "./extension";

/**
 * 예약 작업 — 웹페이지 쪽.
 *
 * 크롬이 필요한 예약은 서버가 실행할 수 없다(크롬은 이 PC 에 있다). 그래서 이 탭이
 * 시각에 맞춰 예약을 맡아(claim) 그 대화를 열고 지시를 보낸다 — 크롬 제어를 켜고.
 * 크롬이 필요 없는 예약은 서버가 알아서 실행한다(server/chat/scheduleRunner.ts).
 *
 * 시각 맞추기:
 *   - 목록을 받을 때 서버 시각도 받아, 이 PC 시계와의 차이만큼 당기거나 미룬다.
 *   - 예약마다 정확한 시각에 타이머를 건다. 백그라운드 탭의 타이머는 크롬이 최대 1분까지
 *     늦추므로, 확장 프로그램의 알람이 1분 전에 이 탭을 깨워(wake) 타이머를 새로 건다.
 *   - 15초마다 목록을 다시 받아, 놓친 예약(GRACE 안)도 집는다. 탭이 가려져 있으면 1분마다
 *     (크롬도 오래 가려진 탭의 타이머를 그만큼 늦춘다) — 아주 멈추지는 않는다. 다른 기기에서
 *     만든 예약은 이 탭이 목록을 받아야 알게 되고, 가려진 탭에서 도는 것이 예약 작업이다.
 *     다시 보이면 곧바로 받는다.
 * 탭이 여럿이어도 서버의 claim 은 한 곳만 성공한다.
 */

const POLL_MS = 15_000;
const HIDDEN_POLL_MS = 60_000;
/** 서버의 놓침 판정(GRACE_MS)과 같다 — 그보다 늦으면 페이지도 집지 않는다. */
const GRACE_MS = 10 * 60 * 1000;
const MAX_TIMER_MS = 2_147_000_000;

let tasks: ScheduledTask[] = [];
/** 서버 시각 − 이 PC 시각. */
let offsetMs = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export async function refreshSchedules(): Promise<void> {
  try {
    const { now, tasks: next } = await listSchedules();
    offsetMs = Date.parse(now) - Date.now();
    tasks = next;
    emit();
    syncExtensionAlarms();
  } catch {
    // 다음 주기에 다시.
  }
}

/** 확장에게 크롬 예약의 시각을 알려 알람을 걸게 한다(탭이 잠들어 있거나 닫혀 있어도 깨우도록). */
function syncExtensionAlarms() {
  const ext = getExtensionState();
  if (!ext.available || !ext.enabled) return;
  const upcoming = tasks
    .filter((t) => t.status === "pending" && t.useBrowser)
    .map((t) => ({ id: t.id, at: Date.parse(t.runAt) - offsetMs }));
  void sendBrowserCommand({ name: "sync_schedules", args: { tasks: upcoming } }, 10_000);
}

export function useSchedules(): ScheduledTask[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => tasks,
  );
}

interface RunnerDeps {
  isStreaming: boolean;
  sendMessage: (
    conversationId: string,
    text: string,
    attachmentIds?: string[],
    options?: { browserControl?: boolean; onSettled?: (ok: boolean, note?: string) => void },
  ) => void;
  selectConversation: (id: string | null) => Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** ChatShell 에서 한 번 쓴다. 로그인한 동안 예약을 지켜보고 시각이 되면 실행한다. */
export function useScheduleRunner(deps: RunnerDeps): void {
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const inflight = useRef(new Set<string>());
  const warned = useRef(new Set<string>());
  const list = useSchedules();

  // 목록 받기: 처음, 주기적으로, 확장이 깨울 때, 답변이 끝날 때(방금 예약했을 수 있다).
  useEffect(() => {
    void refreshSchedules();
    let poll = 0;
    const startPolling = () => {
      window.clearInterval(poll);
      poll = window.setInterval(() => void refreshSchedules(), document.hidden ? HIDDEN_POLL_MS : POLL_MS);
    };
    const handleVisibility = () => {
      if (!document.hidden) void refreshSchedules();
      startPolling();
    };
    startPolling();
    const wake = () => void refreshSchedules();
    window.addEventListener("aic-schedule-wake", wake);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearInterval(poll);
      window.removeEventListener("aic-schedule-wake", wake);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);
  // 답변이 끝날 때만. 처음 마운트에서는 위가 이미 받았다(같은 요청이 두 번 나가던 것).
  const wasStreaming = useRef(deps.isStreaming);
  useEffect(() => {
    if (wasStreaming.current && !deps.isStreaming) void refreshSchedules();
    wasStreaming.current = deps.isStreaming;
  }, [deps.isStreaming]);

  useEffect(() => {
    async function run(task: ScheduledTask) {
      if (inflight.current.has(task.id)) return;
      const ext = getExtensionState();
      if (!ext.available || !ext.enabled) {
        // 맡지 않는다 — GRACE 안에 확장이 연결되면 다음 주기에 다시 집는다. 알림은 한 번만.
        if (!warned.current.has(task.id)) {
          warned.current.add(task.id);
          showToast("예약 작업 시각이지만 크롬 연결 확장이 꺼져 있어 기다리는 중입니다.", "error");
        }
        return;
      }
      inflight.current.add(task.id);
      let prompt: string;
      try {
        prompt = (await claimSchedule(task.id)).prompt;
      } catch {
        return; // 다른 탭이 맡았거나 이미 끝났다.
      }
      showToast("예약 작업을 시작합니다.");
      // 진행 중인 답변이 있으면 끝나기를 기다린다(최대 10분).
      for (let i = 0; i < 1200 && depsRef.current.isStreaming; i++) await sleep(500);
      if (depsRef.current.isStreaming) {
        await finishSchedule(task.id, false, "다른 답변이 끝나지 않아 실행하지 못했습니다.").catch(() => {});
        return;
      }
      await depsRef.current.selectConversation(task.conversationId);
      await sleep(300); // 대화가 화면에 열린 뒤 보낸다.
      depsRef.current.sendMessage(task.conversationId, prompt, [], {
        browserControl: true,
        onSettled: (ok, note) => {
          void finishSchedule(task.id, ok, note)
            .catch(() => {})
            .finally(() => void refreshSchedules());
        },
      });
    }

    const timers: number[] = [];
    for (const task of list) {
      if (task.status !== "pending" || !task.useBrowser) continue;
      const delay = Date.parse(task.runAt) - offsetMs - Date.now();
      if (delay <= 0) {
        if (-delay < GRACE_MS) void run(task);
      } else if (delay < MAX_TIMER_MS) {
        timers.push(window.setTimeout(() => void run(task), delay));
      }
    }
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [list]);
}
