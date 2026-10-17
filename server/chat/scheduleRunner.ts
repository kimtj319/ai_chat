import crypto from "node:crypto";
import { mutateConversation } from "../storage/conversationStore.js";
import { listSchedules, ownersWithSchedules, updateSchedule, type ScheduledTask } from "../storage/scheduleStore.js";
import type { StoredMessage } from "../types.js";
import { formatKst } from "./scheduleTime.js";
import { runConversationTurn } from "./toolLoop.js";
import { assistantMessageFromTurn } from "./turnMessage.js";

/**
 * 예약 작업 실행 루프.
 *
 *   크롬이 필요 없는 예약 — 서버가 그 시각에 직접 실행한다: 지시를 이 대화의 새 질문으로
 *     넣고 턴을 돌려 답을 남긴다. 그 사람이 앱을 열어 두지 않아도 된다.
 *   크롬이 필요한 예약 — 서버는 실행할 수 없다(크롬은 그 사람의 PC 에 있다). 그 사람의
 *     AI Console 탭이 시각에 맞춰 맡아(claim) 크롬 제어를 켜고 보낸다. 서버는 기다리다가
 *     GRACE 동안 아무도 맡지 않으면 "놓침" 으로 끝내고 대화에 그 사실을 남긴다.
 *   맡은 뒤 끝을 알리지 않은 예약(탭이 닫힘 등)은 STALE 뒤에 실패로 정리한다.
 */
export const TICK_MS = 5_000;
export const GRACE_MS = 10 * 60 * 1000;
const STALE_RUNNING_MS = 30 * 60 * 1000;
const TURN_TIMEOUT_MS = 30 * 60 * 1000;

/** 예약이 대화에 들어갈 때의 머리말 — 사람이 보낸 말과 구별되게. */
export function scheduledPrompt(task: ScheduledTask): string {
  return `[예약 작업 · ${formatKst(new Date(task.runAt)).slice(11, 16)}] ${task.instruction}`;
}

/** 대화 끝에 메시지 하나를 더한다. 대화가 지워졌으면 null. */
function pushMessage(ownerId: string, conversationId: string, message: StoredMessage) {
  return mutateConversation(ownerId, conversationId, (conv) => {
    conv.messages.push(message);
    return conv;
  });
}

async function appendNotice(ownerId: string, conversationId: string, text: string): Promise<void> {
  const message: StoredMessage = {
    id: crypto.randomUUID(),
    role: "assistant",
    content: text,
    createdAt: new Date().toISOString(),
  } as StoredMessage;
  await pushMessage(ownerId, conversationId, message);
}

async function runOnServer(ownerId: string, task: ScheduledTask): Promise<void> {
  const startedAt = Date.now();
  try {
    const user: StoredMessage = { id: crypto.randomUUID(), role: "user", content: scheduledPrompt(task), createdAt: new Date().toISOString() } as StoredMessage;
    const conversation = await pushMessage(ownerId, task.conversationId, user);
    if (!conversation) throw new Error("대화가 지워져 실행하지 못했습니다.");
    const generator = runConversationTurn(conversation, ownerId, AbortSignal.timeout(TURN_TIMEOUT_MS), new AbortController().signal, {});
    let step = await generator.next();
    while (!step.done) step = await generator.next();
    const result = step.value;
    await pushMessage(ownerId, task.conversationId, assistantMessageFromTurn(result, startedAt));
    await finishSchedule(ownerId, task.id, result.error ? "failed" : "done", result.error);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[schedule] ${ownerId}/${task.id} failed on server: ${message}`);
    await finishSchedule(ownerId, task.id, "failed", message);
  }
}

export async function finishSchedule(ownerId: string, id: string, status: "done" | "failed", note?: string) {
  return updateSchedule(ownerId, id, (t) =>
    t.status === "running" ? { ...t, status, finishedAt: new Date().toISOString(), ...(note ? { note: note.slice(0, 300) } : {}) } : null,
  );
}

/** 한 번 돈다. 시험에서 시각을 넣어 부를 수 있게 now 를 받는다. */
export async function runDueSchedules(now = Date.now()): Promise<void> {
  for (const ownerId of await ownersWithSchedules()) {
    for (const task of await listSchedules(ownerId)) {
      const runAt = Date.parse(task.runAt);
      if (task.status === "pending" && runAt <= now) {
        if (!task.useBrowser) {
          const claimed = await updateSchedule(ownerId, task.id, (t) =>
            t.status === "pending" ? { ...t, status: "running", startedAt: new Date(now).toISOString(), note: "서버가 실행" } : null,
          );
          if (claimed) void runOnServer(ownerId, claimed);
        } else if (now - runAt > GRACE_MS) {
          const missed = await updateSchedule(ownerId, task.id, (t) =>
            t.status === "pending"
              ? { ...t, status: "missed", finishedAt: new Date(now).toISOString(), note: "그 시각에 크롬·AI Console 이 연결돼 있지 않았습니다." }
              : null,
          );
          if (missed) {
            await appendNotice(
              ownerId,
              task.conversationId,
              `예약 작업을 실행하지 못했습니다(${formatKst(new Date(task.runAt))}). 그 시각에 이 계정의 AI Console 탭과 크롬 연결 확장이 켜져 있지 않았습니다.\n\n> ${task.instruction}`,
            ).catch(() => {});
          }
        }
      } else if (task.status === "running" && task.startedAt && now - Date.parse(task.startedAt) > STALE_RUNNING_MS) {
        await updateSchedule(ownerId, task.id, (t) =>
          t.status === "running" ? { ...t, status: "failed", finishedAt: new Date(now).toISOString(), note: "실행을 맡은 곳이 끝을 알리지 않았습니다." } : null,
        );
      }
    }
  }
}

export function startScheduleRunner(): () => void {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    runDueSchedules()
      .catch((err) => console.warn("[schedule] tick failed:", err))
      .finally(() => {
        busy = false;
      });
  }, TICK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
