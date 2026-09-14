import { useEffect, useState } from "react";
import * as api from "../api/client";
import type { DocumentChunk, RagDocument } from "../api/types";
import { Modal } from "./Modal";
import "./DocumentViewer.css";

/**
 * 올린 문서를 열어 보는 창.
 *
 * 두 가지를 보여 준다. **원문**은 내가 올린 그 글이고, **청크**는 검색이 실제로
 * 다루는 조각이다. 둘을 같이 두는 이유는 하나다 — 경계를 모델이 고를 수 있게
 * 되면서 "어떻게 잘렸는가"가 문서마다 달라졌고, 그건 눈으로 봐야 알 수 있다.
 *
 * 청크는 다시 자르지 않고 색인할 때 저장해 둔 것을 읽는다. 다시 자르면 모델이
 * 그때 고른 경계와 다른 결과가 나오므로, 화면이 엔진에 없는 것을 보여 주게 된다.
 */

interface Props {
  document: RagDocument;
  onClose: () => void;
}

type Tab = "text" | "chunks";

export function DocumentViewer({ document, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("text");
  const [text, setText] = useState<string | null>(null);
  const [chunks, setChunks] = useState<DocumentChunk[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setText(null);
    setChunks(null);
    setError(null);
    void (async () => {
      try {
        const [t, c] = await Promise.all([api.fetchDocumentText(document.id), api.fetchDocumentChunks(document.id)]);
        if (!alive) return;
        setText(t);
        setChunks(c.chunks);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, [document.id]);

  const loading = text === null && error === null;

  return (
    <Modal title={document.name} onClose={onClose} size="wide">
      <div className="docview">
        <div className="docview-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "text"}
            className={`docview-tab${tab === "text" ? " selected" : ""}`}
            onClick={() => setTab("text")}
          >
            원문
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "chunks"}
            className={`docview-tab${tab === "chunks" ? " selected" : ""}`}
            onClick={() => setTab("chunks")}
          >
            청크 {chunks ? chunks.length : document.chunks}개
          </button>
          <span className="docview-note">
            {document.chunkedBy === "llm" ? "모델이 경계를 고름" : "규칙으로 자름"} ·{" "}
            {document.chars.toLocaleString("ko-KR")}자
          </span>
        </div>

        {error && (
          <p className="docview-error" role="alert">
            {error}
          </p>
        )}
        {loading && <p className="docview-loading">불러오는 중…</p>}

        {!loading && !error && tab === "text" && <pre className="docview-text">{text}</pre>}

        {!loading && !error && tab === "chunks" && (
          chunks && chunks.length > 0 ? (
            <ol className="docview-chunks">
              {chunks.map((chunk, i) => (
                <li key={i} className="docview-chunk">
                  <div className="docview-chunk-head">
                    <span className="docview-chunk-no">{i + 1}</span>
                    <span className="docview-chunk-len">{chunk.text.length}자</span>
                    {chunk.overlapLen > 0 && (
                      <span className="docview-chunk-len">앞에서 이어진 {chunk.overlapLen}자 포함</span>
                    )}
                  </div>
                  {/* 이월된 머리와 이 청크가 새로 담당하는 부분을 갈라 놓는다.
                      한 덩어리로 보여 주면 경계마다 같은 문장이 두 번 찍힌
                      것처럼 읽히는데, 그건 겹침이 일하고 있다는 뜻이다. */}
                  <pre className="docview-chunk-body">
                    {chunk.overlapLen > 0 && <span className="docview-carry">{chunk.text.slice(0, chunk.overlapLen)}</span>}
                    {chunk.text.slice(chunk.overlapLen)}
                  </pre>
                </li>
              ))}
            </ol>
          ) : (
            <p className="docview-loading">
              저장된 청크가 없습니다. 청크를 보관하기 전에 색인된 문서이거나 색인에 실패한 문서입니다 — “다시 색인”을
              누르면 생깁니다.
            </p>
          )
        )}
      </div>
    </Modal>
  );
}
