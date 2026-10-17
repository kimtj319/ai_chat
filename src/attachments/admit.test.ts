// 첨부 받아들이기 검사(이미지 디코드가 없는 글 파일 쪽). 칩이 생기기 전에
// 거절되어야 할 파일이 거절되는지. `npx tsx src/attachments/admit.test.ts` 로 돈다.
import type { AttachmentLimits } from "../api/types";
import { admit } from "./admit";

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

const limits: AttachmentLimits = {
  contextWindow: 262144,
  maxMessageTokens: 65536,
  maxFileTokens: 32768,
  maxFileBytes: 10 * 1024 * 1024,
  maxImageWidth: 4096,
  maxImageHeight: 4096,
};
const names = () => [];

console.log("src/attachments/admit.ts");

{
  const result = await admit(new File(["안녕하세요"], "memo.txt", { type: "text/plain" }), "picker", names, limits);
  check("글 파일은 칩이 된다", "seed" in result && result.seed.kind === "text" && result.seed.text === "안녕하세요");
  check("글 파일에는 디코드한 비트맵이 없다", "seed" in result && result.probe === undefined);
}
{
  const result = await admit(new File(["x".repeat(400_000)], "big.txt", { type: "text/plain" }), "picker", names, limits);
  check("한 파일 토큰 한도를 넘으면 거절", "refusal" in result, JSON.stringify(result).slice(0, 80));
}
{
  const bytes = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2, 3, 0, 0, 0, 0]);
  const result = await admit(new File([bytes], "a.out", { type: "application/octet-stream" }), "drop", names, limits);
  check("실행 파일은 거절", "refusal" in result);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) throw new Error(`${failures.length} check(s) failed`);
