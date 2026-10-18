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

// 흐르는 답을 다른 대화에 갔다가 다시 열었다. 서버에서 다시 불러온 대화에는 아직 답이
// 없으니, 다음 조각은 자리를 새로 만들어야 한다 — 예전에는 조각도 done 도 버려져
// 새로 고칠 때까지 답이 안 보였다.
{
  const msg = (id: string, content: string) => ({ id, role: "assistant" as const, content, createdAt: "2026-01-01T00:00:00.000Z" });
  const reopened = run(base(), { type: "SET_ACTIVE_ID", id: "A" }, { type: "SET_ACTIVE_CONVERSATION", conversation: conversation("A", "m") });
  const first = reducer(reopened, { type: "UPSERT_ACTIVE_MESSAGE", conversationId: "A", matchIds: ["tmp"], message: msg("tmp", "부분") });
  check("없는 자리는 덧붙인다", first.activeConversation?.messages.map((m) => m.content).join() === "부분");
  const second = reducer(first, { type: "UPSERT_ACTIVE_MESSAGE", conversationId: "A", matchIds: ["tmp"], message: msg("tmp", "부분 더") });
  check("있는 자리는 바꾼다", second.activeConversation?.messages.map((m) => m.content).join() === "부분 더");
  const done = reducer(second, { type: "UPSERT_ACTIVE_MESSAGE", conversationId: "A", matchIds: ["tmp", "final"], message: msg("final", "끝") });
  check("done 은 임시 자리를 대신한다", done.activeConversation?.messages.map((m) => m.id).join() === "final");
  // 다시 불러온 대화가 이미 저장된 답을 들고 있다(done 보다 GET 이 먼저 끝났다).
  const loadedFinal = run(
    base(),
    { type: "SET_ACTIVE_ID", id: "A" },
    { type: "SET_ACTIVE_CONVERSATION", conversation: { ...conversation("A", "m"), messages: [msg("final", "끝")] } as never },
    { type: "UPSERT_ACTIVE_MESSAGE", conversationId: "A", matchIds: ["tmp", "final"], message: msg("final", "끝") },
  );
  check("이미 있는 답은 두 번 붙지 않는다", loadedFinal.activeConversation?.messages.length === 1, String(loadedFinal.activeConversation?.messages.length));
  const other = reducer(reopened, { type: "UPSERT_ACTIVE_MESSAGE", conversationId: "B", matchIds: ["x"], message: msg("x", "남의 것") });
  check("다른 대화의 조각은 지금 대화에 붙지 않는다", other.activeConversation?.messages.length === 0);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) throw new Error(`${failures.length} check(s) failed`);
