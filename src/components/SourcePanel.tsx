import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { apiPath } from "../api/base";
import type { CitationSource } from "../state/citations";
import { findPassage, type Range } from "../state/highlightMatch";
import { pdfCache, textCache, type TextLoad } from "../state/sourceCache";
import { closeSource, useOpenSource } from "../state/sourcePanel";
import { pushOverlay } from "../ui/overlayStack";
import { CloseIcon } from "./icons";
import "./SourcePanel.css";

/**
 * 답변 속 출처 "[n]" 을 누르면 오른쪽에서 밀려 나오는 창.
 *
 * 언제나 **원본 문서**에서 인용된 자리를 노란 형광펜처럼 칠한다.
 *
 *   - PDF 로 올린 문서: 그 PDF 를 그대로 띄운다(/file).
 *   - 텍스트 파일(.txt·.md·.csv…): 올린 그대로의 글을 띄운다(/original). 단락은 색인용으로
 *     다듬은 글이라 글자 그대로는 안 맞을 수 있어 findPassage 로 찾는다.
 *   - 원본을 보관하기 전에 올린 문서: 색인용으로 다듬은 글(/text)로 물러서고 그렇다고 적는다.
 *   - 이 앱에 원문이 없는 문서(엔진에 바로 넣은 시드 코퍼스): 검색 색인에서 청크를 이어
 *     다시 엮은 글(/sources)을 띄운다. 여기서는 단락의 순번을 알므로 글자 맞추기 없이 칠한다.
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
                <CloseIcon />
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
  /** note: 원본이 아니라 다른 것을 보여 줄 때 그 사실을 한 줄로 알린다. */
  | { kind: "text"; text: string; note?: string; ranges?: Range[] }
  | { kind: "missing" };

/** /sources 응답. server/rag/engineSource.ts 의 RebuiltSource. */
interface RebuiltSource {
  text: string;
  chunks: Array<{ ord: number; start: number; end: number }>;
  truncated: boolean;
}

/** 오류 응답의 code. 문서가 아예 없는 것(not_found)과 원본만 없는 것(no_source)을 가른다. */
async function errorCode(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { code?: unknown };
    return typeof body.code === "string" ? body.code : "";
  } catch {
    return "";
  }
}

/** 붙잡아 둔 글 응답을 이 단락의 화면으로. 다시 엮은 글은 순번으로 자리를 안다. */
function textView(load: TextLoad, source: CitationSource): View {
  if (load.kind === "text") return { kind: "text", text: load.text, note: load.note };
  const cited = load.chunks.find((c) => c.ord === source.ord);
  return { kind: "text", text: load.text, note: load.note, ...(cited ? { ranges: [{ start: cited.start, end: cited.end }] } : {}) };
}

/** 이미 불러온 문서면 기다릴 것 없이 그릴 화면. PDF 의 쪽 번호는 붙인 뒤(show)에 정해진다. */
function cachedView(source: CitationSource): View | null {
  const pdf = pdfCache.peek(source.documentId);
  if (pdf) return { kind: "pdf", found: false, page: 0, pages: pdf.pages };
  const load = textCache.peek(source.documentId);
  return load ? textView(load, source) : null;
}

function SourceBody({ source }: { source: CitationSource }) {
  const [view, setView] = useState<View>(() => cachedView(source) ?? { kind: "loading" });
  const pdfSlot = useRef<HTMLDivElement>(null);

  // 레이아웃 effect: 붙잡아 둔 PDF 는 화면에 그려지기 전에 제자리에 붙고 강조까지 끝낸다 —
  // 빈 칸이나 "불러오는 중" 이 한 번도 비치지 않는다.
  useLayoutEffect(() => {
    const documentId = source.documentId;
    const cachedPdf = pdfCache.get(documentId);
    if (cachedPdf) {
      cachedPdf.attach(pdfSlot.current!);
      setView({ kind: "pdf", ...cachedPdf.show(source.text) });
      return;
    }
    if (textCache.get(documentId)) return;

    const controller = new AbortController();
    const { signal } = controller;
    const base = apiPath(`/documents/${encodeURIComponent(documentId)}`);
    const get = (url: string) => fetch(url, { credentials: "include", signal });
    const show = (next: View) => {
      if (!signal.aborted) setView(next);
    };
    const keep = (load: TextLoad) => {
      textCache.set(documentId, load);
      show(textView(load, source));
    };
    (async () => {
      const file = await get(`${base}/file`);
      if (file.ok) {
        const data = await file.arrayBuffer();
        const slot = pdfSlot.current;
        if (!slot || signal.aborted) return;
        setView({ kind: "pdf", found: false, page: 0, pages: 0 });
        const { loadPdf } = await import("./sourcePdf");
        const pdf = await loadPdf(slot, data, signal);
        if (!pdf) return;
        // 다 불러온 뒤에 다른 출처로 넘어갔어도 남겨 둔다 — 돌아오면 바로 열린다.
        pdfCache.set(documentId, pdf);
        if (!signal.aborted) show({ kind: "pdf", ...pdf.show(source.text) });
        return;
      }
      // 이 앱의 문서 저장소에 있는 문서(내 것이거나 공개된 것)만 아래 두 길을 탄다.
      // 없거나 볼 수 없는 문서는 곧장 검색 색인으로 간다 — 묻는 횟수를 줄인다.
      if ((await errorCode(file)) !== "not_found") {
        const original = await get(`${base}/original`);
        // 줄 끝만 맞춘다: pre-wrap 은 CRLF 의 \r 도 줄바꿈으로 그려 윈도에서 만든 파일이 두 줄씩 벌어진다.
        if (original.ok) return keep({ kind: "text", text: (await original.text()).replace(/\r\n?/g, "\n") });
        const reason = await errorCode(original);
        const text = await get(`${base}/text`);
        if (text.ok) {
          const note =
            reason === "source_restricted"
              ? "원본 파일의 다른 부분이 공개되어 있지 않아, 이 부분을 색인용으로 정리한 본문을 보여 드립니다."
              : "원본 파일을 보관하기 전에 올린 문서라, 색인용으로 정리한 본문을 보여 드립니다.";
          return keep({ kind: "text", text: await text.text(), note });
        }
      }
      // 이 앱에 원문이 없는 문서: 검색 색인에서 다시 엮는다. 권한은 서버가 내 계정으로 건다.
      const rebuilt = await get(apiPath(`/sources/${encodeURIComponent(documentId)}`));
      if (rebuilt.ok) {
        const body = (await rebuilt.json()) as RebuiltSource;
        const note = body.truncated
          ? "검색 색인에서 단락을 이어 다시 엮은 문서입니다. 길어서 앞부분만 가져왔습니다."
          : "검색 색인에서 단락을 이어 다시 엮은 문서입니다. 줄바꿈은 원본과 다를 수 있습니다.";
        return keep({ kind: "rebuilt", text: body.text, note, chunks: body.chunks });
      }
      // 못 연 것은 남기지 않는다 — 잠깐의 오류일 수 있어 다음에 다시 물어본다.
      show({ kind: "missing" });
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
      {/* PDF 의 스크롤 칸(sourcePdf.ts)이 이 자리에 붙는다. 한 번 그린 칸은 캐시에 남아 다음에 그대로 옮겨 붙는다.
          다른 모양일 때는 비어 있어 공간을 차지하지 않는다. */}
      <div ref={pdfSlot} className={`source-pdf-slot${view.kind === "pdf" ? "" : " empty"}`} />
      {view.kind === "text" && view.note && <p className="source-panel-note">{view.note}</p>}
      {view.kind === "text" && <SourceText text={view.text} passage={source.text} known={view.ranges} />}
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

/** `known` 은 자리를 이미 아는 경우(색인에서 엮은 문서의 순번)다. 없으면 글자로 찾는다. */
function SourceText({ text, passage, known }: { text: string; passage: string; known?: Range[] }) {
  const ranges = useMemo(() => known ?? findPassage(text, passage), [known, text, passage]);
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
