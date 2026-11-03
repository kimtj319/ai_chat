// 입력창 컨텍스트 사용률 표시 문구·색. `npx tsx src/state/contextMeter.test.ts`
import { meterView } from "./contextMeter";
let passed = 0;
const failures: string[] = [];
function check(name: string, ok: unknown, detail = ""): void {
  if (ok) { passed++; console.log(`  ok  ${name}`); } else { failures.push(name); console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}
console.log("src/state/contextMeter.ts");
const base = { model: "google/gemma-4-31B-it", exact: true, willSummarize: false, summaryRatio: 0.5, toolStopRatio: 0.8 };
const low = meterView({ ...base, tokens: 89_000, contextWindow: 262_144 });
check("백분율은 반올림", low.percent === 34 && low.short === "34%", JSON.stringify(low));
check("50% 아래는 보통", low.tone === "normal");
check("자세히에 토큰 수·길이·모델 이름", low.detail.includes("89,000 / 262,144") && low.detail.includes("gemma-4-31B-it"), low.detail);
check("서버가 요약한다고 하면 요약 안내", meterView({ ...base, willSummarize: true, tokens: 140_000, contextWindow: 262_144 }).tone === "summary");
check("백분율이 50%를 넘어도 서버가 요약하지 않는다면 보통(도구 정의 몫)", meterView({ ...base, willSummarize: false, tokens: 140_000, contextWindow: 262_144 }).tone === "normal");
check("도구 중단 기준선(80%) 넘으면 가득", meterView({ ...base, tokens: 220_000, contextWindow: 262_144 }).tone === "full");
check("100%를 넘겨 표시하지 않는다", meterView({ ...base, tokens: 300_000, contextWindow: 262_144 }).percent === 100);
check("추정값이면 '약'", meterView({ ...base, exact: false, tokens: 10, contextWindow: 100 }).detail.includes("약 10"));
const tiny = meterView({ ...base, tokens: 768, contextWindow: 262_144 });
check("조금 썼으면 0% 가 아니라 1% 미만", tiny.short === "<1%" && tiny.detail.startsWith("컨텍스트 1% 미만 사용"), JSON.stringify(tiny));
const none = meterView({ ...base, tokens: 500, contextWindow: null });
check("길이를 모르면 백분율 없이 알린다", none.percent === null && none.short === "—" && none.detail.includes("알려 주지 않습니다"), JSON.stringify(none));
console.log(`\n${passed} passed, ${failures.length} failed`);
// src/ 는 브라우저 타입체크를 받아 process 를 쓰지 않는다 — 실패는 던져서 알린다.
if (failures.length) throw new Error(`${failures.length} check(s) failed`);
