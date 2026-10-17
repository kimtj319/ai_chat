// 저장된 답변의 요약 안내 문구 숨기기 검사. `npm test` 로 돈다.
import { partitionNotice, visibleNotice } from "./visibleNotice.js";

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
const connectFail = 'MCP 서버 "GitLab"에 연결하지 못해 이번 답변에서는 도구를 사용할 수 없습니다.';
const unknownTools = 'MCP 서버 "Jira"의 도구 목록을 아직 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.';
const quarantined = 'MCP 서버 "X"가 연속 실패로 일시 차단되어 이번 답변에서는 도구를 사용할 수 없습니다.';
const limit = "도구 호출 8회에 도달하여 도구 사용을 중단하고 답변을 생성합니다.";
{
  const parts = partitionNotice(visibleNotice(`${connectFail}\n${limit}`));
  check("MCP 연결 실패 줄은 따로 모은다", parts.toolFailures.length === 1 && parts.toolFailures[0] === connectFail);
  check("나머지 안내는 그대로 남는다", parts.other === limit, String(parts.other));
}
{
  const parts = partitionNotice(visibleNotice(`${summary}\n${connectFail}\n${unknownTools}\n${quarantined}`));
  check("세 가지 MCP 실패 문구를 모두 알아본다", parts.toolFailures.length === 3, String(parts.toolFailures.length));
  check("MCP 실패뿐이면 나머지는 null", parts.other === null);
}
check("MCP 실패가 없으면 그대로", partitionNotice(limit).toolFailures.length === 0 && partitionNotice(limit).other === limit);
check("null 이면 빈 결과", partitionNotice(null).toolFailures.length === 0 && partitionNotice(null).other === null);
check("다른 MCP 문구(목록 읽기 실패)도 접는다", partitionNotice("MCP 서버 목록을 읽지 못해 이번 답변에서는 MCP 도구를 사용할 수 없습니다.").toolFailures.length === 1);
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) throw new Error(`${failures.length} check(s) failed`);
