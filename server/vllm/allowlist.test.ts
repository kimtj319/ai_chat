// 엔드포인트별 모델 허용 목록 검사. `npm test` 로 돈다.
//
// 보려는 것: OpenRouter 처럼 모델을 수백 개 내주는 서버를 붙여도 고른 모델만 목록에
// 오르고 **고른 모델만 탐침된다**(탐침은 모델마다 채팅 요청 한 번 — 유료 모델이면 돈이 든다).
// 그리고 OpenRouter 의 목록 모양({data:[...]}, object 없음, context_length)을 받아들이되
// HTML 같은 엉뚱한 응답은 여전히 거절하는지.
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "allowlist-test-"));
process.env.DATA_DIR = dataDir;
// Set, not deleted: the .env loader fills in only what is missing, and this test
// must not reach the real serving hosts listed there.
process.env.VLLM_ENDPOINTS = "";
process.env.VLLM_BASE_URL = "http://127.0.0.1:9/v1";
process.env.MODEL_ENDPOINTS_FILE = "";

const { parseEndpointEntries } = await import("../config.js");
const { probeEndpoint, upsertFileEndpoint, listEndpoints } = await import("./endpoints.js");
const { fetchCatalog } = await import("./client.js");

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

/** A fake OpenAI-compatible server: GET /v1/models answers `models`, chat answers 200. */
async function fakeServer(models: unknown, chatHits: string[]): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/v1/models") {
        res.setHeader("content-type", typeof models === "string" ? "text/html" : "application/json");
        res.end(typeof models === "string" ? models : JSON.stringify(models));
        return;
      }
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        chatHits.push(String(JSON.parse(raw || "{}").model));
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, close: () => server.close() };
}

console.log("allow list — config.parseEndpointEntries / endpoints / client.fetchCatalog");

try {
  // ---- parsing
  const [withKey] = parseEndpointEntries(["OR|https://openrouter.ai/api/v1|sk-x|a/b;c/d:free"], "");
  check("넷째 칸이 모델 목록이 된다", JSON.stringify(withKey?.models) === JSON.stringify(["a/b", "c/d:free"]), JSON.stringify(withKey));
  check("  키는 셋째 칸 그대로", withKey?.apiKey === "sk-x");
  const [noKey] = parseEndpointEntries(["OR|https://x/v1||m1 m2;m1"], "fallback");
  check("키 칸이 비면 기본 키를 쓰고 목록은 공백·; 로 가르며 중복을 지운다", noKey?.apiKey === "fallback" && JSON.stringify(noKey?.models) === '["m1","m2"]', JSON.stringify(noKey));
  const [plain] = parseEndpointEntries(["Local|http://h:1/v1"], "");
  check("넷째 칸이 없으면 models 도 없다(= 전부)", plain && plain.models === undefined, JSON.stringify(plain));

  // ---- probe: OpenRouter shape accepted, junk refused
  const hits: string[] = [];
  const openrouterish = await fakeServer({ data: [{ id: "x/one", context_length: 32000 }, { id: "x/two" }, { id: "x/three" }] }, hits);
  const probe = await probeEndpoint(openrouterish.url);
  check("object 없는 {data:[...]} 목록도 받아들인다", probe.ok && probe.models.length === 3, JSON.stringify(probe));
  check("  context_length 를 컨텍스트 길이로 읽는다", probe.maxModelLen === 32000, String(probe.maxModelLen));
  const html = await fakeServer("<!doctype html><html></html>", []);
  const htmlProbe = await probeEndpoint(html.url);
  check("HTML 은 여전히 거절한다", !htmlProbe.ok && htmlProbe.code === "not_vllm", JSON.stringify(htmlProbe));
  html.close();
  const notList = await fakeServer({ object: "model", data: [{ id: "a" }] }, []);
  const notListProbe = await probeEndpoint(notList.url);
  check("object 가 list 가 아니면 거절한다", !notListProbe.ok, JSON.stringify(notListProbe));
  notList.close();

  // ---- file round trip + catalog filter
  await upsertFileEndpoint({ label: "OpenRouterish", baseUrl: openrouterish.url, apiKey: "", models: ["x/one"] });
  const written = await fs.readFile(path.join(dataDir, ".model"), "utf8");
  check("파일에 label|url||models 로 쓴다", written.includes(`OpenRouterish|${openrouterish.url}||x/one`), written);
  const listed = listEndpoints().find((e) => e.baseUrl === openrouterish.url);
  check("  다시 읽으면 허용 목록이 살아 있다", JSON.stringify(listed?.models) === '["x/one"]', JSON.stringify(listed));

  const catalog = await fetchCatalog(undefined, true);
  const ids = catalog.filter((e) => e.baseUrl === openrouterish.url).map((e) => e.id);
  check("목록에는 고른 모델만 오른다", JSON.stringify(ids) === '["x/one"]', JSON.stringify(ids));
  check("  탐침도 고른 모델만 받는다(나머지 둘에는 요청이 가지 않는다)", JSON.stringify([...new Set(hits)]) === '["x/one"]', JSON.stringify(hits));
  check("  카탈로그도 context_length 를 쓴다", catalog.find((e) => e.id === "x/one")?.maxModelLen === 32000);

  await upsertFileEndpoint({ label: "OpenRouterish", baseUrl: openrouterish.url, apiKey: "" });
  const reread = listEndpoints().find((e) => e.baseUrl === openrouterish.url);
  check("허용 목록을 비우면 줄이 label|url 로 돌아간다", reread?.models === undefined, JSON.stringify(reread));
  openrouterish.close();
} finally {
  await fs.rm(dataDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) throw new Error(`${failures.length} check(s) failed`);
