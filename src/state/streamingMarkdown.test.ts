// 흘러 들어오는 표 감추기 검사. `npm test` 로 돈다.
import { stableStreamingMarkdown as f } from "./streamingMarkdown.js";

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

console.log("src/state/streamingMarkdown.ts");
const head = "정리하면:\n\n| 도시 | 인구 |\n|---|---|\n";
check("반쯤 온 행은 감춘다", f(`${head}| 서울 | 9,5`) === head, JSON.stringify(f(`${head}| 서울 | 9,5`)));
check("다 온 행은 보인다", f(`${head}| 서울 | 9,579,449 |\n`) === `${head}| 서울 | 9,579,449 |\n`);
check("구분선 전의 머리 줄은 감춘다", f("정리하면:\n\n| 도시 | 인구 |\n") === "정리하면:\n\n", JSON.stringify(f("정리하면:\n\n| 도시 | 인구 |\n")));
check("반쯤 온 구분선이면 머리 줄까지 감춘다", f("정리하면:\n\n| 도시 | 인구 |\n|---") === "정리하면:\n\n", JSON.stringify(f("정리하면:\n\n| 도시 | 인구 |\n|---")));
check("구분선까지 오면 빈 표가 보인다", f(head) === head);
check("표가 아닌 글은 그대로", f("그냥 문장이 이어지는 중") === "그냥 문장이 이어지는 중");
check("표 다음 글도 그대로", f(`${head}| 서울 | 1 |\n\n끝으로`) === `${head}| 서울 | 1 |\n\n끝으로`);
check("표만으로 시작해도 머리 줄을 감춘다", f("| a | b |\n") === "");
check("열린 코드 울타리는 그대로", f("설명:\n\n```ts\nconst a = 1;") === "설명:\n\n```ts\nconst a = 1;");
check("열린 울타리 안의 표 모양 줄은 감추지 않는다", f("```\n| a | b |") === "```\n| a | b |");
check("반쯤 온 언어명 울타리는 감춘다", f("설명:\n\n```ty") === "설명:\n\n");
check("언어 없는 울타리만 와도 감춘다", f("설명:\n```") === "설명:\n");
check("울타리 줄이 끝나면 보인다", f("설명:\n```ts\n") === "설명:\n```ts\n");
check("닫힌 울타리 뒤는 정상", f("```\nx\n```\n끝") === "```\nx\n```\n끝");
check("닫는 울타리는 감추지 않는다", f("```\nx\n```") === "```\nx\n```");
for (const m of ["#", "###", "-", "*", "1.", ">"]) check(`마커 ${m} 만 있는 끝줄은 감춘다`, f(`문장\n\n${m}`) === "문장\n\n", JSON.stringify(f(`문장\n\n${m}`)));
check("마커 뒤에 글이 있으면 보인다", f("문장\n\n- 항목") === "문장\n\n- 항목");
check("열린 울타리 안의 마커는 그대로", f("```\n-") === "```\n-");
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) throw new Error(`${failures.length} check(s) failed`);
