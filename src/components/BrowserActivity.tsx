import { useEffect, useState } from "react";
import type { ToolCall } from "../api/types";
import { sendBrowserCommand } from "../browser/extension";
import { useBrowserShots } from "../browser/shots";
import { AttachmentPreview } from "./AttachmentPreview";
import { showToast } from "./Toast";
import "./BrowserActivity.css";

/**
 * 모델이 크롬에서 보고 있는 화면. 동작마다 확장이 찍어 보낸 화면을 크게 하나, 지나온
 * 단계를 작은 그림으로 줄지어 보여 준다. 읽은 화면에는 모델이 본 조작 요소의 번호표가,
 * 누르거나 입력한 화면에는 그 대상의 강조 상자가 찍혀 있다.
 *
 * 새 화면이 오면 따라간다. 사용자가 지난 단계를 고르면 거기 머문다.
 */
export function BrowserActivity({ toolCalls, live }: { toolCalls: ToolCall[] | undefined; live: boolean }) {
  const ids = (toolCalls ?? []).filter((call) => call.name.startsWith("browser_")).map((call) => call.id);
  const shots = useBrowserShots(ids);
  const [picked, setPicked] = useState<string | null>(null);
  const [enlarged, setEnlarged] = useState(false);
  // 새 화면이 들어오면 고른 것을 풀어 최신을 따라가게 한다 — 진행 중일 때만.
  const latestKey = shots[shots.length - 1]?.key;
  useEffect(() => {
    if (live) setPicked(null);
  }, [latestKey, live]);

  if (shots.length === 0) return null;
  const index = Math.max(0, picked ? shots.findIndex((s) => s.key === picked) : shots.length - 1);
  const current = shots[index] ?? shots[shots.length - 1]!;

  return (
    <section className="browser-activity" aria-label="모델이 보고 있는 크롬 화면">
      <header className="browser-activity-head">
        <span className={`browser-activity-dot${live ? " live" : ""}`} aria-hidden="true" />
        <span className="browser-activity-caption">
          {live && index === shots.length - 1 ? "지금 보는 화면" : `${index + 1}단계`} · {current.caption}
        </span>
        <span className="browser-activity-count">
          {index + 1} / {shots.length}
        </span>
        {live && (
          <button
            type="button"
            className="browser-activity-focus"
            onClick={() =>
              void sendBrowserCommand({ name: "focus_agent_window", args: {} }).then((r) => {
                if ("ok" in r && !r.ok) showToast(r.error);
              })
            }
          >
            작업 창 보기
          </button>
        )}
      </header>
      <figure className="browser-activity-frame">
        {/* 작업 창이 넓으면 번호표가 작게 보인다 — 누르면 원래 크기로. */}
        <button type="button" className="browser-activity-zoom" data-tooltip="크게 보기" onClick={() => setEnlarged(true)}>
          <img src={current.image} alt={`${current.title} — ${current.caption}`} />
        </button>
        <figcaption title={current.url}>{current.title || current.url}</figcaption>
      </figure>
      {shots.length > 1 && (
        <ol className="browser-activity-strip">
          {shots.map((shot, i) => (
            <li key={shot.key}>
              <button
                type="button"
                className={i === index ? "active" : undefined}
                aria-label={`${i + 1}단계 — ${shot.caption}`}
                aria-current={i === index ? "step" : undefined}
                data-tooltip={shot.caption}
                onClick={() => setPicked(shot.key)}
              >
                <img src={shot.image} alt="" />
                <span>{i + 1}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
      {enlarged && (
        <AttachmentPreview
          target={{ kind: "image", name: `${index + 1}단계 · ${current.caption}`, src: current.image }}
          onClose={() => setEnlarged(false)}
        />
      )}
    </section>
  );
}
