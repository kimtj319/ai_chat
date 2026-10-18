// 출처 창 캐시의 밀어내기. `npm test` 로 돈다.
import { LruCache } from "./lruCache.js";

let passed = 0;
const failures: string[] = [];
function check(name: string, condition: unknown): void {
  if (condition) passed++;
  else {
    failures.push(name);
    console.log(`FAIL  ${name}`);
  }
}

console.log("src/state/lruCache.ts");

const evicted: string[] = [];
const cache = new LruCache<string, string>(3, (value, key) => evicted.push(`${key}=${value}`));
cache.set("a", "A");
cache.set("b", "B");
cache.set("c", "C");
check("한도까지는 아무것도 밀려나지 않는다", evicted.length === 0 && cache.size === 3);

cache.get("a"); // a 가 가장 최근이 된다 → 가장 오래된 것은 b
cache.set("d", "D");
check("가장 오래 안 쓴 것이 밀려난다", evicted.join() === "b=B");
check("쓴 것은 남는다", cache.has("a") && cache.has("c") && cache.has("d") && !cache.has("b"));

cache.peek("c"); // peek 은 순서를 건드리지 않는다 → 다음에 밀려날 것은 여전히 c
cache.set("e", "E");
check("peek 은 순서를 올리지 않는다", evicted.join() === "b=B,c=C");
check("values 는 오래된 것부터", cache.values().join() === "A,D,E");

cache.set("a", "A2");
check("같은 키에 다른 값을 넣으면 옛 값을 놓는다", evicted.at(-1) === "a=A" && cache.peek("a") === "A2" && cache.size === 3);
const before = evicted.length;
cache.set("a", "A2");
check("같은 값을 다시 넣으면 놓지 않는다", evicted.length === before);

cache.delete("d");
check("지우면 놓는다", evicted.at(-1) === "d=D" && !cache.has("d"));
cache.delete("없음");
check("없는 키를 지워도 조용하다", evicted.at(-1) === "d=D");

cache.clear();
check("비우면 남은 것을 모두 놓는다", cache.size === 0 && evicted.slice(-2).sort().join() === "a=A2,e=E");

const one = new LruCache<number, number>(1);
one.set(1, 1);
one.set(2, 2);
check("onEvict 없이도 한도를 지킨다", one.size === 1 && one.get(2) === 2 && one.get(1) === undefined);

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) throw new Error(`${failures.length}건 실패`);
