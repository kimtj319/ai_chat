// PDF 쪽 나누기 검사. `npm test` 로 돈다.
//
// 브라우저 타입체크를 받는 src/ 아래이므로 `process` 는 쓰지 않고, 실패는
// throw 로 표시한다(src/routes.test.ts 와 같은 규칙).
import { layoutBlocks } from "./pdfLayout.js";

let passed = 0;
const failures: Array<{ name: string; message: string }> = [];

function check(name: string, condition: unknown, detail = ""): void {
  if (condition) {
    passed++;
  } else {
    failures.push({ name, message: detail });
  }
}

// 쪽 1000, 여백 50 → 쓸 수 있는 높이 900. 간격 20.
const GEO = { pageHeight: 1000, margin: 50, gap: 20 };

{
  const { placements, pageCount } = layoutBlocks([100, 200], GEO);
  check("한 쪽에 들어가면 한 쪽", pageCount === 1, String(pageCount));
  check("첫 블록은 위 여백에서 시작", placements[0]?.y === 50);
  check("둘째 블록은 간격을 두고 이어진다", placements[1]?.y === 50 + 100 + 20, String(placements[1]?.y));
}

{
  // 50+500=550, 다음은 570 에서 시작해 500 → 1070 > 950 이라 다음 쪽으로.
  const { placements, pageCount } = layoutBlocks([500, 500], GEO);
  check("남은 자리에 안 들어가면 통째로 다음 쪽", pageCount === 2 && placements[1]?.page === 1 && placements[1]?.y === 50);
  check("넘긴 블록은 잘리지 않는다", placements.length === 2 && placements[1]?.sourceY === 0 && placements[1]?.height === 500);
}

{
  // 900 은 딱 한 쪽. 경계값.
  const { placements, pageCount } = layoutBlocks([900], GEO);
  check("쓸 수 있는 높이와 같으면 자르지 않는다", pageCount === 1 && placements.length === 1);
}

{
  // 100 뒤 남은 자리 780(170~950) 은 쓸 수 있는 높이의 20% 이상 → 이 쪽에서 바로 시작.
  // 2000 = 780 + 900 + 320.
  const { placements, pageCount } = layoutBlocks([100, 2000, 100], GEO);
  const big = placements.filter((p) => p.block === 1);
  check("한 쪽보다 큰 블록은 쪽마다 잘린다", big.map((p) => p.height).join() === "780,900,320", big.map((p) => p.height).join());
  check("잘린 조각은 이어지는 위치를 가리킨다", big.map((p) => p.sourceY).join() === "0,780,1680");
  check("자리가 넉넉하면 큰 블록은 지금 쪽에서 시작한다", big[0]?.page === 0 && big[0]?.y === 170, JSON.stringify(big[0]));
  const after = placements.find((p) => p.block === 2);
  check("마지막 조각 뒤에 다음 블록이 이어진다", after?.page === 2 && after?.y === 50 + 320 + 20, JSON.stringify(after));
  check("쪽 수", pageCount === 3, String(pageCount));
  check("어떤 조각도 아래 여백을 침범하지 않는다", placements.every((p) => p.y + p.height <= 950));
}

{
  // 800 뒤 남은 자리 130 은 20%(180) 미만 → 큰 블록은 새 쪽에서.
  const { placements } = layoutBlocks([800, 2000], GEO);
  const big = placements.filter((p) => p.block === 1);
  check("자리가 모자라면 큰 블록은 새 쪽에서 시작한다", big[0]?.page === 1 && big[0]?.y === 50, JSON.stringify(big[0]));
}

{
  // 자르는 자리를 30px 당기면 그만큼 다음 쪽으로 넘어간다.
  const { placements } = layoutBlocks([2000], GEO, (_b, _y, max) => max - 30);
  check("cut 이 고른 높이로 자른다", placements.map((p) => p.height).join() === "870,870,260", placements.map((p) => p.height).join());
  const tooShort = layoutBlocks([2000], GEO, () => 10).placements;
  check("cut 이 너무 짧게 고르면 쪽 끝에서 자른다", tooShort[0]?.height === 900);
}

{
  const { placements, pageCount } = layoutBlocks([0, 0], GEO);
  check("높이 0 은 건너뛴다", placements.length === 0 && pageCount === 0);
  let threw = false;
  try {
    layoutBlocks([10], { pageHeight: 100, margin: 50, gap: 0 });
  } catch {
    threw = true;
  }
  check("여백이 쪽을 다 먹으면 거절한다", threw);
}

console.log("src/state/pdfLayout.ts");
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  throw new Error(`${failures.length} check(s) failed`);
}
