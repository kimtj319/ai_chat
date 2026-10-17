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

/**
 * 이번 질문이 정리한 내용을 "파일로" 받겠다는 것인가.
 *
 * 이 도구는 이 판단이 참인 턴에만 모델에게 보인다(chat/turnTools.ts). 설명문에 "분명히
 * 원할 때만" 이라고 적는 것으로는 모자랐다: "내 이슈를 정리해서 작성해줘" 에 Gemma·
 * WiseLLoA 가 PDF 를 만들어 버렸다. 모델마다 다르게 읽는 말 대신, 보이지 않는 도구는
 * 부를 수 없다는 사실에 기댄다.
 *
 * 형식 이름(PDF·TXT…) 하나만으로는 판단하지 않는다 — "이 PDF 내용을 요약해줘" 의 PDF 는
 * 받을 형식이 아니라 읽을 대상이다. 형식 뒤에 만들기·받기 동사가 오거나, 다운로드·
 * "파일로" 처럼 받는다는 말이 있을 때만 참이다.
 */
const FORMAT = "(?:pdf|피디에프|txt|텍스트\\s*파일|docx|워드\\s*파일|hwp|한글\\s*파일|마크다운|markdown|md\\s*파일)";
const MAKE = "(?:만들|생성|저장|받|뽑|출력|내보내|변환|정리|작성|줘|주세요|달라|해\\s*줘)";
const DOWNLOAD_INTENT: RegExp[] = [
  new RegExp(`${FORMAT}\\s*(?:파일|문서|형식|형태|버전)?\\s*(?:으로|로)?\\s*${MAKE}`, "i"),
  /다운\s*로드|다운\s*받|내려\s*받|download/i,
  /파일\s*(?:로|을|를|로서|형태로)?\s*(?:만들|생성|저장|받|뽑|내보내|줘|주세요|달라)/,
  /(?:저장|보관)\s*(?:할\s*수\s*있게|용으로|용\s*파일)/,
  /\bexport\b|\bas\s+a\s+(?:pdf|file)\b|\bsave\s+(?:it\s+|this\s+)?as\b/i,
];

export function wantsDownloadableFile(text: string): boolean {
  return DOWNLOAD_INTENT.some((pattern) => pattern.test(text));
}

export const createDocumentTool: ToolDefinition = {
  name: "create_document",
  description:
    "사용자가 내려받을 문서 파일을 만듭니다. 사용자가 PDF·TXT·Markdown 파일로 받거나 다운로드하겠다고 " +
    "분명히 말했을 때만 호출하세요. '정리해줘', '작성해줘' 처럼 파일을 말하지 않은 요청에는 쓰지 말고 " +
    "답변 본문에 바로 쓰세요. 호출할 때는 정리한 본문 전체를 content 에 마크다운으로 넣고(표·목록·제목 사용 가능), " +
    "호출한 뒤 답변에는 본문을 다시 옮겨 쓰지 말고 무엇을 담았는지만 짧게 알려 주세요.",
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
