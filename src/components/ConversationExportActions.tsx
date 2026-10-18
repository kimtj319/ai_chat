import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { getShareToken, saveShare } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import type { ChatMessage } from "../api/types";
import { useDismiss } from "../hooks/useDismiss";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { usePopoverFocus } from "../hooks/usePopoverFocus";
import { shareHash } from "../routes";
import { copyText } from "../state/clipboard";
import { conversationTokenTotals } from "../state/conversationOps";
import { conversationHistoryFile, downloadJson } from "../state/exportImport";
import { exportConversationPdf } from "../state/pdfExport";
import type { ActiveConversation } from "../state/StoreContext";
import type { ClientChatMessage } from "../state/types";
import { BoardIcon, DownloadIcon } from "./icons";
import { inSheet } from "./popoverSheet";
import { showErrorToast, showToast } from "./Toast";

/* 공유: 위로 나가는 화살표가 달린 상자 — iOS·Gemini 의 공유 단추와 같은 실루엣이라
   따로 설명하지 않아도 알아본다. 다운로드(아래로 내려오는 화살표)와 방향이 반대다. */
function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 15V3" />
      <path d="M7.5 7.5 12 3l4.5 4.5" />
      <path d="M8 11H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-2" />
    </svg>
  );
}

/* 가로 점 셋 — 폰에서 자리가 모자라 접어 둔 단추들을 여는 "더 보기". */
function MoreIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
      <circle cx="5.5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="18.5" cy="12" r="1.6" />
    </svg>
  );
}

/** 공유 토큰. 128비트(22자 base64url) — 서버 storage/shareStore.ts 의 최소 길이. */
function newShareToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 공유 링크. 서버가 shareBaseUrl 을 주면(AI Product 구성원이 아닌 계정) 서버의 실제
 * 주소로, 아니면 지금 주소에서 해시만 바꿔 만든다 — 앱이 하위 경로·다른 도메인에
 * 있어도 맞다.
 */
function shareLink(token: string, shareBaseUrl?: string): string {
  const url = new URL(shareBaseUrl ? `${shareBaseUrl}/` : window.location.href);
  if (shareBaseUrl) url.search = "";
  url.hash = shareHash(token);
  return url.toString();
}

/** Drop client-only streaming fields before exporting a conversation to JSON.
 *  This destructures an explicit field list, so a new persisted field has to
 *  be named here or the export silently drops it. */
function toExportableMessage(message: ClientChatMessage): ChatMessage {
  const { id, role, content, attachments, reasoning, toolCalls, toolResults, usage, durationMs, error, contentPromotedFromReasoning, createdAt } =
    message;
  return { id, role, content, attachments, reasoning, toolCalls, toolResults, usage, durationMs, error, contentPromotedFromReasoning, createdAt };
}

interface ConversationExportActionsProps {
  conversation: ActiveConversation;
  /** The rendered transcript, captured as-is for the PDF. */
  transcriptRef: RefObject<HTMLDivElement | null>;
  /** The model that answers when the conversation's own `model` is "" (server default). */
  fallbackModel: string;
  /**
   * 있으면 폰 머리처럼 자리가 모자란 곳이다: 저장·공유·문의 게시판을 "더 보기"(⋯) 하나에
   * 접어 넣는다. 360px 에서 아이콘 묶음이 화면 밖으로 밀려 게시판 단추가 잘렸다.
   */
  collapsedBoard?: { onOpenBoard: () => void; onPrefetchBoard: () => void };
}

/** 대화 머리의 저장(JSON / PDF) 메뉴와 공유 링크 단추. 메시지가 있는 대화에만 그린다. */
export function ConversationExportActions({
  conversation: activeConversation,
  transcriptRef,
  fallbackModel,
  collapsedBoard,
}: ConversationExportActionsProps) {
  const totals = conversationTokenTotals(activeConversation.messages);
  const shareBaseUrl = useAuth().me?.shareBaseUrl;

  // 다운로드 형식 선택(JSON / PDF). 바깥을 누르거나 Esc 면 닫힌다.
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const downloadRef = useRef<HTMLDivElement>(null);
  const downloadMenuRef = useRef<HTMLDivElement>(null);
  const downloadTriggerRef = useRef<HTMLButtonElement>(null);
  // 폰에서는 바텀시트. 단추에 붙여 띄우면 화면 왼쪽 밖으로 잘리고, 머리의 유리 막 안이라
  // 뒤의 본문도 비쳤다(390px 실측).
  const sheet = useMediaQuery("(max-width: 640px)");
  // 열면 포커스가 첫 항목으로 들어가고 Esc 는 단추로 돌려준다(다른 머리 메뉴와 같은 약속).
  usePopoverFocus(downloadOpen, downloadMenuRef, downloadTriggerRef, () => setDownloadOpen(false));
  useDismiss(downloadOpen, downloadRef, () => setDownloadOpen(false), {
    ignore: (target) => downloadMenuRef.current?.contains(target) === true || target.closest?.(".popover-sheet-scrim") != null,
  });

  // 공유. 토큰은 미리 알아 둔다 — http 에서는 복사가 누른 그 순간에만 되므로(iOS Safari),
  // 누른 뒤에 서버에 물어 토큰을 받아서는 복사할 수 없다. 공유한 적이 없으면 누르는 순간
  // 새로 만들어 링크를 복사하고, 그 토큰으로 서버에 사본을 뜬다.
  const shareConversationId = activeConversation.id;
  const shareHasMessages = activeConversation.messages.length > 0;
  const [shareToken, setShareToken] = useState<{ conversationId: string; token: string | null } | null>(null);
  const [shareBusy, setShareBusy] = useState(false);
  useEffect(() => {
    if (!shareConversationId || !shareHasMessages) return;
    let cancelled = false;
    getShareToken(shareConversationId)
      .then((token) => {
        if (!cancelled) setShareToken({ conversationId: shareConversationId, token });
      })
      .catch(() => {
        // 모르면 누를 때 새로 만든다. 서버가 원래 토큰을 돌려주면 그것으로 다시 복사한다.
      });
    return () => {
      cancelled = true;
    };
  }, [shareConversationId, shareHasMessages]);

  function handleShare() {
    if (!shareConversationId || shareBusy) return;
    const known = shareToken?.conversationId === shareConversationId ? shareToken.token : null;
    const proposed = known ?? newShareToken();
    // 누른 순간에 복사한다(위 설명). copyText 는 http 에서 그 자리에서 바로 복사한다.
    const copied = copyText(shareLink(proposed, shareBaseUrl));
    setShareBusy(true);
    saveShare(shareConversationId, proposed)
      .then(async (token) => {
        setShareToken({ conversationId: shareConversationId, token });
        // 다른 창에서 먼저 공유해 서버의 토큰이 다르면, 그 링크로 다시 복사해 본다.
        const ok = token === proposed ? await copied : await copyText(shareLink(token, shareBaseUrl));
        if (ok) showToast("링크가 복사되었습니다");
        else showToast(`링크를 복사하지 못했습니다. 이 주소를 직접 복사하세요: ${shareLink(token, shareBaseUrl)}`, "error");
      })
      .catch(showErrorToast)
      .finally(() => setShareBusy(false));
  }

  // 항목 사이는 화살표로(SourcePicker 와 같은 규칙). 카드가 두 줄로 놓여도 순서대로 돈다.
  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      // 여기서 멈춘다: 열려 있는 출처 창과 생성 중단(Esc)도 window 에서 같은 키를 듣는다.
      event.stopPropagation();
      setDownloadOpen(false);
      downloadTriggerRef.current?.focus({ preventScroll: true });
      return;
    }
    const items = [...(downloadMenuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
    const backward = event.key === "ArrowUp" || event.key === "ArrowLeft";
    const next = forward
      ? (at + 1) % items.length
      : backward
        ? (at - 1 + items.length) % items.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : -1;
    if (next < 0) return;
    event.preventDefault();
    items[next]?.focus();
  }

  const collapsed = collapsedBoard !== undefined;
  return (
    <>
      <div className={`chat-download${collapsed ? " chat-download-more" : ""}`} ref={downloadRef}>
        <button
          ref={downloadTriggerRef}
          type="button"
          className="btn-icon"
          data-tooltip={collapsed ? "더 보기" : pdfBusy ? "PDF 만드는 중…" : "대화 기록 저장"}
          aria-label={collapsed ? "더 보기 — 저장·공유·문의 게시판" : "대화 기록 저장"}
          aria-haspopup="menu"
          aria-expanded={downloadOpen}
          disabled={pdfBusy && !collapsed}
          onClick={() => setDownloadOpen((open) => !open)}
        >
          {collapsed ? <MoreIcon /> : <DownloadIcon />}
        </button>
        {downloadOpen && inSheet(
          sheet,
          () => setDownloadOpen(false),
          <div
            ref={downloadMenuRef}
            className="chat-download-menu"
            role="menu"
            aria-label={collapsed ? "더 보기" : "저장 형식"}
            tabIndex={-1}
            onKeyDown={onMenuKeyDown}
          >
            <button
              type="button"
              role="menuitem"
              className="chat-download-option"
              onClick={() => {
                setDownloadOpen(false);
                downloadJson(
                  `${activeConversation.title}.json`,
                  conversationHistoryFile(
                    // "" on the record means "use the server default", which tells a
                    // reader of the file nothing. Name the model that actually
                    // answered — the same one the header shows.
                    { ...activeConversation, model: activeConversation.model || fallbackModel },
                    activeConversation.messages.map(toExportableMessage),
                  ),
                );
              }}
            >
              <span className="chat-download-format">JSON</span>
              <span className="chat-download-hint">대화 기록 데이터</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="chat-download-option"
              disabled={pdfBusy}
              onClick={() => {
                setDownloadOpen(false);
                const inner = transcriptRef.current;
                if (!inner) return;
                setPdfBusy(true);
                exportConversationPdf(inner, `${activeConversation.title}.pdf`)
                  .then(() => showToast("PDF 로 저장했습니다."))
                  .catch(showErrorToast)
                  .finally(() => setPdfBusy(false));
              }}
            >
              <span className="chat-download-format">PDF</span>
              <span className="chat-download-hint">{pdfBusy ? "만드는 중…" : "화면과 같은 모습"}</span>
            </button>
            {collapsedBoard && (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className="chat-download-option"
                  disabled={shareBusy}
                  onClick={() => {
                    setDownloadOpen(false);
                    handleShare();
                  }}
                >
                  <span className="chat-download-format">공유</span>
                  <span className="chat-download-hint">링크 복사</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="chat-download-option"
                  onFocus={collapsedBoard.onPrefetchBoard}
                  onPointerEnter={collapsedBoard.onPrefetchBoard}
                  onClick={() => {
                    setDownloadOpen(false);
                    collapsedBoard.onOpenBoard();
                  }}
                >
                  <span className="chat-download-format chat-download-format-icon">
                    <BoardIcon aria-hidden="true" />
                    문의 게시판
                  </span>
                  <span className="chat-download-hint">질문·요청 남기기</span>
                </button>
              </>
            )}
            {totals.totalTokens > 0 && (
              <p className="chat-download-usage">
                이 대화 합계 {totals.totalTokens.toLocaleString()} 토큰 (프롬프트 {totals.promptTokens.toLocaleString()} · 완성{" "}
                {totals.completionTokens.toLocaleString()})
              </p>
            )}
          </div>,
        )}
      </div>
      {/* 저장(다운로드) 바로 옆 — 둘 다 "이 대화를 밖으로 내보내는" 일이다. 접힌 머리에서는 ⋯ 안에 있다. */}
      {!collapsed && (
        <button
          type="button"
          className="btn-icon"
          data-tooltip="공유 링크 복사"
          aria-label="대화 공유 — 링크 복사"
          disabled={shareBusy}
          onClick={handleShare}
        >
          <ShareIcon />
        </button>
      )}
    </>
  );
}
