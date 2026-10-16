// 저장된 답변의 요약 안내 문구 숨기기 검사. `npm test` 로 돈다.
import { visibleNotice } from "./visibleNotice.js";

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

console.log("src/state/visibleNotice.ts");
const summary = "컨텍스트 한도에 도달하여 이전 대화 2개를 요약해 이어갑니다. 이후 답변은 이 요약을 바탕으로 이어집니다.";
check("요약 안내만 있으면 아무것도 보이지 않는다", visibleNotice(summary) === null);
check("다른 안내와 함께면 그것만 남는다", visibleNotice(`${summary}\nMCP 서버 "x"에 연결하지 못했습니다.`) === 'MCP 서버 "x"에 연결하지 못했습니다.');
check("다른 안내는 그대로", visibleNotice("도구 호출 8회에 도달하여 도구 사용을 중단하고 답변을 생성합니다.") === "도구 호출 8회에 도달하여 도구 사용을 중단하고 답변을 생성합니다.");
check("다른 압축 안내(재시도)는 숨기지 않는다", visibleNotice("컨텍스트 한도를 초과하여 이전 내용을 줄이고 다시 시도합니다.") !== null);
check("없으면 null", visibleNotice(undefined) === null && visibleNotice("") === null);
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) throw new Error(`${failures.length} check(s) failed`);
