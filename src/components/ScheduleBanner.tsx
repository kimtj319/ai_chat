import { cancelSchedule } from "../api/client";
import { refreshSchedules, useSchedules } from "../browser/scheduler";
import { showErrorToast, showToast } from "./Toast";
import "./ScheduleBanner.css";

function clock(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
  return sameDay ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

/**
 * 이 대화에 걸린 예약. 입력창 바로 위에 한 줄씩 — 무엇이 언제 실행될지 늘 보이고,
 * 거기서 바로 취소할 수 있다.
 */
export function ScheduleBanner({ conversationId }: { conversationId: string }) {
  const tasks = useSchedules().filter(
    (t) => t.conversationId === conversationId && (t.status === "pending" || t.status === "running"),
  );
  if (tasks.length === 0) return null;
  return (
    <ul className="schedule-banner" aria-label="이 대화의 예약 작업">
      {tasks.map((task) => (
        <li key={task.id} data-status={task.status}>
          <span className="schedule-banner-time">{task.status === "running" ? "실행 중" : clock(task.runAt)}</span>
          <span className="schedule-banner-kind">{task.useBrowser ? "크롬" : "서버"}</span>
          <span className="schedule-banner-text" title={task.instruction}>
            {task.instruction}
          </span>
          {task.status === "pending" && (
            <button
              type="button"
              className="schedule-banner-cancel"
              onClick={() =>
                void cancelSchedule(task.id)
                  .then(() => showToast("예약을 취소했습니다."))
                  .catch(showErrorToast)
                  .finally(() => void refreshSchedules())
              }
            >
              취소
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
