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
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) throw new Error(`${failures.length} check(s) failed`);
