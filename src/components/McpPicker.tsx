import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { inSheet } from "./popoverSheet";
import { useDismiss } from "../hooks/useDismiss";
import { useAuth } from "../auth/AuthContext";
import { useMcpLibrary } from "../hooks/useMcpLibrary";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { usePopoverFocus } from "../hooks/usePopoverFocus";
import { myLibrary, visibleLibrary } from "../mcp/rules";
import "./McpPicker.css";

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function PaperclipIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

interface McpPickerProps {
  onOpenLibrary: () => void;
  /** 도구 설정 페이지로. 없으면 아래쪽 링크에서 빠진다. */
  onOpenTools?: () => void;
  /** 있으면 맨 위에 "파일 올리기" 줄을 둔다(입력창의 클립 단추를 대신한다). */
  onAttach?: () => void;
  /** 서버 목록 아래에 붙는 줄(크롬 제어). */
  extraRows?: ReactNode;
}

/**
 * The composer's plus button — Gemini-style, the one place the composer's
 * add-ons live: uploading a file on top, the connectors that are on, the Chrome
 * control below them, links to the management pages at the foot. Before, each
 * of those was its own icon on the composer's right, which is what made the
 * input row read as crowded.
 *
 * The connector list is read-only. Whether a server's tools reach the model is
 * decided by its switch in 커넥터 and nothing else (server/chat/turnTools.ts):
 * this menu used to hold a second, per-conversation checklist, and a server
 * switched on in 커넥터 did nothing until its tools were also ticked here.
 */
export function McpPicker({ onOpenLibrary, onOpenTools, onAttach, extraRows }: McpPickerProps) {
  const { me } = useAuth();
  const { servers, adopted, hidden, loading, unavailable } = useMcpLibrary();
  const [open, setOpen] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  // 폰에서는 입력창 위의 팝오버가 아니라 화면 아래에서 올라오는 시트다(App.css).
  // 입력창에 backdrop-filter 가 걸려 있어 그 안의 position: fixed 는 화면이 아니라
  // 입력창에 붙는다 — 그래서 시트는 body 로 포털한다.
  const sheet = useMediaQuery("(max-width: 640px)");
  usePopoverFocus(open, popoverRef, triggerRef, () => setOpen(false));

  useDismiss(open, containerRef, () => setOpen(false), {
    // A dialog opened from inside the menu (the Chrome setup guide) is
    // portalled to <body>; a click in it is not a click away from the menu.
    // The menu itself is a dialog too, and so is the sheet on a phone, which
    // sits outside the container. The sheet's scrim closes on its own click:
    // closing on mousedown would hand the tap's click to whatever lies under it.
    ignore: (target) => target.closest?.('[role="dialog"], .popover-sheet-scrim') != null,
  });

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowUp" && !open) {
      event.preventDefault();
      setOpen(true);
    }
  }

  // The exact same rule the server applies before handing tools to the model
  // (server/mcp/ownerPrefs.ts effectiveServers): what is listed here is what
  // the model gets.
  const mine = visibleLibrary(servers, adopted, hidden, me?.id ?? "");
  // Membership without the switch, only to tell "라이브러리가 비어 있다" apart
  // from "라이브러리는 있지만 전부 꺼져 있다" — the two need different guidance.
  const hasLibrary = myLibrary(servers, adopted, me?.id ?? "").length > 0;

  return (
    <div className="mcp-picker" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="btn-icon mcp-picker-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-tooltip="도구와 파일"
        aria-label="도구와 파일"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={handleTriggerKeyDown}
      >
        <PlusIcon />
      </button>

      {open && inSheet(
        sheet,
        () => setOpen(false),
        <div ref={popoverRef} className="mcp-picker-popover" role="dialog" aria-label="도구와 파일" tabIndex={-1}>
          {onAttach && (
            <>
              <button
                type="button"
                className="mcp-picker-action"
                onClick={() => {
                  setOpen(false);
                  onAttach();
                }}
              >
                <PaperclipIcon />
                <span className="mcp-picker-action-text">
                  <span className="mcp-picker-action-name">파일 올리기</span>
                  <span className="mcp-picker-action-hint">끌어 놓거나 붙여 넣어도 됩니다</span>
                </span>
              </button>
              <div className="mcp-picker-divider" role="presentation" />
            </>
          )}
          <div className="mcp-picker-head">
            <p className="mcp-picker-title">켜 둔 커넥터</p>
          </div>
          <p className="mcp-picker-hint">커넥터에서 켠 서버는 모든 대화에서 모델이 필요할 때 알아서 씁니다.</p>

          <div className="mcp-picker-list">
            {loading ? (
              <p className="mcp-picker-empty">불러오는 중…</p>
            ) : unavailable ? (
              <p className="mcp-picker-empty">이 서버에는 아직 MCP 기능이 배포되지 않았습니다.</p>
            ) : mine.length === 0 && !hasLibrary ? (
              <p className="mcp-picker-empty">내 커넥터가 비어 있습니다. 커넥터에서 MCP 서버를 추가해 보세요.</p>
            ) : mine.length === 0 ? (
              <div className="mcp-picker-empty">
                <p>켜 둔 커넥터가 없습니다. 쓸 MCP 서버를 커넥터에서 켜 주세요.</p>
                <button
                  type="button"
                  className="mcp-picker-link"
                  onClick={() => {
                    setOpen(false);
                    onOpenLibrary();
                  }}
                >
                  커넥터 열기
                </button>
              </div>
            ) : (
              <ul className="mcp-picker-connectors">
                {mine.map((server) => (
                  <li key={server.id} className="mcp-picker-connector" title={server.description || undefined}>
                    <span className="mcp-picker-server-name">{server.name}</span>
                    <span className="mcp-picker-server-count" aria-label={`도구 ${server.tools.length}개`}>
                      {server.tools.length}
                    </span>
                    {server.requiresCredential && !server.hasCredential && (
                      <span className="mcp-picker-note">자격 증명 필요</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {extraRows && (
            <>
              <div className="mcp-picker-divider" role="presentation" />
              {extraRows}
            </>
          )}

          <div className="mcp-picker-divider" role="presentation" />
          <div className="mcp-picker-links">
            {onOpenTools && (
              <>
                <button
                  type="button"
                  className="mcp-picker-link"
                  onClick={() => {
                    setOpen(false);
                    onOpenTools();
                  }}
                >
                  도구 설정
                </button>
                <span aria-hidden="true">·</span>
              </>
            )}
            <button
              type="button"
              className="mcp-picker-link"
              onClick={() => {
                setOpen(false);
                onOpenLibrary();
              }}
            >
              커넥터 관리
            </button>
          </div>
        </div>,
      )}
    </div>
  );
}
