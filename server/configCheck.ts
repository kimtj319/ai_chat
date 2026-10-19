/**
 * 설정을 읽고 나서 **말이 되는지** 본다.
 *
 * 왜 따로 두는가: config.ts 의 파서들은 무엇이 오든 기본값으로 떨어진다. 그건 의도한
 * 것이다 — 오타 하나로 서비스가 못 뜨는 것보다 낫다는 판단이고, 그 판단은
 * 지금도 유효하다. 문제는 **아무도 모른다**는 것이었다. RAG_DOC_MAX_BYTES=abc
 * 는 조용히 512KB 가 되고, 몇 주 뒤 "왜 큰 문서가 안 올라가지" 로 돌아온다.
 *
 * 그래서 값은 그대로 떨어뜨리되, 떨어졌다는 사실을 기동 때 말한다. 여기서
 * 다시 process.env 를 읽는 이유도 그것이다 — 파서를 거친 뒤의 값은 이미
 * 멀쩡해 보여서, 원본을 봐야 오타를 알 수 있다.
 */
import { isMailAddress } from "./mail/smtp.js";

export interface ConfigProblem {
  key: string;
  value: string;
  message: string;
}

/** ratio0 은 0 도 받는 비율이다 — CONTEXT_COMPACT_RATIO 는 0 이 "압축 끄기" 다. */
type Kind = "int" | "port" | "ratio" | "ratio0" | "ms" | "url" | "bool" | "dir" | "level" | "crash" | "smtpSecure" | "mail";

interface Rule {
  key: string;
  kind: Kind;
}

const RULES: Rule[] = [
  { key: "PORT", kind: "port" },
  { key: "LOG_LEVEL", kind: "level" },
  { key: "CRASH_POLICY", kind: "crash" },
  { key: "SHUTDOWN_GRACE_MS", kind: "int" },
  { key: "DATA_DIR", kind: "dir" },
  { key: "LOG_DIR", kind: "dir" },
  { key: "TOOL_FS_ROOT", kind: "dir" },
  { key: "TOOL_TIMEOUT_MS", kind: "ms" },
  { key: "TOOL_HTTP_TIMEOUT_MS", kind: "ms" },
  { key: "TOOL_MAX_RESULT_BYTES", kind: "int" },
  { key: "TOOL_MAX_ROUNDS", kind: "int" },
  { key: "CONTEXT_TOOL_STOP_RATIO", kind: "ratio" },
  { key: "CONTEXT_COMPACT_RATIO", kind: "ratio0" },
  { key: "CONTEXT_KEEP_RECENT_RATIO", kind: "ratio" },
  { key: "CONTEXT_MAX_COMPACTIONS", kind: "int" },
  { key: "CONTEXT_HISTORY_SUMMARY_RATIO", kind: "ratio" },
  { key: "NORMAL_MODE_DEADLINE_MS", kind: "ms" },
  { key: "ANSWER_NOW_THRESHOLD_MS", kind: "ms" },
  { key: "FEEDBACK_DETECT", kind: "bool" },
  { key: "ATTACHMENT_MAX_IMAGE_BYTES", kind: "int" },
  { key: "ATTACHMENT_MAX_TEXT_BYTES", kind: "int" },
  { key: "ATTACHMENT_INLINE_TEXT_BYTES", kind: "int" },
  { key: "ATTACHMENT_MAX_PER_MESSAGE", kind: "int" },
  { key: "ATTACHMENT_MAX_MESSAGE_BYTES", kind: "int" },
  { key: "ATTACHMENT_MESSAGE_TOKEN_RATIO", kind: "ratio" },
  { key: "ATTACHMENT_DEFAULT_MESSAGE_TOKENS", kind: "int" },
  { key: "ATTACHMENT_MAX_PER_CONVERSATION", kind: "int" },
  { key: "ATTACHMENT_MAX_CONVERSATION_BYTES", kind: "int" },
  { key: "ATTACHMENT_MAX_SESSION_BYTES", kind: "int" },
  { key: "ATTACHMENT_UPLOADS_PER_MINUTE", kind: "int" },
  { key: "ATTACHMENT_MIN_FREE_DISK_BYTES", kind: "int" },
  { key: "MODEL_CAPABILITY_PROBE", kind: "bool" },
  { key: "MCP_DISCOVERY_TTL_MS", kind: "ms" },
  { key: "MCP_TIMEOUT_MS", kind: "ms" },
  { key: "MCP_DEBUG_TOOLS_HASH", kind: "bool" },
  { key: "RAG_ENGINE_URL", kind: "url" },
  { key: "RAG_MCP_URL", kind: "url" },
  { key: "RAG_CHUNK_MODEL_URL", kind: "url" },
  { key: "RAG_DOC_MAX_BYTES", kind: "int" },
  { key: "RAG_PDF_MAX_BYTES", kind: "int" },
  { key: "GITLAB_MCP_URL", kind: "url" },
  { key: "GITLAB_URL", kind: "url" },
  { key: "TAVILY_API_URL", kind: "url" },
  { key: "SESSION_MAX_AGE_HOURS", kind: "int" },
  { key: "COOKIE_SECURE", kind: "bool" },
  { key: "LOGIN_ATTEMPTS_PER_MINUTE", kind: "int" },
  { key: "LOGIN_ATTEMPTS_PER_IP_PER_MINUTE", kind: "int" },
  { key: "APP_BASE_URL", kind: "url" },
  { key: "SMTP_PORT", kind: "port" },
  { key: "SMTP_SECURE", kind: "smtpSecure" },
  { key: "SMTP_TLS_REJECT_UNAUTHORIZED", kind: "bool" },
  { key: "MAIL_FROM", kind: "mail" },
];

function checkValue(rule: Rule, raw: string): string | null {
  switch (rule.kind) {
    case "port": {
      const n = Number.parseInt(raw, 10);
      return Number.isInteger(n) && n > 0 && n < 65536 ? null : "1~65535 사이의 포트여야 합니다";
    }
    case "int": {
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) && n >= 0 ? null : "0 이상의 정수여야 합니다";
    }
    case "ratio": {
      const n = Number.parseFloat(raw);
      return Number.isFinite(n) && n > 0 && n <= 1 ? null : "0 보다 크고 1 이하인 소수여야 합니다";
    }
    case "ratio0": {
      const n = Number.parseFloat(raw);
      return Number.isFinite(n) && n >= 0 && n <= 1 ? null : "0 이상 1 이하인 소수여야 합니다 (0 은 끄기)";
    }
    case "ms": {
      const n = Number(raw);
      if (!Number.isFinite(n)) return "밀리초(숫자)여야 합니다";
      // 파서가 1초 미만을 기본값으로 되돌린다. 값이 살아남지 못한다는 뜻이다.
      return n >= 1000 ? null : "1000ms 이상이어야 합니다 (그보다 작으면 무시됩니다)";
    }
    case "bool":
      return /^(0|1|true|false|yes|no|on|off)$/i.test(raw.trim()) ? null : "true 또는 false 여야 합니다";
    case "url":
      try {
        const u = new URL(raw);
        return u.protocol === "http:" || u.protocol === "https:" ? null : "http 또는 https 주소여야 합니다";
      } catch {
        return "주소 형식이 올바르지 않습니다 (예: http://호스트:포트)";
      }
    case "level":
      return /^(debug|info|warn|error|silent)$/i.test(raw.trim()) ? null : "debug·info·warn·error·silent 중 하나여야 합니다";
    case "crash":
      return /^(exit|keep)$/i.test(raw.trim()) ? null : "exit 또는 keep 이어야 합니다";
    case "smtpSecure":
      // 파서는 모르는 값을 starttls 로 읽는다. "tls" 라고 적은 사람은 465 를 뜻했을 것이다.
      return /^(starttls|ssl|none)$/i.test(raw.trim()) ? null : "starttls·ssl·none 중 하나여야 합니다";
    case "mail":
      return isMailAddress(raw.trim()) ? null : "메일 주소여야 합니다 (예: noreply@example.com) — 이름은 MAIL_FROM_NAME 에";
    case "dir":
      // 있는지까지만 본다. 만들 수 있는지는 실제로 쓸 때 알게 되고, 여기서
      // 디렉터리를 만들어 버리면 오타난 경로가 조용히 생겨난다.
      return raw.trim() ? null : "빈 값일 수 없습니다";
  }
}

/**
 * 기동을 막을 문제와, 알려만 줄 문제를 갈라서 돌려준다.
 *
 * 가르는 기준은 "이대로 뜨면 사람이 속는가" 이다. 오타난 숫자는 기본값으로
 * 돌아 서비스는 되지만 운영자가 설정한 값은 아무 데도 없다 — 그래서 막는다.
 * 반쪽만 채운 설정(주소는 있는데 토큰이 없는 식)도 같은 이유로 막는다:
 * 기능이 조용히 사라지고, 왜 없는지는 아무 데도 안 적힌다.
 */
export function inspectConfig(env: NodeJS.ProcessEnv = process.env): {
  errors: ConfigProblem[];
  warnings: ConfigProblem[];
} {
  const errors: ConfigProblem[] = [];
  const warnings: ConfigProblem[] = [];

  for (const rule of RULES) {
    const raw = env[rule.key];
    // 설정하지 않은 값은 문제가 아니다 — 기본값을 쓰겠다는 뜻이다.
    if (raw === undefined || raw.trim() === "") continue;
    const message = checkValue(rule, raw);
    if (message) errors.push({ key: rule.key, value: raw, message });
  }

  // 짝이 있어야 뜻이 통하는 것들.
  const pairs: Array<[string, string, string]> = [
    ["GITLAB_MCP_URL", "GITLAB_TOKEN", "둘 다 있어야 GitLab MCP 가 등록됩니다"],
    ["RAG_CHUNK_MODEL_URL", "RAG_CHUNK_MODEL", "둘 다 있어야 모델 청킹을 씁니다"],
    // 한쪽만 있으면 답변 알림 메일이 조용히 꺼진 채로 뜬다.
    ["SMTP_HOST", "MAIL_FROM", "둘 다 있어야 답변 알림 메일을 보냅니다"],
    ["SMTP_USER", "SMTP_PASSWORD", "둘 다 있어야 메일 서버에 로그인합니다"],
  ];

  // 관리자 짝은 **막지 않는다**. ensureAdminFromEnv() 는 첫 기동에만 계정을
  // 만들고, 만들고 난 뒤에는 비밀번호를 .env 에서 빼는 것이 옳은 운영이다 —
  // 그 상태를 오류로 보면 정상적으로 굴러가던 서버가 재기동에서 멈춘다.
  // (실제로 107 배포가 이 규칙에 걸려 안 떴다. 규칙 쪽이 틀렸다.)
  if (Boolean(env.ADMIN_ID?.trim()) !== Boolean(env.ADMIN_PASSWORD?.trim())) {
    warnings.push({
      key: env.ADMIN_ID?.trim() ? "ADMIN_PASSWORD" : "ADMIN_ID",
      value: "(비어 있음)",
      message: "한쪽만 설정되어 있습니다 — 관리자 계정이 아직 없다면 만들어지지 않습니다",
    });
  }
  for (const [a, b, why] of pairs) {
    const hasA = Boolean(env[a]?.trim());
    const hasB = Boolean(env[b]?.trim());
    if (hasA !== hasB) {
      errors.push({ key: hasA ? b : a, value: "(비어 있음)", message: `${why} — ${hasA ? a : b} 만 설정되어 있습니다` });
    }
  }

  // 막을 일은 아니지만 말해 둘 것.
  if (env.RAG_MCP_URL?.trim() && !env.MCP_IDENTITY_TOKEN?.trim()) {
    warnings.push({
      key: "MCP_IDENTITY_TOKEN",
      value: "(비어 있음)",
      message: "RAG MCP 는 등록되지만 누가 묻는지 전하지 않아, 모두가 공용 문서만 보게 됩니다",
    });
  }
  if (env.SMTP_USER?.trim() && /^none$/i.test(env.SMTP_SECURE?.trim() ?? "")) {
    warnings.push({
      key: "SMTP_SECURE",
      value: "none",
      message: "메일 서버 비밀번호를 암호화 없이 보냅니다 — 사내망 안의 서버가 아니라면 starttls 나 ssl 을 쓰세요",
    });
  }
  for (const key of ["RAG_MCP_URL", "GITLAB_MCP_URL"]) {
    const raw = env[key]?.trim();
    if (!raw) continue;
    try {
      const host = new URL(raw).hostname.toLowerCase();
      const allowed = (env.MCP_ALLOW_HTTP_HOSTS || "").toLowerCase();
      if (new URL(raw).protocol === "http:" && !allowed.split(",").map((h) => h.trim()).includes(host)) {
        errors.push({
          key: "MCP_ALLOW_HTTP_HOSTS",
          value: env.MCP_ALLOW_HTTP_HOSTS || "(비어 있음)",
          message: `${key} 가 http 인데 ${host} 가 허용 목록에 없습니다 — 이 서버는 호출되지 못합니다`,
        });
      }
    } catch {
      // 주소 형식 문제는 위에서 이미 잡았다.
    }
  }

  return { errors, warnings };
}

/** 기동 직전에 부른다. 문제가 있으면 전부 보여 주고 던진다 — 하나씩 고치게 하지 않는다. */
export function assertConfigValid(env: NodeJS.ProcessEnv = process.env): void {
  const { errors, warnings } = inspectConfig(env);
  for (const w of warnings) console.warn(`[config] 주의  ${w.key}=${w.value} — ${w.message}`);
  if (errors.length === 0) return;
  const lines = errors.map((e) => `  ${e.key}=${e.value} — ${e.message}`);
  throw new Error(`설정에 문제가 ${errors.length}건 있어 기동하지 않습니다.\n${lines.join("\n")}`);
}
