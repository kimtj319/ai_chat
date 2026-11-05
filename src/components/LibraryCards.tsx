import { useState } from "react";
import type { McpHealth, McpServerSummary } from "../api/types";
import { AUTH_MODE_LABELS, healthIsBad, healthLabel, hostOf, shortToolName } from "../mcp/rules";
import { MISSING_KEY_NOTICE } from "../hooks/useMyAccess";
import { probeErrorSummary } from "../mcp/probeError";
import { formatDateTime } from "../state/dateTime";
import { ConfirmDialog } from "./ConfirmDialog";

/* 커넥터(라이브러리) 화면의 서버 카드: 내 서버(LibraryCard)와 다른 사람이 올린 서버(SharedCard). */

function HealthLine({ health }: { health: McpHealth }) {
  const tone = healthIsBad(health.state) ? "danger" : health.state === "ok" ? "ok" : "unknown";
  const summary = probeErrorSummary(health.error);
  return (
    // <p> 가 아니라 <div>: 원문을 접어 둔 <details> 를 안에 둘 수 있어야 한다.
    <div className="library-health" data-tone={tone}>
      <span className="library-health-dot" aria-hidden="true" />
      <span>
        {healthLabel(health.state)}
        {typeof health.toolCount === "number" && ` · 도구 ${health.toolCount}개`}
        {health.checkedAt && ` · ${formatDateTime(health.checkedAt)} 확인`}
      </span>
      {/* Unfolded, not behind a disclosure: when a server is unhealthy the
          reason is the only thing that tells you whether it is yours to fix.
          아는 원문은 한국어 한 줄로 바꿔 보이고, 원문은 '자세히' 에 남긴다 — 관리자에게
          그대로 전할 수 있게. */}
      {health.error && <span className="library-health-error">{summary ?? health.error}</span>}
      {health.error && summary && (
        <details className="library-health-raw">
          <summary>자세히</summary>
          <code>{health.error}</code>
        </details>
      )}
    </div>
  );
}

function ServerMeta({ server }: { server: McpServerSummary }) {
  return (
    <dl className="library-meta">
      <div>
        <dt>호스트</dt>
        <dd>{server.host || hostOf(server.url)}</dd>
      </div>
      <div>
        <dt>전송</dt>
        <dd>{server.transport || "-"}</dd>
      </div>
      <div>
        <dt>인증</dt>
        <dd>
          {AUTH_MODE_LABELS[server.authMode] ?? server.authMode}
          {server.authHeaderName ? ` (${server.authHeaderName})` : ""}
        </dd>
      </div>
      <div>
        <dt>도구</dt>
        <dd>{server.tools.length}개</dd>
      </div>
    </dl>
  );
}

interface LibraryCardProps {
  server: McpServerSummary;
  /** True when the signed-in user registered it themselves. */
  owned: boolean;
  /** True when this account has no key for a server that needs one. */
  keyMissing: boolean;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onProbe: () => void;
  /** Takes it out of this user's connectors entirely (un-adopts it). Null for a
   *  builtin or a server this user registered — for those, the switch above
   *  is the only on/off there is; there is no "out of the library" for them. */
  onRemove: (() => void) | null;
  /** Atlassian 은 이메일을 함께 보낸다(서버가 Basic 인증을 만든다). */
  onSaveCredential: (credential: string | null, atlassianEmail?: string) => void;
  /** Atlassian 로그인 시작 — 승인 페이지 주소, 실패하면 null(오류는 페이지가 보여 준다). */
  onStartAtlassianLogin: () => Promise<string | null>;
  /** 승인 뒤 이동한 주소로 로그인을 마친다. 성공하면 true. */
  onFinishAtlassianLogin: (url: string) => Promise<boolean>;
  /** 등록한 사람·관리자만. 도구 이름(원래 이름) 목록, null 은 기본값으로. */
  onSaveToolSelection: ((selection: string[] | null) => void) | null;
  /** Null for everyone who is not an administrator. */
  onAdminSetStatus: ((disabled: boolean) => void) | null;
}

export function LibraryCard({
  server,
  owned,
  keyMissing,
  busy,
  onEdit,
  onDelete,
  onProbe,
  onRemove,
  onSaveCredential,
  onStartAtlassianLogin,
  onFinishAtlassianLogin,
  onSaveToolSelection,
  onAdminSetStatus,
}: LibraryCardProps) {
  const [credentialOpen, setCredentialOpen] = useState(false);
  const [credential, setCredential] = useState("");
  const [atlassianEmail, setAtlassianEmail] = useState("");
  const [toolsShown, setToolsShown] = useState(false);
  // 개인 키 삭제는 한 번 묻는다. 저장한 키는 다시 보이지 않아 잘못 누르면 새로 받아 와야 한다.
  const [confirmCredentialDelete, setConfirmCredentialDelete] = useState(false);
  const needsCredential = server.requiresCredential && !server.hasCredential;
  // Atlassian 로그인: 승인 창을 연 뒤, 이동한 주소를 붙여 넣어 마친다(server/mcp/atlassianOAuth.ts).
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [pastedUrl, setPastedUrl] = useState("");

  async function beginAtlassianLogin() {
    // 클릭 직후 창을 먼저 연다 — 주소를 받은 뒤에 열면 팝업 차단에 걸린다.
    const popup = window.open("", "_blank");
    setLoginOpen(true);
    setLoginUrl(null);
    setPastedUrl("");
    setCredentialOpen(false);
    const url = await onStartAtlassianLogin();
    if (!url) {
      popup?.close();
      setLoginOpen(false);
      return;
    }
    setLoginUrl(url);
    if (popup) {
      popup.opener = null;
      popup.location.href = url;
    }
  }

  return (
    <div className="library-detail">
      {keyMissing && (
        <p className="library-warning" role="note">
          {MISSING_KEY_NOTICE}
        </p>
      )}

      <ServerMeta server={server} />
      <HealthLine health={server.health} />

      {needsCredential && (
        <p className="library-warning">
          {server.atlassian
            ? "Atlassian 로그인이 필요합니다. 로그인하기 전에는 도구가 실행되지 않습니다."
            : "이 서버는 개인 키가 필요합니다. 입력하기 전에는 도구가 실행되지 않습니다."}
        </p>
      )}
      {server.atlassianAuth === "oauth" && <p className="library-connected">Atlassian 계정으로 로그인되어 있습니다.</p>}
      {server.atlassianAuth === "token" && (
        <p className="library-connected">
          API 토큰으로 연결되어 있습니다. 조직에서 API 토큰 접속을 허용하지 않으면 도구 호출이 거절되니, 그때는 "Atlassian 로그인"을 쓰세요.
        </p>
      )}

      {loginOpen && (
        <div className="library-atlassian-login" role="group" aria-label="Atlassian 로그인">
          <ol>
            <li>
              새 창의 Atlassian 화면에서 사이트를 고르고 <strong>Accept(허용)</strong>를 누릅니다.
              {loginUrl ? (
                <>
                  {" "}창이 열리지 않았다면{" "}
                  <a href={loginUrl} target="_blank" rel="noopener noreferrer">
                    여기를 눌러 여세요
                  </a>
                  .
                </>
              ) : (
                " 승인 주소를 준비하는 중…"
              )}
            </li>
            <li>
              허용 뒤 "연결할 수 없음" 같은 화면이 나오는 것이 정상입니다. 그 창 <strong>주소창의 주소 전체</strong>(127.0.0.1 로 시작)를 복사해 아래에 붙여 넣으세요.
            </li>
          </ol>
          <div className="library-credential">
            <input
              id={`atlassian-login-url-${server.id}`}
              type="text"
              autoComplete="off"
              placeholder="http://127.0.0.1:33418/atlassian/callback?code=…"
              aria-label="승인 뒤 이동한 주소"
              value={pastedUrl}
              onChange={(event) => setPastedUrl(event.target.value)}
            />
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy || !loginUrl || pastedUrl.trim().length === 0}
              onClick={async () => {
                if (await onFinishAtlassianLogin(pastedUrl.trim())) {
                  setLoginOpen(false);
                  setPastedUrl("");
                }
              }}
            >
              연결 완료
            </button>
            <button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={() => setLoginOpen(false)}>
              취소
            </button>
          </div>
        </div>
      )}

      {/* 도구 이름 칩은 접어 둔다. 펼친 카드 한 장에 칩이 서너 줄 깔리면 설명·상태·버튼을
          모두 밀어내 카드가 화면의 3분의 1을 차지했다. 전체 목록과 설명은 도구 설정에도 있다. */}
      {server.tools.length > 0 && (
        <button
          type="button"
          className="library-tools-toggle"
          aria-expanded={toolsShown}
          onClick={() => setToolsShown((shown) => !shown)}
        >
          {toolsShown
            ? "도구 목록 접기"
            : `도구 ${server.tools.length}개 보기 · ${server.tools.filter((tool) => tool.selected !== false).length}개 사용`}
        </button>
      )}
      {server.tools.length > 0 && toolsShown && onSaveToolSelection && (
        <ToolChooser server={server} busy={busy} onSave={onSaveToolSelection} />
      )}
      {server.tools.length > 0 && toolsShown && !onSaveToolSelection && (
        <ul className="library-tool-chips">
          {server.tools.map((tool) => (
            <li key={tool.name} data-off={tool.selected === false ? "" : undefined}>
              <code data-tooltip={tool.selected === false ? `${tool.description} (사용하지 않음)` : tool.description}>
                {shortToolName(tool.name)}
              </code>
            </li>
          ))}
        </ul>
      )}

      {credentialOpen && (
        <div className="library-credential">
          {server.atlassian && (
            <input
              type="email"
              autoComplete="off"
              placeholder="Atlassian 계정 이메일"
              aria-label={`${server.name} Atlassian 계정 이메일`}
              value={atlassianEmail}
              onChange={(event) => setAtlassianEmail(event.target.value)}
            />
          )}
          <input
            type="password"
            autoComplete="off"
            placeholder={server.atlassian ? "API 토큰" : undefined}
            aria-label={server.atlassian ? `${server.name} API 토큰` : `${server.name} 개인 키`}
            value={credential}
            onChange={(event) => setCredential(event.target.value)}
          />
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy || credential.trim().length === 0 || (server.atlassian && atlassianEmail.trim().length === 0)}
            onClick={() => {
              onSaveCredential(credential.trim(), server.atlassian ? atlassianEmail.trim() : undefined);
              setCredential("");
              setCredentialOpen(false);
            }}
          >
            저장
          </button>
          {server.hasCredential && (
            <button
              type="button"
              className="btn btn-sm btn-danger-quiet"
              disabled={busy}
              onClick={() => setConfirmCredentialDelete(true)}
            >
              삭제
            </button>
          )}
        </div>
      )}

      <div className="library-actions">
        <button type="button" className="btn btn-sm" disabled={busy} onClick={onProbe}>
          연결 확인
        </button>
        {server.atlassian && (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void beginAtlassianLogin()}>
            {server.atlassianAuth === "oauth" ? "다시 로그인" : "Atlassian 로그인"}
          </button>
        )}
        {server.authMode === "header" && (
          <button
            type="button"
            className={server.atlassian ? "btn btn-sm btn-secondary" : "btn btn-sm"}
            disabled={busy}
            onClick={() => {
              setLoginOpen(false);
              setCredentialOpen((open) => !open);
            }}
          >
            {server.atlassian
              ? server.atlassianAuth === "token"
                ? "API 토큰 변경"
                : "API 토큰으로 연결"
              : server.hasCredential
                ? "개인 키 변경"
                : "개인 키 입력"}
          </button>
        )}
        {server.atlassianAuth === "oauth" && (
          <button type="button" className="btn btn-sm btn-danger-quiet" disabled={busy} onClick={() => setConfirmCredentialDelete(true)}>
            로그아웃
          </button>
        )}
        {owned && (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={onEdit}>
            수정
          </button>
        )}
        {onRemove && (
          <button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={onRemove}>
            내 커넥터에서 빼기
          </button>
        )}
        {owned && (
          <button type="button" className="btn btn-sm btn-danger-quiet" disabled={busy} onClick={onDelete}>
            삭제
          </button>
        )}
        {onAdminSetStatus && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() => onAdminSetStatus(server.status !== "disabled")}
          >
            {server.status === "disabled" ? "다시 활성화" : "비활성화"}
          </button>
        )}
      </div>

      {confirmCredentialDelete && (
        <ConfirmDialog
          title={server.atlassianAuth === "oauth" ? `${server.name}에서 로그아웃할까요?` : `${server.name} 개인 키를 삭제할까요?`}
          message={
            server.atlassianAuth === "oauth"
              ? "로그아웃하면 이 커넥터의 도구가 실행되지 않습니다. 다시 쓰려면 'Atlassian 로그인'을 다시 하면 됩니다."
              : "키를 지우면 이 서버의 도구가 실행되지 않습니다. 저장한 키는 다시 보여 주지 않으므로, 다시 쓰려면 키를 새로 붙여 넣어야 합니다."
          }
          confirmLabel={server.atlassianAuth === "oauth" ? "로그아웃" : "삭제"}
          danger
          onCancel={() => setConfirmCredentialDelete(false)}
          onConfirm={() => {
            setConfirmCredentialDelete(false);
            onSaveCredential(null);
            setCredential("");
            setCredentialOpen(false);
          }}
        />
      )}
    </div>
  );
}

interface SharedCardProps {
  server: McpServerSummary;
  busy: boolean;
  onAdminSetStatus: ((disabled: boolean) => void) | null;
}

export function SharedCard({ server, busy, onAdminSetStatus }: SharedCardProps) {
  return (
    <div className="library-detail">
      <div className="library-shared-body">
        <p className="library-shared-by">
          {server.createdBy} 님이 {formatDateTime(server.createdAt)}에 등록 · {server.adoptedCount}명이 추가
        </p>

        <ServerMeta server={server} />
        <HealthLine health={server.health} />

        {server.requiresCredential && (
          <p className="library-warning">추가한 뒤 내 개인 키를 따로 입력해야 실행됩니다.</p>
        )}

        {/* Full descriptions, unfolded. A tool's description sits in the prompt
            of every conversation it is switched on in — called or not — so the
            box cannot be ticked without seeing what is being taken on. */}
        <p className="library-tool-heading">
          도구 {server.tools.length}개 — 켜면 아래 설명이 대화 프롬프트에 그대로 들어갑니다.
        </p>
        {server.tools.length === 0 ? (
          <p className="library-empty-inline">아직 도구 목록을 가져오지 못했습니다.</p>
        ) : (
          <ul className="library-tool-list">
            {server.tools.map((tool) => (
              <li key={tool.name}>
                <code>{tool.name}</code>
                <p>{tool.description}</p>
              </li>
            ))}
          </ul>
        )}

        {onAdminSetStatus && (
          <div className="library-actions">
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => onAdminSetStatus(server.status !== "disabled")}
            >
              {server.status === "disabled" ? "다시 활성화" : "비활성화"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 등록한 사람(또는 관리자)이 모델에 넘길 도구를 고른다. 도구가 많고 설명이 긴 서버
 * (Atlassian 26개, 70KB)는 전부 넘기면 질문마다 프롬프트가 크게 늘고, 앞에서부터 한도까지만
 * 담으면 정작 실행 도구가 빠졌다 — 그래서 권장 도구를 기본으로 체크해 두고 고르게 한다.
 */
function ToolChooser({ server, busy, onSave }: { server: McpServerSummary; busy: boolean; onSave: (selection: string[] | null) => void }) {
  const initial = server.tools.filter((tool) => tool.selected !== false).map((tool) => shortToolName(tool.name));
  const [checked, setChecked] = useState<string[]>(initial);
  const changed = checked.length !== initial.length || checked.some((name) => !initial.includes(name));
  const hasRecommended = server.tools.some((tool) => tool.recommended);

  function toggle(name: string) {
    setChecked((current) => (current.includes(name) ? current.filter((n) => n !== name) : [...current, name]));
  }

  return (
    <div className="library-tool-chooser">
      <p className="library-tool-chooser-hint">
        체크한 도구만 대화에서 씁니다.{" "}
        {server.toolSelectionCustom
          ? "직접 고른 목록입니다."
          : hasRecommended
            ? "권장 도구가 기본으로 체크되어 있습니다."
            : "기본은 전부입니다."}
      </p>
      <ul className="library-tool-chooser-list">
        {server.tools.map((tool) => {
          const name = shortToolName(tool.name);
          const id = `tool-${server.id}-${name}`;
          return (
            <li key={tool.name}>
              <input id={id} type="checkbox" checked={checked.includes(name)} disabled={busy} onChange={() => toggle(name)} />
              <label htmlFor={id} data-tooltip={tool.description}>
                <code>{name}</code>
                {tool.recommended && <span className="md-badge">권장</span>}
              </label>
            </li>
          );
        })}
      </ul>
      <div className="library-tool-chooser-actions">
        {server.toolSelectionCustom && (
          <button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={() => onSave(null)}>
            {hasRecommended ? "권장 도구로 되돌리기" : "전부 쓰기로 되돌리기"}
          </button>
        )}
        <button type="button" className="btn btn-sm" disabled={busy || !changed} onClick={() => onSave(checked)}>
          도구 선택 저장
        </button>
      </div>
    </div>
  );
}
