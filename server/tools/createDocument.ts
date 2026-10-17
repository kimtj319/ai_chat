import type { ToolDefinition } from "./types.js";

/**
 * 모델이 정리한 내용을 사용자가 파일로 내려받게 한다.
 *
 * 파일은 서버에 만들지 않는다. 모델이 넘긴 제목·본문은 이 호출의 인자로 대화 기록에
 * 그대로 남고, 화면(src/components/DocumentDownload.tsx)이 그 인자로 다운로드 상자를
 * 그려 누르는 순간 브라우저에서 PDF·Markdown·TXT 를 만든다. 그래서 저장소도, 지울
 * 파일도, 남의 파일을 받을 경로도 없다 — 대화를 볼 수 있는 사람만 받을 수 있다.
 *
 * 대화 전체를 받는 머리의 저장(PDF·JSON)과 다르다: 그것은 주고받은 모든 말이고,
 * 이것은 모델이 "문서로" 정리한 본문 하나다.
 */
export const MAX_DOCUMENT_CHARS = 200_000;
export const MAX_DOCUMENT_TITLE_CHARS = 120;
export const DOCUMENT_FORMATS = ["pdf", "md", "txt"] as const;
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

export const createDocumentTool: ToolDefinition = {
  name: "create_document",
  description:
    "사용자가 내려받을 문서 파일을 만듭니다. 사용자가 정리한 내용을 PDF·문서·파일로 받고 싶다거나 " +
    "다운로드를 원할 때, 정리한 본문 전체를 content 에 마크다운으로 넣어 호출하세요(표·목록·제목 사용 가능). " +
    "대화에 다운로드 상자가 나타나 사용자가 PDF·Markdown·TXT 로 받습니다. " +
    "호출한 뒤 답변에는 본문을 다시 옮겨 쓰지 말고, 무엇을 담았는지만 짧게 알려 주세요.",
  category: "utility",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: `문서 제목. 파일 이름이 됩니다(${MAX_DOCUMENT_TITLE_CHARS}자 이하).` },
      content: { type: "string", description: "문서 본문 전체(마크다운)." },
      format: { type: "string", enum: [...DOCUMENT_FORMATS], description: "사용자가 원한 형식. 말이 없으면 pdf." },
    },
    required: ["title", "content"],
    additionalProperties: false,
  },
  async execute(args: { title?: unknown; content?: unknown; format?: unknown }) {
    const title = typeof args?.title === "string" ? args.title.trim() : "";
    if (!title) throw new Error("title must be a non-empty string");
    if (title.length > MAX_DOCUMENT_TITLE_CHARS) {
      throw new Error(`title too long (${title.length} chars, limit ${MAX_DOCUMENT_TITLE_CHARS})`);
    }
    const content = typeof args?.content === "string" ? args.content : "";
    if (!content.trim()) throw new Error("content must be a non-empty string");
    if (content.length > MAX_DOCUMENT_CHARS) {
      throw new Error(`content too long (${content.length} chars, limit ${MAX_DOCUMENT_CHARS})`);
    }
    const format: DocumentFormat = DOCUMENT_FORMATS.includes(args?.format as DocumentFormat)
      ? (args.format as DocumentFormat)
      : "pdf";
    return {
      created: true,
      title,
      format,
      characters: content.length,
      note: "사용자 화면에 다운로드 상자가 표시되었습니다. 본문을 답변에 다시 옮겨 쓰지 마세요.",
    };
  },
};
