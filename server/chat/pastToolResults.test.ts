// 지난 턴의 도구 결과를 다시 실을 때 턴당 상한으로 줄이는 규칙 검사.
// `npx tsx server/chat/pastToolResults.test.ts` 로 돈다.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "past-tool-results-test-"));

const { fitPastTurnToolResults, citedRefs, PAST_TURN_TOOL_RESULT_CHARS } = await import("./pastToolResults.js");
const { buildHistoryMessages } = await import("./historyBuilder.js");

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: unknown, detail = ""): void {
  if (ok) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("server/chat/pastToolResults.ts — 지난 턴 도구 결과 상한");

const page = (url: string, chars: number) => ({ title: `제목 ${url}`, url, content: "가".repeat(chars) });
const big = JSON.stringify({ results: [page("https://a.example/1", 30_000), page("https://b.example/2", 30_000)] });
const small = JSON.stringify({ result: 42 });

{
  const out = fitPastTurnToolResults([small, small]);
  check("상한 안이면 한 글자도 바꾸지 않는다", out[0] === small && out[1] === small);
}

{
  const out = fitPastTurnToolResults([big, small]);
  const total = out.reduce((s, c) => s + c.length, 0);
  check("넘치면 턴 전체가 상한 안으로 들어온다", total <= PAST_TURN_TOOL_RESULT_CHARS, `${total} > ${PAST_TURN_TOOL_RESULT_CHARS}`);
  check("작은 결과는 그대로 둔다", out[1] === small, out[1]);
  check("줄인 결과에는 줄였다는 안내가 붙는다", out[0]!.includes("이전 턴의 도구 결과") && out[0]!.includes("다시"), out[0]!.slice(0, 120));
  check("제목·주소는 남는다", ["https://a.example/1", "https://b.example/2", "제목 https://a.example/1"].every((s) => out[0]!.includes(s)), out[0]!.slice(0, 300));
}

{
  // 문서 검색 결과: 단락마다 ref 번호가 달린 JSON 문자열(annotateForModel 의 모양)
  const rag = JSON.stringify(
    JSON.stringify({
      citation_rule: "…",
      passages: Array.from({ length: 10 }, (_, i) => ({ ref: i + 1, doc_id: `doc_x#${i}`, title: `문서 ${i}`, text: "나".repeat(5_000) })),
    }),
  );
  const [out] = fitPastTurnToolResults([rag]);
  const refs = Array.from({ length: 10 }, (_, i) => `"ref":${i + 1}`).filter((r) => out!.includes(r)).length;
  check("문서 검색 결과는 단락이 빠지지 않고 ref 번호가 모두 남는다", refs === 10, `${refs}/10`);
  check("문서 검색 결과도 상한 안", out!.length <= PAST_TURN_TOOL_RESULT_CHARS, String(out!.length));
}

{
  // 검색을 12번 한 턴: 주소는 하나도 잘리지 않아야 한다.
  const searches = Array.from({ length: 12 }, (_, i) =>
    JSON.stringify({ results: Array.from({ length: 10 }, (_, j) => ({ title: `기사 ${i}-${j}`, url: `https://news.example.com/articles/2026/11/03/item-${i}-${j}.html`, content: "마".repeat(500) })) }),
  );
  const out = fitPastTurnToolResults(searches);
  const urls = Array.from({ length: 12 }, (_, i) => Array.from({ length: 10 }, (_, j) => `https://news.example.com/articles/2026/11/03/item-${i}-${j}.html`)).flat();
  const kept = urls.filter((u) => out.some((c) => c.includes(u))).length;
  check("도구를 많이 부른 턴에서도 주소 120개가 모두 그대로", kept === 120, `${kept}/120`);
}

{
  // 문서 검색을 30번 한 턴: 답변이 인용한 ref 는 모두 남고, 결과마다 JSON 이 깨지지 않고, 상한 안.
  let n = 0;
  const calls = Array.from({ length: 30 }, () =>
    JSON.stringify(JSON.stringify({ passages: Array.from({ length: 10 }, () => ({ ref: ++n, doc_id: `doc_y#${n}`, title: `문서 ${n}`, text: "바".repeat(1_500) })) })),
  );
  const answer = "요약입니다 [3] 그리고 [77], [150] 및 [299] 참고.";
  const cited = citedRefs(answer);
  check("답변의 [n] 을 인용 번호로 읽는다", [3, 77, 150, 299].every((r) => cited.has(r)) && cited.size === 4);
  const out = fitPastTurnToolResults(calls, PAST_TURN_TOOL_RESULT_CHARS, cited);
  const keptCited = [...cited].filter((r) => out.some((c) => c.includes(`"ref":${r},`))).length;
  const valid = out.filter((c) => {
    const body = c.includes("\n") ? c.slice(c.indexOf("\n") + 1) : c;
    try {
      JSON.parse(body);
      return true;
    } catch {
      return false;
    }
  }).length;
  check("문서 검색이 많아도 답변이 인용한 ref 는 모두 남는다", keptCited === 4, `${keptCited}/4`);
  check("줄인 결과도 JSON 으로 읽힌다", valid === 30, `${valid}/30`);
  const after = out.reduce((s, c) => s + c.length, 0);
  check("짧은 값이 많아도 턴 전체가 상한 안(여유 10%)", after <= PAST_TURN_TOOL_RESULT_CHARS * 1.1, String(after));
}

{
  // 운영 모양(2026-11-05): Confluence 페이지 목록처럼 짧은 값만 잔뜩인 결과를 46번 — 예전엔 225k자가 그대로 갔다.
  const listing = (k: number) =>
    JSON.stringify(
      JSON.stringify({
        results: Array.from({ length: 50 }, (_, j) => ({
          id: `${900000 + k * 100 + j}`,
          title: `페이지 ${k}-${j}`,
          status: "current",
          spaceId: "98765",
          parentId: `${800000 + j}`,
          authorId: "634d0a23fc0cc7a600ac13be",
          createdAt: "2026-10-01T09:00:00.000Z",
          version: { number: j, createdAt: "2026-10-02T09:00:00.000Z" },
          _links: { webui: `/spaces/SOL/pages/${900000 + k * 100 + j}/page-${k}-${j}` },
        })),
      }),
    );
  const calls = Array.from({ length: 46 }, (_, k) => listing(k));
  const before = calls.reduce((s, c) => s + c.length, 0);
  const out = fitPastTurnToolResults(calls);
  const after = out.reduce((s, c) => s + c.length, 0);
  check("짧은 값 목록 46개도 턴 상한 안(여유 10%)", after <= PAST_TURN_TOOL_RESULT_CHARS * 1.1, `${before} → ${after}`);
  check("결과마다 줄였다는 안내가 남는다", out.every((c) => c.includes("이전 턴")));
  check("목록을 줄인 결과는 그렇다고 안내한다(짧은 값이 그대로라고 하지 않는다)", out.every((c) => c.includes("목록은 앞쪽 일부") || c.includes("생략(")), out[0]!.slice(0, 120));
}

{
  // 인용한 단락은 자리가 있으면 본문 일부를 지킨다(번호·제목만 남지 않게).
  const passages = Array.from({ length: 40 }, (_, i) => ({ ref: i + 1, title: `문서 ${i + 1}`, text: `본문${i + 1} ` + "가".repeat(3_000) }));
  const one = JSON.stringify(JSON.stringify({ passages }));
  const [out] = fitPastTurnToolResults([one], 8_000, citedRefs("핵심은 [37] 입니다"));
  check("인용한 단락은 본문 앞부분이 남는다", out!.includes('"ref":37') && out!.includes("본문37 가가가"), out!.slice(0, 200));
  check("그래도 상한 안", out!.length <= 8_000 * 1.05, String(out!.length));
}

{
  const plain = JSON.stringify("다".repeat(50_000));
  const [out] = fitPastTurnToolResults([plain]);
  check("JSON 이 아닌 긴 글도 상한 안으로 자른다", out!.length <= PAST_TURN_TOOL_RESULT_CHARS, String(out!.length));
}

// 대화 기록을 다시 만들 때: 답변 본문·도구 호출 id 는 그대로, 도구 결과만 줄어든다.
{
  const answer = "지난 턴의 답변 본문입니다. ".repeat(50);
  const turn = (id: string) => ({
    id: `a-${id}`,
    role: "assistant" as const,
    content: answer,
    toolCalls: [{ id: `call-${id}`, name: "http_fetch", arguments: { url: "https://a.example/1" } }],
    toolResults: [{ id: `call-${id}`, name: "http_fetch", ok: true, result: { url: "https://a.example/1", body: "라".repeat(60_000) }, durationMs: 1 }],
    createdAt: new Date().toISOString(),
  });
  const conversation = {
    id: "c1",
    title: "t",
    model: "m",
    settings: {},
    messages: [
      { id: "u1", role: "user", content: "첫 질문", createdAt: new Date().toISOString() },
      turn("1"),
      { id: "u2", role: "user", content: "둘째 질문", createdAt: new Date().toISOString() },
      turn("2"),
      { id: "u3", role: "user", content: "지금 질문", createdAt: new Date().toISOString() },
    ],
  } as never;
  const built = await buildHistoryMessages(conversation, "owner");
  const tools = built.filter((m) => m.role === "tool");
  const answers = built.filter((m) => m.role === "assistant" && typeof m.content === "string" && m.content.length > 0);
  check("지난 턴 두 개 모두 도구 결과가 실린다", tools.length === 2, String(tools.length));
  check(
    "턴마다 따로 상한 안으로 줄어든다",
    tools.every((m) => String(m.content).length <= PAST_TURN_TOOL_RESULT_CHARS),
    tools.map((m) => String(m.content).length).join(","),
  );
  check("도구 호출과 결과의 짝(id)은 그대로", tools.map((m) => m.tool_call_id).join(",") === "call-1,call-2");
  check("답변 본문은 원문 그대로", answers.length === 2 && answers.every((m) => m.content === answer));
  check("지금 질문은 그대로 맨 끝", built[built.length - 1]?.role === "user" && built[built.length - 1]?.content === "지금 질문");
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
