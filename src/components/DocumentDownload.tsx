import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ToolCall, ToolResult } from "../api/types";
import { documentFilename, documentsOf, documentTextBlob, type DocumentFormat, type GeneratedDocument } from "../state/documentExport";
import { MarkdownRenderer, preloadMarkdownMath } from "./MarkdownRenderer";
import { showErrorToast } from "./Toast";
import "./DocumentDownload.css";

/**
 * 모델이 create_document 로 정리한 문서를 받는 상자. 답변 아래에 문서마다 하나씩.
 *
 * 머리의 저장(대화 전체 PDF·JSON)과 다르다 — 주고받은 말이 아니라 모델이 문서로
 * 정리한 본문만 받는다. 파일은 누르는 순간 브라우저에서 만든다(server/tools/createDocument.ts).
 */
export function DocumentDownloads({ toolCalls, toolResults }: { toolCalls?: ToolCall[]; toolResults?: ToolResult[] }) {
  const docs = documentsOf(toolCalls, toolResults);
  if (docs.length === 0) return null;
  return (
    <div className="doc-downloads">
      {docs.map((doc) => (
        <DocumentCard key={doc.id} doc={doc} />
      ))}
    </div>
  );
}

const LABELS: Record<DocumentFormat, string> = { pdf: "PDF", md: "Markdown", txt: "TXT" };

function DocumentCard({ doc }: { doc: GeneratedDocument }) {
  const [busy, setBusy] = useState<DocumentFormat | null>(null);
  // 모델이 사용자가 원한다고 본 형식을 앞에, 나머지는 뒤에.
  const order: DocumentFormat[] = [doc.format, ...(["pdf", "md", "txt"] as const).filter((f) => f !== doc.format)];

  async function download(format: DocumentFormat) {
    if (busy) return;
    setBusy(format);
    try {
      if (format === "pdf") await saveDocumentPdf(doc);
      else saveBlob(documentTextBlob(doc, format), documentFilename(doc.title, format));
    } catch (err) {
      showErrorToast(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="doc-card" aria-label={`문서 ${doc.title}`}>
      <span className="doc-card-icon" aria-hidden="true">
        <DocIcon />
      </span>
      <div className="doc-card-text">
        <p className="doc-card-title">{doc.title}</p>
        <p className="doc-card-meta">정리한 문서 · {doc.content.length.toLocaleString()}자</p>
      </div>
      <div className="doc-card-actions">
        {order.map((format, i) => (
          <button
            key={format}
            type="button"
            className={`btn btn-sm ${i === 0 ? "btn-primary" : "btn-secondary"}`}
            disabled={busy !== null}
            onClick={() => void download(format)}
            aria-label={`${doc.title} ${LABELS[format]}로 받기`}
          >
            {i === 0 && <DownloadIcon />}
            {busy === format ? "만드는 중…" : LABELS[format]}
          </button>
        ))}
      </div>
    </section>
  );
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 클릭이 내려받기를 시작한 뒤에 놓는다 — 곧바로 놓으면 일부 브라우저가 빈 파일을 받는다.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * PDF 는 대화 저장과 같은 방식으로 만든다(state/pdfExport.ts): 화면 밖에 문서를
 * 그려 놓고 찍는다. 표·코드·수식이 화면과 같게 나오고 한글 글꼴을 따로 실을 필요가
 * 없다. 테마와 상관없이 흰 종이에 — `light-sheet` 아래에서는 라이트 색이 쓰인다.
 */
async function saveDocumentPdf(doc: GeneratedDocument): Promise<void> {
  const { exportConversationPdf } = await import("../state/pdfExport");
  const host = document.createElement("div");
  host.className = "light-sheet doc-pdf-sheet";
  host.setAttribute("aria-hidden", "true");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    // 본문이 제목으로 시작하지 않으면 제목을 붙인다 — 파일만 받은 사람이 무엇인지 알게.
    const content = /^\s*#\s/.test(doc.content) ? doc.content : `# ${doc.title}\n\n${doc.content}`;
    // 수식 렌더러는 따로 불러온다 — 그리기 전에 받아 두어야 50ms 안에 수식까지 그려진다.
    if (content.includes("$")) await preloadMarkdownMath();
    root.render(<MarkdownRenderer content={content} />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await document.fonts?.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const body = host.querySelector<HTMLElement>(".markdown-body");
    if (!body) throw new Error("문서를 그리지 못했습니다.");
    await exportConversationPdf(body, documentFilename(doc.title, "pdf"));
  } finally {
    root.unmount();
    host.remove();
  }
}

function DocIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6M9 17h4" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4v11" />
      <path d="M7 10l5 5 5-5" />
      <path d="M5 20h14" />
    </svg>
  );
}
