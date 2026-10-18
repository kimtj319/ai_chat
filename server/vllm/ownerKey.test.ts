// 기본(wise) 모델의 키: AI Product 가 아니면 본인 키로(vllm/access.ts endpointForOwner, routes/me.ts).
// `npm test` 로 돈다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-web-owner-key-test-"));
process.on("exit", () => fs.rmSync(dataDir, { recursive: true, force: true }));
process.env.DATA_DIR = dataDir;
process.env.VLLM_ENDPOINTS = "wise|http://mock-wise/v1|shared-wise-key";
process.env.VLLM_API_KEY = "";
process.env.MODEL_CAPABILITY_PROBE = "0";
delete process.env.PRIVILEGED_GROUPS;

const { config } = await import("../config.js");
const { endpointForOwner, ModelKeyRequiredError } = await import("./access.js");
const { createUser, setUserGroup } = await import("../storage/userStore.js");
const { createGroup } = await import("../storage/groupStore.js");
const { setPersonalKey, getPersonalKey } = await import("../storage/personalKeys.js");
const { meRouter } = await import("../routes/me.js");

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

// 게이트웨이: 맞는 키에만 모델 목록을 준다.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url === "http://mock-wise/v1/models") {
    const auth = new Headers(init?.headers).get("authorization");
    if (auth === "Bearer good-wise-key" || auth === "Bearer shared-wise-key") {
      return new Response(JSON.stringify({ object: "list", data: [{ id: "wise-model", max_model_len: 1000 }] }));
    }
    return new Response(JSON.stringify({ error: "invalid key" }), { status: 401 });
  }
  return realFetch(input, init);
}) as typeof fetch;

for (const id of ["admin1", "aip1", "bob", "carol"]) {
  await createUser({ id, name: id, email: `${id}@example.com`, password: "password-1234", status: "active", role: id === "admin1" ? "admin" : "user" });
}
const aip = await createGroup("AI Product", "admin1");
if (!aip.ok) throw new Error("group setup failed");
await setUserGroup("aip1", aip.group.id);

const wise = config.vllmEnvEndpoints[0]!;
check("기본 엔드포인트에 공용 키가 있다(시험 준비)", wise.apiKey === "shared-wise-key", String(wise.apiKey));

const keyOf = async (ownerId: string) => {
  try {
    return (await endpointForOwner(wise, ownerId)).apiKey;
  } catch (err) {
    return err instanceof ModelKeyRequiredError ? "REQUIRED" : `ERR ${(err as Error).message}`;
  }
};
check("AI Product 구성원은 공용 키", (await keyOf("aip1")) === "shared-wise-key");
check("관리자도 공용 키(다른 개인 키와 같은 규칙)", (await keyOf("admin1")) === "shared-wise-key");
check("그 밖의 계정은 본인 키가 없으면 쓸 수 없다", (await keyOf("bob")) === "REQUIRED");
await setPersonalKey("bob", "wise", "bob-own-wise-key");
check("본인 키를 등록하면 그 키로 보낸다", (await keyOf("bob")) === "bob-own-wise-key");
await setPersonalKey("aip1", "wise", "aip-own-wise-key");
check("공용 키를 쓸 수 있어도 본인 키가 있으면 본인 키가 먼저", (await keyOf("aip1")) === "aip-own-wise-key");
const own = { label: "mine", baseUrl: "http://mock-carol/v1", apiKey: "carol-endpoint-key" };
check("본인이 등록한 엔드포인트는 그 엔드포인트의 키 그대로", (await endpointForOwner(own, "carol")).apiKey === "carol-endpoint-key");
check("원래 엔드포인트 객체는 바꾸지 않는다", wise.apiKey === "shared-wise-key");
const message = await endpointForOwner(wise, "carol").then(() => "", (err: Error) => err.message);
check("거절 문구는 어디서 키를 넣는지 알려 준다", message.includes("개인 키") && message.includes("wise"), message);

// 저장할 때 게이트웨이에 물어 맞지 않는 키는 받지 않는다.
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as unknown as { ownerId: string }).ownerId = "carol";
  (req as unknown as { user: unknown }).user = { id: "carol", role: "user", status: "active" };
  next();
});
app.use("/api", meRouter);
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
const put = (value: string) =>
  realFetch(`${base}/me/keys/wise`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value }) });
const bad = await put("wrong-wise-key-123");
check("게이트웨이가 거절하는 키는 400", bad.status === 400, String(bad.status));
check("…저장하지 않는다", (await getPersonalKey("carol", "wise")) === null);
const good = await put("good-wise-key");
check("맞는 키는 저장한다", good.status === 200 && (await getPersonalKey("carol", "wise")) === "good-wise-key", String(good.status));

server.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
