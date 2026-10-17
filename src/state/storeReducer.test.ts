// 대화 상태 리듀서의 경합 규칙 검사. 늦게 도착한 응답이 지금 열린 다른 대화를
// 건드리지 않아야 한다. `npx tsx src/state/storeReducer.test.ts` 로 돈다.
import type { Conversation } from "../api/types";
import { reducer, type Action, type State } from "./storeReducer";

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

function conversation(id: string, model: string): Conversation {
  return {
    id,
    title: id,
    model,
    kind: "chat",
    systemPrompt: "",
    settings: {} as Conversation["settings"],
    enabledTools: [],
    messages: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as unknown as Conversation;
}

function base(): State {
  return {
    ui: {} as State["ui"],
    session: null,
    conversations: [],
    conversationsLoading: false,
    conversationsError: null,
    activeConversationId: null,
    activeConversation: null,
    activeConversationLoading: false,
    activeConversationError: null,
  };
}

function run(state: State, ...actions: Action[]): State {
  return actions.reduce(reducer, state);
}

console.log("src/state/storeReducer.ts");

// E9: A 를 열다가 B 로 옮겼는데 A 의 실패가 늦게 온다.
{
  const state = run(
    base(),
    { type: "SET_ACTIVE_ID", id: "A" },
    { type: "SET_ACTIVE_LOADING" },
    { type: "SET_ACTIVE_ID", id: "B" },
    { type: "SET_ACTIVE_LOADING" },
    { type: "SET_ACTIVE_ERROR", id: "A", error: "A 실패" },
  );
  check("다른 대화의 늦은 오류는 지금 대화에 붙지 않는다", state.activeConversationError === null, String(state.activeConversationError));
  check("다른 대화의 늦은 오류는 지금 대화의 로딩을 끝내지 않는다", state.activeConversationLoading === true);
  const own = reducer(state, { type: "SET_ACTIVE_ERROR", id: "B", error: "B 실패" });
  check("자기 대화의 오류는 보인다", own.activeConversationError === "B 실패" && !own.activeConversationLoading);
}

// E9: 불러오는 중인 대화를 지우면(활성 id 가 null) 로딩도 끝난다.
{
  const state = run(base(), { type: "SET_ACTIVE_ID", id: "A" }, { type: "SET_ACTIVE_LOADING" }, { type: "SET_ACTIVE_ID", id: null });
  check("활성 대화를 비우면 로딩 표시도 꺼진다", state.activeConversationLoading === false);
}

// E10: A 에서 고른 모델의 PATCH 응답이 B 를 연 뒤에 도착한다.
{
  const state = run(
    base(),
    { type: "SET_ACTIVE_ID", id: "B" },
    { type: "SET_ACTIVE_CONVERSATION", conversation: conversation("B", "model-b") },
    { type: "PATCH_ACTIVE_META", conversationId: "A", patch: { model: "model-a", updatedAt: "2026-02-02T00:00:00.000Z" } },
  );
  check("다른 대화의 메타 변경은 지금 대화에 섞이지 않는다", state.activeConversation?.model === "model-b", String(state.activeConversation?.model));
  check("다른 대화의 updatedAt 도 섞이지 않는다", state.activeConversation?.updatedAt === "2026-01-01T00:00:00.000Z");
  const own = reducer(state, { type: "PATCH_ACTIVE_META", conversationId: "B", patch: { model: "model-c" } });
  check("자기 대화의 메타 변경은 반영된다", own.activeConversation?.model === "model-c");
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) throw new Error(`${failures.length} check(s) failed`);
