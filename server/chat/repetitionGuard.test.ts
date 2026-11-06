// 끝 토큰 없이 같은 글을 되풀이하는 스트림을 잡는 검사. `npm test` 로 돈다.
const { RepetitionGuard, findTailRepetition } = await import("./repetitionGuard.js");

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

console.log("server/chat/repetitionGuard.ts");

/** 실제 스트림처럼 잘게 흘려 보내고, 걸린 시점의 누적 글과 판정을 돌려준다. */
function stream(text: string, step = 5) {
  const guard = new RepetitionGuard();
  let fed = "";
  for (let i = 0; i < text.length; i += step) {
    const delta = text.slice(i, i + step);
    fed += delta;
    const trip = guard.feed(delta);
    if (trip) return { trip, fed, kept: fed.slice(0, fed.length - trip.drop) };
  }
  return { trip: null, fed, kept: fed };
}

const intro = "질문하신 내용을 정리하면 다음과 같습니다.\n\n";
const sentence = "따라서 이 설정은 검색 결과의 정렬 순서에 영향을 줍니다. ";

// 1. 문장 하나가 끝없이 반복되면 잡고, 한 벌만 남긴다.
{
  const r = stream(intro + sentence.repeat(400));
  check("repeated sentence trips", r.trip !== null);
  check("trips well before the end of the loop", r.fed.length < intro.length + sentence.length * 120, `fed ${r.fed.length}`);
  check("period is the sentence (or a rotation of it)", r.trip?.period === sentence.length, `period ${r.trip?.period}`);
  check("kept text is the intro plus about one copy", r.kept.length < intro.length + sentence.length * 2 + 5, `kept ${r.kept.length}`);
  check("kept text still starts with the intro", r.kept.startsWith(intro));
}

// 2. 한 글자·짧은 단어 반복(줄바꿈 폭주 포함)도 잡는다.
{
  check("newline flood trips", stream("답:\n" + "\n".repeat(5000)).trip?.period === 1);
  check("short word loop trips", stream("그리고 ".repeat(1500)).trip?.period === 4);
}

// 3. 긴 문단 반복(1,000자 문단 × 6)도 잡는다.
{
  let paragraph = "";
  for (let i = 0; paragraph.length < 1000; i++) paragraph += `${i}번째 근거는 서로 다른 내용입니다. `;
  const r = stream(paragraph.repeat(8), 13);
  check("long paragraph loop trips", r.trip !== null && r.trip.period === paragraph.length, `period ${r.trip?.period} vs ${paragraph.length}`);
}

// 4. 정상 답은 걸리지 않는다: 번호 목록·표·코드·짧은 의도적 반복.
{
  let list = "";
  for (let i = 1; i <= 400; i++) list += `${i}. 항목 ${i} 의 설명입니다.\n`;
  check("numbered list does not trip", stream(list).trip === null);

  let table = "| 이름 | 값 |\n|---|---|\n";
  for (let i = 0; i < 300; i++) table += `| key${i} | ${i * 7} |\n`;
  check("markdown table does not trip", stream(table).trip === null);

  let code = "```ts\n";
  for (let i = 0; i < 200; i++) code += `const field${i} = row.get("field${i}");\n`;
  check("generated code does not trip", stream(code + "```\n").trip === null);

  check("short intentional repeat (가나다라 x100) does not trip", stream("가나다라".repeat(100)).trip === null);
  check("five copies of a long paragraph do not trip", stream(sentence.repeat(5)).trip === null);
}

// 5. 한 번 걸리면 다시 걸리지 않고, drop 은 넣은 글보다 길지 않다.
{
  const guard = new RepetitionGuard();
  let trips = 0;
  let fed = 0;
  let maxDrop = 0;
  for (let i = 0; i < 3000; i++) {
    const d = "ab";
    fed += d.length;
    const t = guard.feed(d);
    if (t) {
      trips++;
      maxDrop = Math.max(maxDrop, t.drop);
    }
  }
  check("trips only once", trips === 1, `trips ${trips}`);
  check("drop never exceeds what was fed", maxDrop <= fed);
}

// 6. 직접 판정: 너무 짧으면 null.
check("findTailRepetition: short text is null", findTailRepetition("ababab") === null);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
