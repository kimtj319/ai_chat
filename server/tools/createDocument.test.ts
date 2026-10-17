// create_document 검사. `npm test` 로 돈다.
import { createDocumentTool, MAX_DOCUMENT_CHARS } from "./createDocument.js";
import { getTool, listTools } from "./index.js";

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
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) throw new Error(`${failures.length} check(s) failed`);
