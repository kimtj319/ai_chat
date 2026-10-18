import type React from "react";
import { useDeferredValue, type TextareaHTMLAttributes } from "react";
import type { BoardPostStatus } from "../api/types";
import { hueOf } from "../state/boardFormat";
import { MarkdownRenderer } from "./MarkdownRenderer";

/* 문의 게시판의 목록·글·새 글 쓰기가 같이 쓰는 조각들. */

/** 화면에서도 막아 둔다. 서버가 잘라 내기 전에 사람이 먼저 알아야 한다. */
export const MAX_TITLE_CHARS = 120;
export const MAX_BODY_CHARS = 20_000;
export const MAX_TAGS = 8;

/** 계정 이름이 있으면 이름, 없으면 id — 없는 이름을 지어내지 않는다. */
export function nameOf(name: string | null, id: string): string {
  return name || id;
}

export const ref = (n: number | undefined) => (n ? `#${n}` : "");

/** 여러 줄 입력에서의 제출. Enter 는 줄바꿈으로 남겨 둬야 하므로 수식키를 쓴다. */
export function isSubmitChord(e: { key: string; ctrlKey: boolean; metaKey: boolean }): boolean {
  return e.key === "Enter" && (e.ctrlKey || e.metaKey);
}

/**
 * 마크다운 입력칸과 그 결과를 한 상자에. GitLab 은 작성·미리보기 탭을 오가야
 * 결과가 보이지만 여기서는 치는 대로 바로 그려진다 — 표나 코드 블록이 제대로
 * 닫혔는지 올리기 전에 안다. 넓으면 나란히, 좁으면 입력칸 아래에 놓인다.
 *
 * 글과 답변을 그리는 것과 같은 MarkdownRenderer 를 쓰고, 서버가 하듯 앞뒤 공백을
 * 걷은 뒤에 그린다(앞에 공백 넷이면 코드 블록이 되지만 올리면 사라진다). 미리보기와
 * 올린 결과가 어긋나면 미리보기를 믿을 수 없다.
 *
 * 그리기는 useDeferredValue 로 한 박자 늦춘다. 긴 글에서 글자마다 다시 그리면
 * 입력이 끊기는데, 늦춘 값은 손이 쉬는 틈에 따라잡고 입력칸은 늘 바로 반응한다.
 */
export function MarkdownField({ value, ...textarea }: TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string }) {
  const shown = useDeferredValue(value).trim();
  return (
    <div className="board-md">
      <div className="board-md-split">
        <textarea {...textarea} value={value} />
        <section className="board-md-preview board-note-body" aria-label="미리보기">
          <span className="board-md-preview-label" aria-hidden="true">
            미리보기
          </span>
          {shown ? <MarkdownRenderer content={shown} /> : <p className="board-md-preview-empty">적는 대로 여기에 바로 보입니다.</p>}
        </section>
      </div>
    </div>
  );
}

export function Label({ name }: { name: string }) {
  return (
    <span className="board-label" style={{ "--label-hue": hueOf(name) } as React.CSSProperties}>
      {name}
    </span>
  );
}

/** GitLab 의 열림(빈 원 안의 점)·닫힘(체크) 아이콘. 색이 아닌 모양으로도 가른다. */
export function StatusIcon({ status }: { status: BoardPostStatus }) {
  return (
    <svg className="board-status-icon" data-status={status} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      {status === "open" ? (
        <>
          <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="8" cy="8" r="2" fill="currentColor" />
        </>
      ) : (
        <>
          <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M5.4 8.2l1.8 1.8 3.4-3.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
    </svg>
  );
}

export function CommentIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
    </svg>
  );
}

export function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5l3 3" />
    </svg>
  );
}

export function LinkIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <path d="M6.5 9.5l3-3" />
      <path d="M7 4.5l1-1a2.8 2.8 0 014 4l-1 1" />
      <path d="M9 11.5l-1 1a2.8 2.8 0 01-4-4l1-1" />
    </svg>
  );
}


export function ListBackIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}
