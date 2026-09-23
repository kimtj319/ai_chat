import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CitationSource } from "../state/citations";
import { findPassage } from "../state/highlightMatch";
import { closeSource, useOpenSource } from "../state/sourcePanel";
import { pushOverlay } from "../ui/overlayStack";
import "./SourcePanel.css";

/**
 * 답변 속 출처 "[n]" 을 누르면 오른쪽에서 밀려 나오는 창.
 *
 * PDF 로 올린 문서는 그 PDF 를 그대로 띄우고, 인용된 단락을 노란 형광펜처럼
 * 칠한다. PDF 가 아닌 문서, 또는 원본을 보관하기 전에 올린 PDF 는 색인한 원문
 * 텍스트를 보여 주고 같은 자리를 칠한다.
 *
 * 창이 열리면 앱 레이아웃이 본문을 왼쪽(사이드바 바로 옆)으로 붙인다 — App.css 의
 * `[data-source-open]` 규칙.
 */
export function SourcePanel() {
  const source = useOpenSource();
  // 닫히는 동안에도 내용이 남아 있어야 미끄러져 나가는 모습이 보인다.
  const [shown, setShown] = useState<CitationSource | null>(source);
  useEffect(() => {
    if (source) setShown(source);
  }, [source]);
  const open = source !== null;

  useEffect(() => {
    if (!open) return;
    const release = pushOverlay();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") closeSource();
    }
    window.addEventListener("keydown", onKey);
    return () => {
      release();
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <aside className={`source-panel${open ? " open" : ""}`} aria-hidden={!open} aria-label="출처 원문">
      <div className="source-panel-inner">
        {shown && (
          <>
            <header className="source-panel-header">
              <span className="source-panel-n">{shown.n}</span>
              <h2 className="source-panel-title" title={shown.title}>
                {shown.title || "출처"}
              </h2>
              <button
                type="button"
                className="btn-icon source-panel-close"
                aria-label="출처 닫기"
                data-tooltip="닫기"
                tabIndex={open ? 0 : -1}
                onClick={closeSource}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </header>
            <SourceBody key={`${shown.documentId}:${shown.chunkId}`} source={shown} />
          </>
        )}
      </div>
    </aside>
  );
}

type View =
  | { kind: "loading" }
  | { kind: "pdf"; found: boolean; page: number; pages: number }
  | { kind: "text"; text: string }
  | { kind: "missing" };

function SourceBody({ source }: { source: CitationSource }) {
  const [view, setView] = useState<View>({ kind: "loading" });
  const pdfHost = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const base = `/api/documents/${encodeURIComponent(source.documentId)}`;
    (async () => {
      const file = await fetch(`${base}/file`, { credentials: "include", signal });
      if (file.ok) {
        const data = await file.arrayBuffer();
        const host = pdfHost.current;
        if (!host || signal.aborted) return;
        setView({ kind: "pdf", found: false, page: 0, pages: 0 });
        const { renderPdf } = await import("./sourcePdf");
        const result = await renderPdf(host, data, source.text, signal);
        if (!signal.aborted) setView({ kind: "pdf", ...result });
        return;
      }
      // PDF 원본이 없는 문서: 색인한 원문 텍스트로 보여 준다.
      const text = await fetch(`${base}/text`, { credentials: "include", signal });
      if (text.ok) {
        const body = await text.text();
        if (!signal.aborted) setView({ kind: "text", text: body });
        return;
      }
      if (!signal.aborted) setView({ kind: "missing" });
    })().catch((err: unknown) => {
      if (signal.aborted) return;
      console.warn("[source] could not open the source:", err);
      setView({ kind: "missing" });
    });
    return () => controller.abort();
  }, [source]);

  return (
    <div className="source-panel-body">
      {view.kind === "loading" && <p className="source-panel-note">원문을 불러오는 중…</p>}
      {view.kind === "pdf" && view.pages > 0 && (
        <p className="source-panel-note">
          {view.found ? `${view.page}쪽 · 전체 ${view.pages}쪽` : `이 단락의 위치를 PDF 에서 찾지 못했습니다 · 전체 ${view.pages}쪽`}
        </p>
      )}
      {view.kind === "pdf" && view.pages === 0 && <p className="source-panel-note">PDF 를 그리는 중…</p>}
      {/* PDF 는 이 칸에 그려진다. 다른 모양일 때는 비어 있어 공간을 차지하지 않는다. */}
      <div ref={pdfHost} className={`source-pdf${view.kind === "pdf" ? "" : " empty"}`} />
      {view.kind === "text" && <SourceText text={view.text} passage={source.text} />}
      {view.kind === "missing" && (
        <>
          <p className="source-panel-note">문서를 열 수 없습니다. 지워졌거나 볼 수 없는 문서입니다. 검색된 단락만 보여 드립니다.</p>
          <div className="source-text">
            <mark className="source-hl">{source.text}</mark>
          </div>
        </>
      )}
    </div>
  );
}

function SourceText({ text, passage }: { text: string; passage: string }) {
  const ranges = useMemo(() => findPassage(text, passage), [text, passage]);
  const scroller = useRef<HTMLDivElement>(null);
  const firstMark = useRef<HTMLElement>(null);

  useEffect(() => {
    const box = scroller.current;
    const mark = firstMark.current;
    if (!box || !mark) return;
    box.scrollTop = mark.offsetTop - box.clientHeight / 3;
  }, [ranges]);

  const parts: ReactNode[] = [];
  let at = 0;
  ranges.forEach((r, i) => {
    if (r.start > at) parts.push(text.slice(at, r.start));
    parts.push(
      <mark key={i} ref={i === 0 ? firstMark : undefined} className="source-hl">
        {text.slice(r.start, r.end)}
      </mark>,
    );
    at = r.end;
  });
  if (at < text.length) parts.push(text.slice(at));

  return (
    <>
      {ranges.length === 0 && <p className="source-panel-note">원문에서 이 단락의 위치를 찾지 못했습니다.</p>}
      <div ref={scroller} className="source-text">
        {parts}
      </div>
    </>
  );
}
