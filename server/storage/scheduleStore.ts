import crypto from "node:crypto";
import fs from "node:fs/promises";
import { readJsonFile, writeJsonFileAtomic } from "./atomic.js";
import { withLock } from "./mutex.js";
import { isValidId, ownerSchedulesFile, ownersRoot } from "./paths.js";

/**
 * 예약 작업. 계정마다 파일 하나(`owners/<id>/schedules.json`)에 목록으로 둔다 —
 * 한 사람이 걸어 두는 예약은 많아야 수십 개라 한 파일이 가장 단순하다.
 *
 *   pending   — 시각을 기다린다.
 *   running   — 누군가(서버 또는 그 사람의 AI Console 탭)가 실행을 맡았다.
 *   done / failed / missed / cancelled — 끝.
 */
export type ScheduleStatus = "pending" | "running" | "done" | "failed" | "missed" | "cancelled";

export interface ScheduledTask {
  id: string;
  conversationId: string;
  /** 그 시각에 대화에 보낼 지시. 모델이 예약할 때 스스로 완결된 문장으로 적는다. */
  instruction: string;
  /** ISO 시각(UTC). */
  runAt: string;
  /** 사용자의 크롬이 필요한 작업 — 그 사람의 AI Console 탭이 실행한다. 아니면 서버가 실행한다. */
  useBrowser: boolean;
  status: ScheduleStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** 끝난 사정 한 줄(실패·놓침 이유 등). */
  note?: string;
}

/** 한 계정이 동시에 걸어 둘 수 있는 예약 수. */
export const MAX_PENDING_PER_OWNER = 20;
/** 끝난 예약은 이만큼만 남긴다(최근 것). */
const KEEP_FINISHED = 50;

const lockFor = (ownerId: string) => `schedules:${ownerId}`;

/** 목록용. 못 읽으면 "예약 없음" 으로 넘어간다 — 요청을 실패시키지 않는다. */
async function read(ownerId: string): Promise<ScheduledTask[]> {
  return readForUpdate(ownerId).catch(() => []);
}

/** 고쳐 쓸 때. 파일을 통째로 다시 쓰므로 읽기 실패는 쓰기 실패여야 한다 — 아니면 다른 예약이 모두 사라진다. */
async function readForUpdate(ownerId: string): Promise<ScheduledTask[]> {
  const data = await readJsonFile<{ tasks?: ScheduledTask[] }>(ownerSchedulesFile(ownerId));
  return Array.isArray(data?.tasks) ? data.tasks : [];
}

async function write(ownerId: string, tasks: ScheduledTask[]): Promise<void> {
  const open = tasks.filter((t) => t.status === "pending" || t.status === "running");
  const finished = tasks
    .filter((t) => t.status !== "pending" && t.status !== "running")
    .sort((a, b) => (a.finishedAt ?? a.runAt).localeCompare(b.finishedAt ?? b.runAt))
    .slice(-KEEP_FINISHED);
  await writeJsonFileAtomic(ownerSchedulesFile(ownerId), {
    tasks: [...open, ...finished].sort((a, b) => a.runAt.localeCompare(b.runAt)),
  });
}

export async function listSchedules(ownerId: string): Promise<ScheduledTask[]> {
  return read(ownerId);
}

export class ScheduleLimitError extends Error {}

export async function createSchedule(
  ownerId: string,
  input: { conversationId: string; instruction: string; runAt: Date; useBrowser: boolean },
): Promise<ScheduledTask> {
  return withLock(lockFor(ownerId), async () => {
    const tasks = await readForUpdate(ownerId);
    if (tasks.filter((t) => t.status === "pending").length >= MAX_PENDING_PER_OWNER) {
      throw new ScheduleLimitError(`예약은 한 번에 ${MAX_PENDING_PER_OWNER}개까지 걸어 둘 수 있습니다.`);
    }
    const task: ScheduledTask = {
      id: crypto.randomUUID(),
      conversationId: input.conversationId,
      instruction: input.instruction,
      runAt: input.runAt.toISOString(),
      useBrowser: input.useBrowser,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    await write(ownerId, [...tasks, task]);
    return task;
  });
}

/**
 * 한 예약을 고친다. mutate 가 null 을 돌려주면 고치지 않는다(조건이 맞지 않음).
 * 고친 예약을 돌려준다 — 없거나 고치지 않았으면 null.
 */
export async function updateSchedule(
  ownerId: string,
  id: string,
  mutate: (task: ScheduledTask) => ScheduledTask | null,
): Promise<ScheduledTask | null> {
  if (!isValidId(id)) return null;
  return withLock(lockFor(ownerId), async () => {
    const tasks = await readForUpdate(ownerId);
    const index = tasks.findIndex((t) => t.id === id);
    if (index < 0) return null;
    const next = mutate({ ...tasks[index]! });
    if (!next) return null;
    tasks[index] = next;
    await write(ownerId, tasks);
    return next;
  });
}

/** 예약이 있는 계정들(서버의 실행 루프가 돈다). */
export async function ownersWithSchedules(): Promise<string[]> {
  const entries = await fs.readdir(ownersRoot(), { withFileTypes: true }).catch(() => []);
  const owners: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidId(entry.name)) continue;
    const exists = await fs.stat(ownerSchedulesFile(entry.name)).then(() => true, () => false);
    if (exists) owners.push(entry.name);
  }
  return owners;
}
