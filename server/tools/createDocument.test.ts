// create_document 검사. `npm test` 로 돈다.
import { createDocumentTool, MAX_DOCUMENT_CHARS } from "./createDocument.js";
import { getTool, listTools } from "./index.js";
import { wantsDownloadableFile } from "./createDocument.js";
import { buildTurnTools } from "../chat/turnTools.js";

let passed = 0;
const failures: string[] = [];
function check(name: string, condition: unknown, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
async function rejects(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "";
  } catch (err) {
    return (err as Error).message;
  }
}

console.log("server/tools/createDocument.ts");
const ok = (await createDocumentTool.execute({ title: "  회의 정리 ", content: "# 제목\n\n| a | b |\n|---|---|\n| 1 | 2 |" })) as Record<string, unknown>;
check("제목은 다듬어서 돌려준다", ok.title === "회의 정리", JSON.stringify(ok));
check("형식을 말하지 않으면 pdf", ok.format === "pdf");
check("본문 길이를 알려 준다", ok.characters === 35, String(ok.characters));
check("본문을 결과에 되풀이하지 않는다(모델 문맥 낭비)", !JSON.stringify(ok).includes("| a | b |"));
const md = (await createDocumentTool.execute({ title: "t", content: "x", format: "md" })) as Record<string, unknown>;
check("원한 형식을 지킨다", md.format === "md");
const weird = (await createDocumentTool.execute({ title: "t", content: "x", format: "docx" })) as Record<string, unknown>;
check("모르는 형식은 pdf 로", weird.format === "pdf");
check("빈 제목은 거절", (await rejects(() => createDocumentTool.execute({ title: " ", content: "x" }))).includes("title"));
check("빈 본문은 거절", (await rejects(() => createDocumentTool.execute({ title: "t", content: "  \n" }))).includes("content"));
check("너무 긴 본문은 거절", (await rejects(() => createDocumentTool.execute({ title: "t", content: "x".repeat(MAX_DOCUMENT_CHARS + 1) }))).includes("too long"));
check("도구 목록에 있어 새 대화에서 기본으로 켜진다", listTools().some((t) => t.name === "create_document"));
check("이름으로 찾을 수 있다", getTool("create_document") === createDocumentTool);
// 파일로 받겠다는 뜻이 있는 질문에만 도구가 보인다.
const intent = [
  "회의 내용을 정리해서 PDF로 받을 수 있게 해줘",
  "이거 pdf로 만들어줘",
  "PDF 파일로 저장해 줘",
  "txt 로 뽑아줘",
  "마크다운 파일로 정리해줘",
  "정리한 걸 다운로드 할 수 있게 해줘",
  "문서로 내려받고 싶어",
  "파일로 만들어줘",
  "보관용으로 저장할 수 있게 정리해줘",
  "Export this as a PDF",
];
const plain = [
  "내 이슈를 정리해서 작성해줘",
  "담당자 김태진의 이슈를 정리해서 알려줘",
  "회의 내용을 문서로 정리해줘",
  "보고서 형식으로 작성해줘",
  "이 PDF 내용을 요약해줘",
  "첨부한 pdf를 읽고 핵심만 알려줘",
  "파일을 읽어서 설명해줘",
  "txt 파일이 뭐야?",
];
for (const q of intent) check(`의도 있음: ${q}`, wantsDownloadableFile(q));
for (const q of plain) check(`의도 없음: ${q}`, !wantsDownloadableFile(q));

const conversation = (text: string) =>
  ({
    id: "c",
    enabledTools: ["calculator", "create_document"],
    messages: [
      { id: "1", role: "user", content: "앞에서는 PDF로 만들어 달라고 했다", createdAt: "" },
      { id: "2", role: "assistant", content: "네", createdAt: "" },
      { id: "3", role: "user", content: text, createdAt: "" },
    ],
  }) as never;
const offered = (text: string) => buildTurnTools(conversation(text), [], false).turnTools.has("create_document");
check("파일 의도가 없는 턴에는 도구를 내놓지 않는다", !offered("내 이슈를 정리해서 작성해줘"));
check("판단은 이번 질문으로 한다(앞 질문의 PDF 는 상관없다)", !offered("이제 요약만 해줘"));
check("파일 의도가 있는 턴에는 내놓는다", offered("방금 정리한 걸 PDF로 받을 수 있게 해줘"));
check("다른 도구는 그대로", buildTurnTools(conversation("안녕"), [], false).turnTools.has("calculator"));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) throw new Error(`${failures.length} check(s) failed`);
