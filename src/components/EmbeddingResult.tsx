import { useState } from "react";
import type { MessageEmbedding, MessageUsage } from "../api/types";
import {
  dimensionsLabel,
  embeddingFilename,
  embeddingJson,
  formatCosine,
  formatVectorValue,
  previewVector,
} from "../state/embedding";
import { downloadJson } from "../state/exportImport";
import { CopyButton } from "./CopyButton";
import { shortModelName } from "./ModelSelector";
import "./EmbeddingResult.css";

function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v12" />
      <path d="M7 10l5 5 5-5" />
      <path d="M4 19.5h16" />
    </svg>
  );
}

interface EmbeddingResultProps {
  embedding: MessageEmbedding;
  usage?: MessageUsage;
}

/**
 * An embedding turn's answer, rendered as a result rather than as prose: 1024
 * floats in a chat bubble are unreadable and unusable. The cosine against the
 * previous embedding gets the headline, because comparing two texts is the
 * reason anyone computes an embedding in the first place; the full vector
 * stays behind the same collapse the thinking/tool panels use, and leaves via
 * copy or a JSON download at full precision.
 */
export function EmbeddingResult({ embedding, usage }: EmbeddingResultProps) {
  const [expanded, setExpanded] = useState(false);

  const preview = previewVector(embedding.vector);
  const cosine = formatCosine(embedding.cosineToPrevious);
  const json = embeddingJson(embedding);

  return (
    <div className="embedding-result">
      <div className="embedding-head">
        <span className="embedding-kind">임베딩 결과</span>
        <span className="embedding-dimensions">{dimensionsLabel(embedding)}</span>
        <span className="embedding-model" title={embedding.model}>
          {shortModelName(embedding.model)}
        </span>
      </div>

      {cosine !== null && (
        <div className="embedding-cosine">
          <span className="embedding-cosine-value">{cosine}</span>
          <span className="embedding-cosine-label">직전 임베딩과의 코사인 유사도</span>
        </div>
      )}

      <div className="embedding-preview">
        <span className="embedding-preview-label">앞부분 {preview.shown}개</span>
        <code className="embedding-preview-values">{preview.summary}</code>
      </div>

      <div className="embedding-meta">
        {usage && <span>프롬프트 {usage.promptTokens.toLocaleString()} 토큰</span>}
        {cosine === null && <span>이 대화의 첫 임베딩입니다 (비교 대상 없음)</span>}
      </div>

      <div className="embedding-actions">
        <button
          type="button"
          className="embedding-toggle"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          <span className={`embedding-caret${expanded ? " open" : ""}`}>
            <ChevronIcon />
          </span>
          <span>{expanded ? "전체 벡터 접기" : `전체 벡터 보기 (${preview.total.toLocaleString()}개)`}</span>
        </button>
        <div className="embedding-action-buttons">
          {/* Copy and download carry the raw values; only the on-screen
              rendering is rounded. */}
          <CopyButton text={json} label="벡터 JSON 복사" />
          <button
            type="button"
            className="btn-icon"
            data-tooltip="벡터 JSON 내려받기"
            aria-label="벡터 JSON 내려받기"
            onClick={() =>
              downloadJson(embeddingFilename(embedding), {
                model: embedding.model,
                dimensions: embedding.dimensions,
                cosineToPrevious: embedding.cosineToPrevious ?? null,
                vector: embedding.vector,
              })
            }
          >
            <DownloadIcon />
          </button>
        </div>
      </div>

      <div className={`embedding-collapse${expanded ? " expanded" : ""}`}>
        <div className="embedding-full">
          {/* Rendered only once opened: 1024 indexed cells are not worth
              building for a panel nobody has asked to see. */}
          {expanded &&
            embedding.vector.map((value, index) => (
              <span className="embedding-cell" key={index}>
                <span className="embedding-cell-index">{index}</span>
                <span className="embedding-cell-value">{formatVectorValue(value)}</span>
              </span>
            ))}
        </div>
      </div>
    </div>
  );
}
