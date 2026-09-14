// Every user-visible attachment string lives here, so the composer, the chips
// and the drop overlay cannot drift apart.
//
// Two tones: a *refusal* (we know the file cannot work, nothing was uploaded)
// is a --warning, and one that names a workaround stays on screen until the
// next one replaces it — there is something to act on. A *failure* (something
// went wrong that may not repeat) is a --danger and clears itself after 6s.
//
// Every string with a variable uses the "라벨: {값}" form, which sidesteps
// 은/는 agreement on a filename we do not control.

import type { Classification, DocumentFormat } from "./classify";
import { formatTokens, MAX_ATTACHMENTS } from "./format";

export type NoticeTone = "warning" | "danger";

export interface NoticeSpec {
  tone: NoticeTone;
  text: string;
  /** Stays until replaced (it names a workaround) instead of auto-clearing. */
  sticky: boolean;
}

export const NOTICE_TIMEOUT_MS = 6000;

const DOCUMENT_NOTICE: Record<DocumentFormat, string> = {
  pdf: "PDF 문서는 아직 첨부할 수 없습니다. 필요한 페이지를 화면 캡처해 붙여넣으면 모델이 이미지로 읽습니다.",
  excel: "Excel 문서는 아직 첨부할 수 없습니다. CSV로 저장하면 그대로 첨부할 수 있습니다.",
  word: "Word 문서는 아직 첨부할 수 없습니다. 본문을 복사해 붙여넣거나, 화면을 캡처해 붙여넣으세요.",
  hwp: "한글 문서는 아직 첨부할 수 없습니다. 본문을 복사해 붙여넣거나, 화면을 캡처해 붙여넣으세요.",
  powerpoint:
    "PowerPoint 문서는 아직 첨부할 수 없습니다. 필요한 슬라이드를 화면 캡처해 붙여넣으면 모델이 이미지로 읽습니다.",
};

export function documentRefusal(format: DocumentFormat): NoticeSpec {
  return { tone: "warning", text: DOCUMENT_NOTICE[format], sticky: true };
}

export function unsupportedType(name: string): NoticeSpec {
  return { tone: "warning", text: `지원하지 않는 형식입니다: ${name}`, sticky: false };
}

/**
 * The byte ceiling. For an image it needs the extra sentence: the model server
 * stops charging an image at 16,386 tokens, so a 30MB photo is not a token
 * problem — it is an upload-size and latency problem, which is exactly why
 * there is a byte limit on top of the token limit.
 */
export function tooLarge(name: string, limit: string, kind?: "image" | "text"): NoticeSpec {
  const base = `파일이 너무 큽니다: ${name} (최대 ${limit})`;
  const text =
    kind === "image" ? `${base} 이미지 토큰은 16,386에서 멈추므로, 이 제한은 토큰이 아니라 전송 크기 문제입니다.` : base;
  return { tone: "warning", text, sticky: true };
}

export function undecodableText(name: string): NoticeSpec {
  return { tone: "warning", text: `텍스트를 읽을 수 없습니다: ${name} (텍스트 파일인지 확인하세요)`, sticky: true };
}

export function undecodableImage(name: string): NoticeSpec {
  return { tone: "warning", text: `이미지를 열 수 없습니다: ${name} (PNG 또는 JPEG로 변환해 보세요)`, sticky: true };
}

export function tooMany(max: number = MAX_ATTACHMENTS): NoticeSpec {
  return { tone: "warning", text: `한 번에 ${max}개까지 첨부할 수 있습니다.`, sticky: false };
}

export function uploadFailed(name: string): NoticeSpec {
  return { tone: "danger", text: `파일을 올리지 못했습니다: ${name}`, sticky: false };
}

export function submitBlocked(): NoticeSpec {
  return { tone: "danger", text: "업로드가 끝나지 않아 전송하지 못했습니다. 실패한 첨부를 확인하세요.", sticky: false };
}

/** One file alone costs more than a single message may carry. */
export function fileOverBudget(name: string, tokens: number, limit: number): NoticeSpec {
  return {
    tone: "warning",
    text: `이 파일 하나가 한 번에 보낼 수 있는 양을 넘습니다: ${name} (약 ${formatTokens(tokens)} 토큰, 최대 ${formatTokens(limit)})`,
    sticky: true,
  };
}

/** The draft as a whole is over the per-message budget: sending is blocked. */
export function draftOverBudget(tokens: number, limit: number): string {
  return `첨부가 한 번에 보낼 수 있는 양을 넘습니다. 약 ${formatTokens(tokens)} 토큰이며 최대는 ${formatTokens(limit)} 토큰입니다. 파일을 빼거나 나눠서 보내세요.`;
}

/** The image still exceeds the server's dimension cap after the downscale. */
export function imageTooLarge(name: string, width: number, height: number, maxWidth: number, maxHeight: number): NoticeSpec {
  return {
    tone: "warning",
    text: `이미지가 너무 큽니다: ${name} (${width}×${height}, 최대 ${maxWidth}×${maxHeight})`,
    sticky: true,
  };
}

/** The refusal copy for a classification that came back `ok: false`. */
export function refusalNotice(verdict: Extract<Classification, { ok: false }>, name: string): NoticeSpec {
  if (verdict.reason === "document") return documentRefusal(verdict.format);
  if (verdict.reason === "undecodable") return undecodableText(name);
  return unsupportedType(name);
}

export const DROP_TITLE = "여기에 파일을 놓으세요";
export const DROP_SUBTITLE = "이미지와 텍스트 파일을 첨부할 수 있습니다";
export const WAITING_FOR_UPLOAD = "업로드를 기다리는 중";

export function attachmentTotal(count: number, tokens: number, limit: number): string {
  return `첨부 ${count}개 · 약 ${formatTokens(tokens)} / ${formatTokens(limit)} 토큰`;
}
