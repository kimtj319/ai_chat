// thinking_token_budget 이 끊은 생각이 답변으로 새는 것을 되돌리는 검사. `npm test` 로 돈다.
const { BudgetLeakGate, looksCut } = await import("./budgetLeak.js");

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

console.log("server/chat/budgetLeak.ts");

/** 델타를 잘게 쪼개 흘려 보낸다(실제 스트림처럼). */
function run(gate: InstanceType<typeof BudgetLeakGate>, text: string, step = 7) {
  let reasoning = "";
  let content = "";
  for (let i = 0; i < text.length; i += step) {
    const out = gate.feed(text.slice(i, i + step));
    reasoning += out.reasoning;
    content += out.content;
  }
  const out = gate.end();
  return { reasoning: reasoning + out.reasoning, content: content + out.content };
}

const question = "opencode 설정에 vLLM 모델을 추가하려면 어떻게 해야 해?";

// 운영 서버에 2026-09-16 저장된 답변의 모양을 줄인 것.
{
  const reasoning = "The user wants an opencode config. One more thing: for the small model, thinking off is faster.\n\nShould I also add `top";
  const leaked =
    "` etc. for the small model? Keep it minimal.\n\nTimeouts: they already have timeout 600000 — keep.\n\n```json\n{\n  \"enable_thinking\": false\n}\n```\n\nWait — for the fast variant, preserve_thinking false is fine.\n\n";
  const answer = "아래처럼 설정 파일에 모델을 추가하면 됩니다.\n\n1. **provider**: vllm 을 추가합니다.\n\n```json\n{ \"model\": \"x\" }\n```\n";
  const gate = new BudgetLeakGate({ budgetSet: true, reasoning, question });
  check("끊긴 영어 생각 + 한국어 질문이면 붙잡는다", gate.holding);
  const out = run(gate, leaked + answer);
  check("새어 나온 생각은 reasoning 으로 간다", out.reasoning.startsWith("` etc.") && out.reasoning.includes("preserve_thinking"), JSON.stringify(out.reasoning.slice(0, 80)));
  check("…생각 속 코드 블록도 생각과 함께 간다", out.reasoning.includes('"enable_thinking"') && !out.content.includes("enable_thinking"));
  check("답변은 첫 한국어 문단부터", out.content.startsWith("아래처럼 설정 파일에"), JSON.stringify(out.content.slice(0, 40)));
  check("…답변 속 코드 블록은 그대로", out.content.includes('{ "model": "x" }'));
}

// 실측(2026-10-16, 27B·Flash-Next, budget 120): 끊긴 뒤 바로 한국어 답변.
{
  const gate = new BudgetLeakGate({ budgetSet: true, reasoning: "Compute modulo 1000. Could use CRT mod 8 and 125. Since ", question: "17의 23제곱의 마지막 세 자리를 구해줘" });
  const answer = "\n\n17의 23제곱의 마지막 세 자리는 **377**입니다.\n\n## 1. 문제\n\n...";
  const out = run(gate, answer);
  check("끊긴 뒤 바로 답하면 답변을 그대로 내보낸다", out.content.startsWith("17의 23제곱") && out.reasoning === "", JSON.stringify(out));
}

{
  const gate = new BudgetLeakGate({ budgetSet: true, reasoning: "Let me answer in Korean.", question });
  check("생각이 문장으로 끝났으면 붙잡지 않는다", !gate.holding);
  check("…첫 델타부터 그대로 흘린다", gate.feed("Hello").content === "Hello");
}

check("예산이 없으면 붙잡지 않는다", !new BudgetLeakGate({ budgetSet: false, reasoning: "cut mid", question }).holding);
check("영어 질문이면 붙잡지 않는다(언어로 가를 수 없다)", !new BudgetLeakGate({ budgetSet: true, reasoning: "cut mid", question: "How do I add a model?" }).holding);
check("한국어로 생각했으면 붙잡지 않는다", !new BudgetLeakGate({ budgetSet: true, reasoning: "사용자가 설정을 묻고 있으니 먼저", question }).holding);

{
  const gate = new BudgetLeakGate({ budgetSet: true, reasoning: "Need to check the", question });
  const out = run(gate, "docs first. Then decide.\n\nOK the config is done");
  check("끝까지 한국어 답이 없으면 전부 생각으로 둔다(빈 답변 마무리가 이어 쓴다)", out.content === "" && out.reasoning.includes("config is done"));
}

check("끊김 판정: 단어 중간", looksCut("Should I also add `top") && looksCut("Mod 1"));
check("끊김 판정: 문장 끝은 아님", !looksCut("That is all.") && !looksCut("Done!\n\n"));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
