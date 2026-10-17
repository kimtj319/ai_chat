import { readJsonFile, writeJsonFileAtomic } from "../storage/atomic.js";
import { mcpSeedMarkerFile } from "../storage/paths.js";
import { config } from "../config.js";
import { createServer, listServers, updateServer, type CreateServerInput } from "./registryStore.js";

/** Builtins whose shared key toolAdapter swaps for the caller's own (callUrlFor). */
export const GITLAB_SLUG = "gitlab";
export const ALPHAVANTAGE_SLUG = "alphavantage";
export const ALPHAVANTAGE_MCP_URL = "https://mcp.alphavantage.co/mcp";

/**
 * Builtin servers, seeded into DATA_DIR at boot.
 *
 * The same reasoning as {DATA_DIR}/.model (vllm/endpoints.ts): a list baked
 * into the image cannot be edited on the deployment, because only data/ and
 * log/ are bind-mounted. Seeding writes ordinary registry records that an admin
 * can then disable, edit, or delete like any other — and the marker file
 * records which slugs were ever seeded, so a builtin somebody deleted stays
 * deleted instead of reappearing at the next restart.
 *
 * deepwiki, context7 and microsoft-learn are always seeded: they are public and
 * need no credential (deepwiki is the endpoint this integration was verified
 * against), and a feature whose server list starts empty is a feature nobody
 * switches on. Alpha Vantage, the RAG server and GitLab are seeded only when
 * .env supplies what each of them needs.
 */
const BUILTIN_SERVERS: Array<Omit<CreateServerInput, "createdBy">> = [
  {
    name: "DeepWiki",
    slug: "deepwiki",
    description:
      "GitHub 저장소의 문서를 읽고 질문에 답하는 공개 MCP 서버입니다. 저장소 구조 확인, 문서 열람, 자연어 질의를 지원합니다.",
    url: "https://mcp.deepwiki.com/mcp",
    authMode: "none",
    origin: "builtin",
  },
  {
    name: "Context7",
    slug: "context7",
    description:
      "라이브러리와 프레임워크의 최신 공식 문서를 조회하는 공개 MCP 서버입니다. 라이브러리를 먼저 식별한 뒤 그 문서에서 질문에 답합니다.",
    url: "https://mcp.context7.com/mcp",
    authMode: "none",
    origin: "builtin",
  },
  {
    name: "Microsoft Learn",
    slug: "microsoft-learn",
    description:
      "Microsoft 공식 기술 문서와 코드 예제를 검색하고 원문을 가져오는 공개 MCP 서버입니다. Azure, .NET, Windows 문서를 다룹니다.",
    url: "https://learn.microsoft.com/api/mcp",
    authMode: "none",
    origin: "builtin",
  },
  // Alpha Vantage authenticates with a query parameter and accepts no auth
  // header, so its key is part of the URL — routes/mcp.ts is what keeps that
  // query from reaching a client. Without a key there is no entry at all: a
  // builtin that answers every call with "invalid API key" sits in everyone's
  // library looking like a broken feature.
  ...(config.alphavantageApiKey
    ? [
        {
          name: "Alpha Vantage",
          slug: ALPHAVANTAGE_SLUG,
          description:
            "주식 시세·시계열·재무제표·실적·배당·뉴스·환율을 조회하는 금융 데이터 MCP 서버입니다. 미국 시장이 중심이며, 종목 검색과 시장 개장 여부 확인도 지원합니다.",
          // The shared key, for discovery; a call carries the caller's own key
          // (toolAdapter.ts callUrlFor), like the GitLab builtin.
          url: `${ALPHAVANTAGE_MCP_URL}?apikey=${encodeURIComponent(config.alphavantageApiKey)}`,
          authMode: "none" as const,
          origin: "builtin" as const,
          // It offers 133 tools; these are the ones worth a place in every
          // prompt of every turn.
          // Measured against toolAdapter's 8 KB per-server schema budget: all
          // sixteen candidates come to 11,089 bytes, and the budget drops the
          // overflow in ALPHABETICAL order, which silently cost the weekly and
          // monthly series. These eleven come to 7,676, so the cut is made here
          // on usefulness instead. Left out: TIME_SERIES_INTRADAY (1,272 — the
          // most expensive and the least asked for), TOP_GAINERS_LOSERS, and
          // the three full statements (INCOME_STATEMENT, BALANCE_SHEET,
          // CASH_FLOW, 1,707 together), whose headline figures COMPANY_OVERVIEW
          // already carries. Adding one back means taking one out.
          toolAllowlist: [
            "SYMBOL_SEARCH",
            "GLOBAL_QUOTE",
            "MARKET_STATUS",
            "TIME_SERIES_DAILY",
            "TIME_SERIES_WEEKLY",
            "TIME_SERIES_MONTHLY",
            "COMPANY_OVERVIEW",
            "EARNINGS",
            "DIVIDENDS",
            "NEWS_SENTIMENT",
            "CURRENCY_EXCHANGE_RATE",
          ],
        },
      ]
    : []),
  // The RAG server is ours, runs beside the app, and is the one server here
  // that is told who is asking (sendUserIdentity) — which is why its address
  // comes from .env and its definition from code rather than from a form.
  ...(config.ragMcpUrl
    ? [
        {
          name: "사내 문서 검색",
          slug: "sf1rag",
          description:
            "사내 문서를 의미 기반으로 검색해 근거 단락을 돌려주는 RAG 서버입니다. 검색·원문 확대·컬렉션 목록을 지원하며, 각자 볼 수 있는 문서만 검색됩니다.",
          url: config.ragMcpUrl,
          authMode: "none" as const,
          origin: "builtin" as const,
          sendUserIdentity: true,
        },
      ]
    : []),
  // GitLab, for reading the wisenut issue tracker. Both halves are required: the
  // endpoint, and the token that is appended to it here. The token is not on
  // that server — it travels in the URL and is forwarded to GitLab — so the
  // pair is what makes the server usable, and the absence of either would seed
  // an entry whose every call answers "no token".
  //
  // The token in this URL is the shared one, used for discovery (tools/list).
  // A tool CALL swaps in the caller's own GitLab token (mcp/toolAdapter.ts
  // callUrlFor) — only accounts that may use shared resources fall back to
  // this one. sendUserIdentity stays absent: the token already says who asks.
  ...(config.gitlabMcpUrl && config.gitlabToken
    ? [
        {
          name: "wisenut 이슈",
          slug: GITLAB_SLUG,
          description:
            "GitLab 의 wisenut 이슈를 읽습니다. 프로젝트 목록, 제목·본문 부분일치 검색, 담당자·작성자별(내 이슈 포함)·라벨·상태별 목록, 이슈 본문과 댓글 조회를 지원합니다. 읽기 전용이며, 각자 등록한 GitLab 토큰(여러 개 가능)으로 볼 수 있는 프로젝트의 이슈만 검색됩니다.",
          url: `${config.gitlabMcpUrl}?token=${encodeURIComponent(config.gitlabToken)}`,
          authMode: "none" as const,
          origin: "builtin" as const,
        },
      ]
    : []),
];

export async function seedBuiltinServers(): Promise<void> {
  let seeded: string[] = [];
  try {
    seeded = (await readJsonFile<string[]>(mcpSeedMarkerFile())) ?? [];
  } catch (err) {
    console.warn("[mcp] could not read the seed marker; not seeding to avoid re-creating deleted builtins:", err);
    return;
  }
  const existing = await listServers();
  const added: string[] = [];
  const realigned: string[] = [];
  for (const builtin of BUILTIN_SERVERS) {
    const present = existing.find((s) => s.slug === builtin.slug || s.name === builtin.name);
    if (present) {
      // A builtin is defined in code and .env, so the record follows them and
      // not the other way round. Seeding runs once, so without this an edited
      // allowlist or a rotated key would change nothing until someone deleted
      // the record by hand — and the symptom (a tool quietly missing) gives no
      // hint of the cause.
      const sameTools =
        JSON.stringify(present.toolAllowlist ?? []) === JSON.stringify(builtin.toolAllowlist ?? []);
      const sameIdentity = Boolean(present.sendUserIdentity) === Boolean(builtin.sendUserIdentity);
      // A record created through the route before the builtin existed is
      // origin:"user", which means every owner has to adopt it by hand — half a
      // builtin, and the half nobody sees. Adopting it here is what makes the
      // definition in code actually govern the record.
      const sameOrigin = present.origin === (builtin.origin ?? "user");
      // A renamed builtin ("SF-1 이슈" → "wisenut 이슈") is found by its slug and
      // takes the new name and description too.
      const sameText = present.name === builtin.name && (present.description ?? "") === (builtin.description ?? "");
      if (present.url !== builtin.url || !sameTools || !sameIdentity || !sameOrigin || !sameText) {
        const patched = await updateServer(present.id, {
          name: builtin.name,
          description: builtin.description,
          url: builtin.url,
          toolAllowlist: builtin.toolAllowlist ?? [],
          sendUserIdentity: Boolean(builtin.sendUserIdentity),
          ...(builtin.origin ? { origin: builtin.origin } : {}),
        });
        if (patched.ok) realigned.push(builtin.slug);
      }
      if (!seeded.includes(builtin.slug)) seeded.push(builtin.slug);
      continue;
    }
    // Absent but already marked: someone deleted it on purpose. Leave it gone.
    if (seeded.includes(builtin.slug)) continue;
    const created = await createServer({ ...builtin, createdBy: "system" });
    if (created.ok) {
      seeded.push(builtin.slug);
      added.push(`${builtin.name} (${builtin.slug})`);
    } else {
      console.warn(`[mcp] could not seed builtin "${builtin.slug}": ${created.code}`);
    }
  }
  if (realigned.length > 0) {
    console.log(`[mcp] realigned builtin server(s) with the code definition: ${realigned.join(", ")}`);
  }
  if (added.length > 0) {
    await writeJsonFileAtomic(mcpSeedMarkerFile(), seeded);
    console.log(`[mcp] seeded builtin server(s): ${added.join(", ")}`);
  } else if (seeded.length > 0) {
    await writeJsonFileAtomic(mcpSeedMarkerFile(), seeded);
  }
}
