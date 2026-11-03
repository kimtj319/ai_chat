// 입력창 컨텍스트 사용률 표시 문구·색. `npx tsx src/state/contextMeter.test.ts`
import { meterView } from "./contextMeter";
let passed = 0;
const failures: string[] = [];
function check(name: string, ok: unknown, detail = ""): void {
  if (ok) { passed++; console.log(`  ok  ${name}`); } else { failures.push(name); console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}
console.log("src/state/contextMeter.ts");
const M = "google/gemma-4-31B-it";
const base = { model: M, exact: true, willSummarize: false, summaryRatio: 0.8, toolStopRatio: 0.8 };
const W = 262_144;
const low = meterView({ ...base, tokens: 89_000, contextWindow: W }, M);
check("백분율은 반올림", low.percent === 34 && low.short === "34%", JSON.stringify(low));
check("70% 아래는 보통", low.tone === "normal");
check("자세히에 토큰 수·길이·모델 이름·압축 기준", low.detail.includes("89,000 / 262,144") && low.detail.includes("gemma-4-31B-it") && low.detail.includes("80%가 되면"), low.detail);
check("70% 부터는 곧 압축된다고 미리 알린다(주황)", meterView({ ...base, tokens: 190_000, contextWindow: W }, M).tone === "summary");
const compact = meterView({ ...base, willSummarize: true, tokens: 215_000, contextWindow: W }, M);
check("서버가 압축한다고 하면 빨강·다음 질문에서 압축", compact.tone === "full" && compact.detail.includes("다음 질문을 보낼 때"), JSON.stringify(compact));
check("도구 정의 몫으로만 80% 를 넘으면 빨강·도구 멈춤 안내", meterView({ ...base, tokens: 215_000, contextWindow: W }, M).detail.includes("도구 호출이 멈출"));
check("100%를 넘겨 표시하지 않는다", meterView({ ...base, tokens: 300_000, contextWindow: W }, M).percent === 100);
check("추정값이면 '약'", meterView({ ...base, exact: false, tokens: 10, contextWindow: 100 }, M).detail.includes("약 10"));
const tiny = meterView({ ...base, tokens: 768, contextWindow: W }, M);
check("조금 썼으면 0% 가 아니라 1% 미만", tiny.short === "<1%" && tiny.detail.startsWith("컨텍스트 1% 미만 사용"), JSON.stringify(tiny));
const none = meterView({ ...base, tokens: 500, contextWindow: null }, M);
check("길이를 모르면 백분율 없이 알린다", none.percent === null && none.short === "—" && none.detail.includes("알려 주지 않습니다"), JSON.stringify(none));
// 답변 중(실시간)
const live = { tokens: 120_000, contextWindow: W, summaryRatio: 0.8, toolStopRatio: 0.8 };
const liveView = meterView({ ...base, tokens: 9_000, contextWindow: W }, M, live);
check("답변 중에는 그 라운드의 크기로 바로 바뀐다", liveView.percent === 46 && liveView.detail.startsWith("답변 중 ·"), JSON.stringify(liveView));
check("첫 측정 전이라도 실시간 값만으로 보인다", meterView(null, M, live).percent === 46);
const liveFull = meterView(null, M, { ...live, tokens: 220_000 });
check("답변 중 80% 를 넘으면 빨강·이번 답변 정리 안내", liveFull.tone === "full" && liveFull.detail.includes("이번 답변은"), JSON.stringify(liveFull));
console.log(`\n${passed} passed, ${failures.length} failed`);
// src/ 는 브라우저 타입체크를 받아 process 를 쓰지 않는다 — 실패는 던져서 알린다.
if (failures.length) throw new Error(`${failures.length} check(s) failed`);
