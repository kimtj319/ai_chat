import { createApp } from "./app.js";
import { assertConfigValid, config } from "./config.js";
import { installLifecycle } from "./lifecycle.js";
import { installRequestIdPrefix } from "./log.js";
import { startFileLogging } from "./logFile.js";
import { checkHealth } from "./vllm/client.js";
import { endpointsSource, listEndpoints } from "./vllm/endpoints.js";
import { sweepAllAttachments } from "./storage/attachmentStore.js";
import { sweepEmptyConversations } from "./storage/conversationStore.js";
import { ensureAdminFromEnv } from "./auth/bootstrap.js";
import { seedBuiltinServers } from "./mcp/registryStore.js";
import { warm as warmMcpDiscovery } from "./mcp/discovery.js";

// 무엇이든 기록되기 전에 건다 — 기동 중의 경고도 파일에 남아야 한다.
if (config.logDir) startFileLogging(config.logDir);
// 파일 기록 **뒤에** 건다. 그래야 요청 id 가 stdout 과 파일 양쪽에 남는다.
installRequestIdPrefix();

// 포트를 열기 전에 설정부터 본다. 오타난 값은 기본값으로 떨어져 서비스는
// 되지만 운영자가 정한 값은 아무 데도 없다 — 그 상태로 뜨면 사람이 속는다.
try {
  assertConfigValid();
} catch (err) {
  console.error(`[config] ${(err as Error).message}`);
  process.exit(78); // EX_CONFIG
}

// Before the port opens: with no admin nobody can approve a signup, so this
// must not race the first request.
await ensureAdminFromEnv();

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`[server] listening on 0.0.0.0:${config.port} (http://localhost:${config.port})`);
  console.log(`[server] vLLM base URL: ${config.vllmBaseUrl}`);
  console.log(`[server] data dir: ${config.dataDir}`);

  // One probe per endpoint at boot, so a typo in .model or a host that is down
  // shows up in the log instead of as an empty model picker. Never fatal: a
  // dead endpoint is skipped and the others stay usable.
  console.log(`[server] model endpoints (${endpointsSource()}): ${listEndpoints().length}`);
  void checkHealth()
    .then((health) => {
      for (const endpoint of health.endpoints) {
        console.log(
          `[server] endpoint ${endpoint.ok ? "OK  " : "DOWN"} ${endpoint.label} ${endpoint.baseUrl} ` +
            `(${endpoint.latencyMs}ms) models=${endpoint.models.join(", ") || "-"}`,
        );
      }
    })
    .catch((err) => console.warn("[server] endpoint probe failed:", err));

  // MCP: seed the builtin servers into DATA_DIR (once ever — a builtin someone
  // deleted stays deleted), then discover tools for the servers people actually
  // use. NEVER awaited and never fatal: a turn reads the discovery cache and
  // simply finds it empty until this lands, which costs one turn's tools, not
  // the boot.
  void seedBuiltinServers()
    .then(() => warmMcpDiscovery())
    .catch((err) => console.warn("[server] MCP discovery warm-up failed:", err));

  // A chat window that was opened and never used leaves a record behind, and
  // nothing else removes it: 91 of them against 6 real conversations after one
  // day here. Runs after the attachment sweep on purpose — deleting the
  // conversation takes its attachments with it, so the sweep has less to walk.
  void sweepEmptyConversations()
    .then(({ removed, owners }) => {
      if (removed > 0) {
        console.log(`[server] empty-conversation sweep: removed ${removed} across ${owners} owner(s)`);
      }
    })
    .catch((err) => console.warn("[server] empty-conversation sweep failed:", err));

  // Uploads that were never attached to a message outlive the browser that made
  // them; nothing else would ever delete those bytes.
  void sweepAllAttachments()
    .then(({ removed, conversations }) => {
      if (removed > 0 || conversations > 0) {
        console.log(`[server] attachment sweep: removed ${removed} orphan(s) across ${conversations} conversation(s)`);
      }
    })
    .catch((err) => console.warn("[server] attachment sweep failed:", err));
});

// 서버가 무엇을 듣고 있는지 알아야 "듣기를 멈추는" 종료가 가능하다.
installLifecycle(server);
