// SSE 파서 검사. 대화 스트림과 문서 업로드가 같이 쓴다.
// `npx tsx src/api/sseParser.test.ts` 로 돈다.
import { flushSseBuffer, parseSseChunk } from "./sseParser";

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

console.log("src/api/sseParser.ts");

{
  const result = parseSseChunk("", 'data: {"a":1}\n\ndata: {"b":2}\n\n');
  check("빈 줄로 나뉜 두 이벤트", JSON.stringify(result.events) === JSON.stringify(['{"a":1}', '{"b":2}']) && result.remainder === "");
}
{
  const first = parseSseChunk("", 'data: {"a":');
  const second = parseSseChunk(first.remainder, '1}\n\n');
  check("조각난 이벤트는 다음 읽기에서 이어진다", first.events.length === 0 && second.events[0] === '{"a":1}');
}
{
  const result = parseSseChunk("", 'event: x\r\ndata: {"c":3}\r\n\r\n');
  check("CRLF 구분", result.events[0] === '{"c":3}' && result.events.length === 1);
}
{
  const result = parseSseChunk("", "data: [DONE]\n\n");
  check("[DONE] 은 이벤트가 아니라 끝 표시", result.done && result.events.length === 0);
}
{
  const tail = parseSseChunk("", 'data: {"d":4}');
  const flushed = flushSseBuffer(tail.remainder);
  check("빈 줄 없이 끝난 마지막 이벤트도 나온다", tail.events.length === 0 && flushed.events[0] === '{"d":4}');
  check("빈 버퍼는 아무것도 내지 않는다", flushSseBuffer("  ").events.length === 0);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) throw new Error(`${failures.length} check(s) failed`);
