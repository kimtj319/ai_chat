/**
 * 모델이 create_document 로 만든 문서를 사용자가 내려받는 데 쓰는 순수 함수들.
 * 화면(DocumentDownload.tsx)과 떼어 두어 브라우저 없이 검사한다.
 */
import type { ToolCall, ToolResult } from "../api/types";

export type DocumentFormat = "pdf" | "md" | "txt";

export interface GeneratedDocument {
  /** 도구 호출 id — 한 답변에 문서가 여럿이어도 구분된다. */
  id: string;
  title: string;
  content: string;
  /** 모델이 사용자가 원한다고 본 형식. 상자의 첫 단추가 된다. */
  format: DocumentFormat;
}

const FORMATS: readonly DocumentFormat[] = ["pdf", "md", "txt"];

function argsOf(call: ToolCall): Record<string, unknown> | null {
  let value: unknown = call.arguments;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/**
 * 한 답변에서 성공한 create_document 호출을 문서로. 결과가 아직 오지 않았거나
 * 실패한(서버가 거절한) 호출은 빼 둔다 — 상자는 받을 수 있는 것만 보여 준다.
 */
export function documentsOf(toolCalls?: ToolCall[], toolResults?: ToolResult[]): GeneratedDocument[] {
  if (!toolCalls?.length) return [];
  const succeeded = new Set((toolResults ?? []).filter((r) => r.ok && r.name === "create_document").map((r) => r.id));
  const docs: GeneratedDocument[] = [];
  for (const call of toolCalls) {
    if (call.name !== "create_document" || !succeeded.has(call.id)) continue;
    const args = argsOf(call);
    const title = typeof args?.title === "string" ? args.title.trim() : "";
    const content = typeof args?.content === "string" ? args.content : "";
    if (!title || !content.trim()) continue;
    const format = FORMATS.includes(args?.format as DocumentFormat) ? (args!.format as DocumentFormat) : "pdf";
    docs.push({ id: call.id, title, content, format });
  }
  return docs;
}

/** 운영체제가 받지 않는 글자를 빼고 길이를 줄인 파일 이름. */
export function documentFilename(title: string, ext: DocumentFormat): string {
  const base = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 80)
    .trim();
  return `${base || "문서"}.${ext}`;
}

/**
 * TXT 로 받을 때의 본문: 마크다운 기호만 걷어 내고 내용과 줄 구성은 그대로 둔다.
 * 표는 칸 경계(|)가 곧 읽는 법이라 남긴다. 코드 블록 안은 손대지 않는다.
 */
export function markdownToPlainText(markdown: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^ {0,3}(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line) && line.includes("-")) {
      // 표의 구분선(|---|---|)은 글로 읽을 것이 없다.
      if (line.includes("|")) continue;
    }
    out.push(
      line
        .replace(/^(\s*)#{1,6}\s+/, "$1")
        .replace(/^(\s*)>\s?/, "$1")
        .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1")
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
        .replace(/(\*\*|__)(.+?)\1/g, "$2")
        .replace(/(^|[^*\w])\*(?!\s)(.+?)(?<!\s)\*(?!\*)/g, "$1$2")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/<br\s*\/?>/gi, " / "),
    );
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/** 받은 파일의 실제 바이트(텍스트 형식). PDF 는 화면이 따로 만든다. */
export function documentTextBlob(doc: GeneratedDocument, format: "md" | "txt"): Blob {
  const text = format === "md" ? doc.content.replace(/\r\n?/g, "\n").trimEnd() + "\n" : markdownToPlainText(doc.content);
  // BOM: 윈도 메모장이 UTF-8 한글을 깨뜨리지 않게.
  return new Blob(["﻿", text], { type: format === "md" ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8" });
}
