import { formatKst, parseRunAt } from "../chat/scheduleTime.js";
import { createSchedule, listSchedules, updateSchedule } from "../storage/scheduleStore.js";
import type { ToolContext, ToolDefinition } from "./types.js";

/**
 * 예약 작업 도구. 모델은 "11시에 …해 줘" 를 받으면 지금 하지 않고 이 도구로 예약한다.
 * 그 시각에 지시가 이 대화의 새 질문처럼 들어가 실행된다(chat/scheduleRunner.ts):
 * 크롬이 필요 없으면 서버가, 필요하면 그 사람의 AI Console 탭이 크롬 제어를 켜고 보낸다.
 */

function requireContext(ctx: ToolContext | undefined): ToolContext {
  if (!ctx) throw new Error("예약은 대화 안에서만 걸 수 있습니다.");
  return ctx;
}

export const scheduleTaskTool: ToolDefinition = {
  name: "schedule_task",
  category: "schedule",
  description:
    "Schedule a task to run automatically at a later time. Use it whenever the user's request names a time to do it — " +
    "e.g. \"11시에 팝콘통을 장바구니에 담아줘\", \"10:53에 열어서 확인해줘\", \"내일 9시에\", \"30분 뒤에\". " +
    "Any time the user states is a FUTURE time to schedule: you do not need to know the current time, the server resolves it. " +
    "Do NOT perform the task now and do not open or read any page now — only schedule it, then tell the user when it will run. " +
    "At that time the instruction is sent into this same conversation as a new user request and executed with the tools then available " +
    "(the user's Chrome when use_browser is true). " +
    "Write the instruction as a complete, self-contained request in the user's language (what site, what to pick, what to do), " +
    "without the time. Times are Korea Standard Time.",
  parameters: {
    type: "object",
    properties: {
      run_at: {
        type: "string",
        description:
          'When to run, in Korea time: "HH:MM" (today, or tomorrow if already past), "YYYY-MM-DD HH:MM", ' +
          '"+30m" / "+2h" (from now), or ISO 8601 with an offset.',
      },
      instruction: { type: "string", description: "The request to execute at that time, self-contained." },
      use_browser: {
        type: "boolean",
        description: "Whether the task needs the user's Chrome. Defaults to true when Chrome control is on in this turn.",
      },
    },
    required: ["run_at", "instruction"],
  },
  async execute(args: { run_at?: string; instruction?: string; use_browser?: boolean }, ctx?: ToolContext) {
    const { ownerId, conversationId, browserControl } = requireContext(ctx);
    const instruction = String(args.instruction ?? "").trim();
    if (instruction.length < 2) throw new Error("instruction 이 비었습니다.");
    if (instruction.length > 2000) throw new Error("instruction 이 너무 깁니다(2000자까지).");
    const runAt = parseRunAt(String(args.run_at ?? ""));
    const useBrowser = typeof args.use_browser === "boolean" ? args.use_browser : browserControl === true;
    const task = await createSchedule(ownerId, { conversationId, instruction, runAt, useBrowser });
    return {
      scheduled: true,
      id: task.id,
      runAtKst: formatKst(runAt),
      instruction,
      useBrowser,
      note: useBrowser
        ? "그 시각에 이 컴퓨터의 크롬과 AI Console 크롬 연결 확장이 켜져 있어야 합니다. 결제·구매처럼 확인이 필요한 동작은 그때 사용자 확인을 기다립니다."
        : "그 시각에 서버가 실행하고 결과를 이 대화에 남깁니다.",
    };
  },
};

export const listScheduledTasksTool: ToolDefinition = {
  name: "list_scheduled_tasks",
  category: "schedule",
  description: "List the user's scheduled tasks (pending ones and recent results), with their ids and times in Korea time.",
  parameters: { type: "object", properties: {} },
  async execute(_args: unknown, ctx?: ToolContext) {
    const { ownerId, conversationId } = requireContext(ctx);
    const tasks = await listSchedules(ownerId);
    return tasks.slice(-30).map((t) => ({
      id: t.id,
      runAtKst: formatKst(new Date(t.runAt)),
      status: t.status,
      instruction: t.instruction,
      useBrowser: t.useBrowser,
      thisConversation: t.conversationId === conversationId,
      ...(t.note ? { note: t.note } : {}),
    }));
  },
};

export const cancelScheduledTaskTool: ToolDefinition = {
  name: "cancel_scheduled_task",
  category: "schedule",
  description: "Cancel a pending scheduled task by its id (get ids from list_scheduled_tasks).",
  parameters: {
    type: "object",
    properties: { id: { type: "string", description: "Scheduled task id." } },
    required: ["id"],
  },
  async execute(args: { id?: string }, ctx?: ToolContext) {
    const { ownerId } = requireContext(ctx);
    const id = String(args.id ?? "");
    const task = await updateSchedule(ownerId, id, (t) =>
      t.status === "pending" ? { ...t, status: "cancelled", finishedAt: new Date().toISOString(), note: "모델이 취소함" } : null,
    );
    if (!task) throw new Error("취소할 수 있는(대기 중인) 예약을 찾지 못했습니다.");
    return { cancelled: true, id: task.id, runAtKst: formatKst(new Date(task.runAt)) };
  },
};

export const SCHEDULE_TOOLS: ToolDefinition[] = [scheduleTaskTool, listScheduledTasksTool, cancelScheduledTaskTool];
