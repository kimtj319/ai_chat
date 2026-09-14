// 저장 무결성·동시성 검사. `npm test` 로 돈다.
//
// 이 저장소에는 데이터베이스가 없다. 대화도 계정도 파일 하나씩이고, 그걸
// 지키는 것은 두 가지뿐이다 — **원자적 쓰기**(반쯤 쓰인 파일이 남지 않는다)와
// **키별 잠금**(같은 파일을 읽고-고치고-쓰는 요청들이 서로를 덮지 않는다).
// 둘 중 하나라도 깨지면 사용자는 대화가 사라지거나 섞인 것을 보게 되고,
// 그때는 이미 복구할 원본이 없다.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readJsonFile, writeFileAtomic, writeJsonFileAtomic } from "./atomic.js";
import { withLock } from "./mutex.js";

let passed = 0;
const failures: Array<{ name: string; message: string }> = [];

function check(name: string, condition: unknown, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failures.push({ name, message: detail });
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atomic-test-"));
const file = (name: string) => path.join(dir, name);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log("server/storage/atomic.ts + mutex.ts");

/* -------------------------------------------------------------- 읽기 */

{
  check("없는 파일은 null 이다(던지지 않는다)", (await readJsonFile(file("없다.json"))) === null);
}
{
  await writeJsonFileAtomic(file("a.json"), { 이름: "가", 수: 1 });
  const back = await readJsonFile<{ 이름: string; 수: number }>(file("a.json"));
  check("쓴 것을 그대로 읽는다", back?.이름 === "가" && back?.수 === 1, JSON.stringify(back));
}
{
  await fs.writeFile(file("깨짐.json"), "{ 이건 JSON 이 아니다");
  let threw = false;
  try {
    await readJsonFile(file("깨짐.json"));
  } catch {
    threw = true;
  }
  // 조용히 null 을 주면 "파일이 없다" 와 "파일이 깨졌다" 가 구분되지 않고,
  // 깨진 파일 위에 새 내용을 덮어써 원본을 영영 잃는다.
  check("깨진 파일은 던진다 — 없는 것과 구분된다", threw);
}

/* ---------------------------------------------------------- 원자적 쓰기 */

{
  await writeJsonFileAtomic(file("깊은/곳에/b.json"), { ok: true });
  check("없는 디렉터리는 만들어 준다", (await readJsonFile<{ ok: boolean }>(file("깊은/곳에/b.json")))?.ok === true);
}
{
  // 임시 파일을 남기지 않는다 — 남으면 디렉터리를 훑는 코드(청소·목록)가
  // 그것을 진짜 기록으로 착각한다.
  await writeJsonFileAtomic(file("c.json"), { x: 1 });
  const entries = await fs.readdir(dir);
  check("임시 파일이 남지 않는다", entries.every((e) => !e.endsWith(".tmp")), entries.join(", "));
}
{
  // 덮어쓰기 도중에도 읽는 쪽은 **옛 내용 아니면 새 내용**만 본다. 반쯤 쓰인
  // 것은 없다. rename 이 원자적이라는 것이 이 성질의 근거다.
  const big = { 값: "가".repeat(200_000) };
  await writeJsonFileAtomic(file("d.json"), { 값: "작음" });
  const writing = writeJsonFileAtomic(file("d.json"), big);
  const reads: string[] = [];
  for (let i = 0; i < 40; i++) {
    const cur = await readJsonFile<{ 값: string }>(file("d.json"));
    reads.push(cur?.값 === "작음" ? "옛" : cur?.값.length === 200_000 ? "새" : "깨짐");
  }
  await writing;
  check("쓰는 중에 읽어도 반쯤 쓰인 것은 없다", !reads.includes("깨짐"), reads.join("").slice(0, 40));
}
{
  await writeFileAtomic(file("e.bin"), Buffer.from([0, 1, 2, 255]));
  const raw = await fs.readFile(file("e.bin"));
  check("바이트도 그대로 쓴다", raw.length === 4 && raw[3] === 255, raw.join(","));
}

/* ------------------------------------------------------------ 키별 잠금 */

{
  // 같은 키의 작업은 겹치지 않는다. 겹치면 읽고-고치고-쓰기가 서로를 덮는다.
  let 동시 = 0;
  let 최대동시 = 0;
  const one = async () => {
    동시++;
    최대동시 = Math.max(최대동시, 동시);
    await sleep(15);
    동시--;
  };
  await Promise.all(Array.from({ length: 6 }, () => withLock("같은키", one)));
  check("같은 키는 한 번에 하나만 돈다", 최대동시 === 1, `최대 ${최대동시}개가 겹침`);
}
{
  // 순서도 지켜야 한다 — 먼저 들어온 것이 먼저 끝난다.
  const 순서: number[] = [];
  await Promise.all(
    [1, 2, 3, 4].map((n) =>
      withLock("순서키", async () => {
        await sleep(10 - n); // 나중 것이 더 빨리 끝나게 해 두어도
        순서.push(n);
      }),
    ),
  );
  check("들어온 순서대로 끝난다", 순서.join(",") === "1,2,3,4", 순서.join(","));
}
{
  // 키가 다르면 기다릴 이유가 없다. 여기서 직렬화되면 사용자마다 순서를
  // 기다리게 되어 서버가 느려진다.
  let 동시 = 0;
  let 최대동시 = 0;
  const one = async () => {
    동시++;
    최대동시 = Math.max(최대동시, 동시);
    await sleep(15);
    동시--;
  };
  await Promise.all(["a", "b", "c"].map((k) => withLock(k, one)));
  check("키가 다르면 함께 돈다", 최대동시 === 3, `최대 ${최대동시}개`);
}
{
  // 하나가 실패해도 뒤의 것이 굶지 않아야 한다 — 잠금이 영원히 잠기면
  // 그 대화는 다시는 저장되지 않는다.
  const 결과: string[] = [];
  const 실패 = withLock("실패키", async () => {
    throw new Error("일부러");
  }).catch(() => 결과.push("실패가 전달됨"));
  const 다음 = withLock("실패키", async () => {
    결과.push("다음이 돌았음");
  });
  await Promise.all([실패, 다음]);
  check("실패는 부른 쪽에 전달된다", 결과.includes("실패가 전달됨"), 결과.join(", "));
  check("실패해도 다음 작업이 돈다", 결과.includes("다음이 돌았음"), 결과.join(", "));
}
{
  const value = await withLock("값키", async () => 42);
  check("돌려준 값이 그대로 온다", value === 42, String(value));
}

/* ------------------------------------- 잠금 + 원자적 쓰기 (실제 쓰이는 모양) */

{
  // 저장소들이 하는 일 그대로: 읽고-고치고-쓰기를 잠금 안에서 100번.
  // 잠금이 없으면 마지막에 남는 수는 100 보다 작다.
  const target = file("counter.json");
  await writeJsonFileAtomic(target, { n: 0 });
  await Promise.all(
    Array.from({ length: 100 }, () =>
      withLock("counter", async () => {
        const cur = (await readJsonFile<{ n: number }>(target)) ?? { n: 0 };
        await writeJsonFileAtomic(target, { n: cur.n + 1 });
      }),
    ),
  );
  const final = await readJsonFile<{ n: number }>(target);
  check("잠금 안의 읽고-고치고-쓰기는 100번이 100이 된다", final?.n === 100, `n=${final?.n}`);
}

await fs.rm(dir, { recursive: true, force: true });

console.log("");
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
