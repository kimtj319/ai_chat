import { useState } from "react";
import * as api from "../api/client";
import { McpError } from "../api/client";
import type { McpServerSummary } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { useMcpLibrary } from "../hooks/useMcpLibrary";
import { healthIsBad, healthLabel, myLibrary, sharedByOthers, type McpServerDraft } from "../mcp/rules";
import { missingKey, useMyAccess } from "../hooks/useMyAccess";
import { ConfirmDialog } from "./ConfirmDialog";
import { Accordion } from "./Accordion";
import { EmptyState, ListSkeleton, LoadFailed } from "./ListSkeleton";
import { McpServerForm } from "./McpServerForm";
import { PageHeader } from "./PageHeader";
import { ToggleSwitch } from "./ToggleSwitch";
import { errorMessage } from "../state/friendlyError";
import { RefreshIcon } from "./icons";
import { probeErrorSummary } from "../mcp/probeError";
import { LibraryCard, SharedCard } from "./LibraryCards";
import "./LibraryPage.css";

function originLabel(server: McpServerSummary, owned: boolean): string {
  if (server.origin === "builtin") return "기본 제공";
  return owned ? "내가 등록" : "추가함";
}

interface LibraryPageProps {
  onBack: () => void;
  /** Null for everyone who is not an administrator: the control is then never
   *  rendered, rather than the card deciding from a role. */
  onAdminSetStatus: ((id: string, disabled: boolean) => Promise<void>) | null;
}

/** A 409 on a delete is not a failure to report verbatim — it means someone
 *  else is relying on the server. */
function failureMessage(error: unknown): string {
  if (error instanceof McpError && error.status === 409) {
    return error.adoptedCount === null
      ? "다른 사용자가 추가해 쓰고 있어 삭제할 수 없습니다."
      : `다른 사용자 ${error.adoptedCount}명이 추가해 쓰고 있어 삭제할 수 없습니다.`;
  }
  return errorMessage(error);
}

export function LibraryPage({ onBack, onAdminSetStatus }: LibraryPageProps) {
  const { me } = useAuth();
  const meId = me?.id ?? "";
  const { servers, adopted, hidden, loading, unavailable, error, reload } = useMcpLibrary();

  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [formFor, setFormFor] = useState<McpServerSummary | "new" | null>(null);
  const [pendingDelete, setPendingDelete] = useState<McpServerSummary | null>(null);
  // 칸마다 열린 줄 하나. 채택한 서버는 두 칸에 다 있으므로 따로 둔다.
  const [openMine, setOpenMine] = useState<string | null>(null);
  const [openShared, setOpenShared] = useState<string | null>(null);
  const access = useMyAccess();

  /** Every write goes through here so one failure path serves them all. */
  async function run(id: string, doneMessage: string, work: () => Promise<unknown>): Promise<boolean> {
    setBusyId(id);
    setActionError(null);
    setNotice(null);
    try {
      await work();
      setNotice(doneMessage);
      await reload();
      return true;
    } catch (err) {
      setActionError(failureMessage(err));
      return false;
    } finally {
      setBusyId(null);
    }
  }

  async function submitDraft(draft: McpServerDraft): Promise<void> {
    const editing = formFor !== "new" && formFor !== null ? formFor : null;
    const body = {
      name: draft.name.trim(),
      slug: draft.slug.trim(),
      description: draft.description.trim(),
      url: draft.url.trim(),
      authMode: draft.authMode,
      ...(draft.authMode === "header" ? { authHeaderName: draft.authHeaderName.trim() } : {}),
      // An edit that leaves the field blank keeps whatever is stored.
      ...(draft.credential.trim().length > 0 ? { credential: draft.credential.trim() } : {}),
    };

    // Deliberately not inside `run`: the form shows the refusal itself (it is
    // the only place that can point at the field that caused it) and stays open.
    if (editing) await api.updateMcpServer(editing.id, body);
    else await api.createMcpServer(body);

    setFormFor(null);
    setNotice(editing ? `${body.name} 서버를 수정했습니다.` : `${body.name} 서버를 등록했습니다.`);
    await reload();
  }

  const mine = myLibrary(servers, adopted, meId);
  const shared = sharedByOthers(servers, meId);
  const adoptedIds = new Set(adopted);
  const hiddenIds = new Set(hidden);
  const adminSetStatusFor = (server: McpServerSummary) =>
    onAdminSetStatus
      ? (disabled: boolean) =>
          void run(server.id, disabled ? `${server.name} 서버를 비활성화했습니다.` : `${server.name} 서버를 활성화했습니다.`, () =>
            onAdminSetStatus(server.id, disabled),
          )
      : null;

  return (
    <div className="library-page">
      <PageHeader
        title="커넥터"
        onBack={onBack}
        subtitle={
          loading
            ? "MCP 서버 연결 · 불러오는 중…"
            : `MCP 서버 연결 · 내 커넥터 ${mine.length}개 · 공유된 커넥터 ${shared.length}개`
        }
        actions={
          <>
            <button type="button" className="btn-icon" onClick={() => void reload()} data-tooltip="새로고침" aria-label="새로고침">
              <RefreshIcon />
            </button>
            <button type="button" className="btn btn-primary" onClick={() => setFormFor("new")} disabled={unavailable}>
              서버 등록
            </button>
          </>
        }
      />

      <div className="library-body">
        {notice && (
          <p className="library-notice" role="status">
            {notice}
          </p>
        )}
        {actionError && (
          <p className="library-error" role="alert">
            {actionError}
          </p>
        )}
        {unavailable && (
          <p className="library-notice" role="status">
            이 서버에는 아직 MCP 기능이 배포되지 않았습니다. 배포되면 등록한 서버가 여기에 표시됩니다.
          </p>
        )}

        {loading ? (
          <ListSkeleton rows={4} />
        ) : error ? (
          <LoadFailed message="커넥터 목록을 불러오지 못했습니다." onRetry={() => void reload()} />
        ) : (
          // 가운데를 기준으로 왼쪽은 내 커넥터, 오른쪽은 다른 사용자가 공유한 커넥터.
          // 줄을 누르면 그 자리에서 아래로 열린다(칸마다 하나씩).
          <div className="library-columns">
            <section className="library-column" aria-labelledby="library-mine-title">
              <h2 className="library-column-title" id="library-mine-title">
                내 커넥터 <span className="library-column-count">{mine.length}</span>
              </h2>
              <p className="library-column-hint">
                기본 제공 서버와 내가 등록하거나 추가한 MCP 서버입니다. 스위치를 켠 서버의 도구는 모든 대화에서 모델에게
                전달되어, 필요할 때 모델이 알아서 씁니다. 따로 고를 필요가 없습니다.
              </p>
              {mine.length === 0 ? (
                <EmptyState
                  title="내 커넥터가 없습니다"
                  reason="MCP 서버를 등록하거나 공유된 커넥터를 추가해 보세요."
                  actionLabel="서버 등록"
                  onAction={() => setFormFor("new")}
                  actionDisabled={unavailable}
                />
              ) : (
                <Accordion
                  items={mine}
                  idOf={(server) => server.id}
                  openId={openMine}
                  onToggle={(id) => setOpenMine((current) => (current === id ? null : id))}
                  renderHead={(server) => {
                    const owned = server.origin === "user" && server.createdBy === meId;
                    return (
                      <>
                        <span className="md-row-name">
                          {server.name}
                          <span className="library-badge" data-origin={server.origin}>
                            {originLabel(server, owned)}
                          </span>
                          {server.status === "disabled" && (
                            <span className="library-badge" data-tone="danger">
                              관리자 비활성화
                            </span>
                          )}
                          {missingKey(access, { mcpSlug: server.slug, builtin: server.origin === "builtin" }) && (
                            <span className="md-badge" data-tone="warning">
                              키 필요
                            </span>
                          )}
                          {/* 접힌 줄에서도 보이게. 스위치가 켜져 있으면 멀쩡해 보이는데 펼쳐야만 실패가 보였다. */}
                          {server.status !== "disabled" && healthIsBad(server.health.state) && (
                            <span className="md-badge" data-tone="warning">
                              {healthLabel(server.health.state)}
                            </span>
                          )}
                        </span>
                        <span className="md-row-desc">{server.description}</span>
                      </>
                    );
                  }}
                  renderTrailing={(server) => (
                    <ToggleSwitch
                      on={!hiddenIds.has(server.id)}
                      disabled={busyId === server.id}
                      label={`${server.name} 대화에서 사용`}
                      onToggle={(next) =>
                        void run(server.id, next ? `${server.name} 서버를 켰습니다.` : `${server.name} 서버를 껐습니다.`, () =>
                          api.setMcpHidden(server.id, !next),
                        )
                      }
                    />
                  )}
                  renderBody={(server) => {
                    const owned = server.origin === "user" && server.createdBy === meId;
                    // 채택 해제는 남이 등록한 서버를 라이브러리 밖으로 완전히 빼는
                    // 조작이다 — 기본 제공이나 내가 등록한 서버에는 뜻이 없다(둘 다
                    // adopted 와 무관하게 항상 멤버라 채택 해제해도 그대로 남는다).
                    // 그런 경우 끄고 켜는 일은 줄의 스위치 하나로 충분하다.
                    const canUnadopt = server.origin !== "builtin" && !owned;
                    return (
                      <LibraryCard
                        server={server}
                        owned={owned}
                        keyMissing={missingKey(access, { mcpSlug: server.slug, builtin: server.origin === "builtin" }) !== null}
                        busy={busyId === server.id}
                        onEdit={() => setFormFor(server)}
                        onDelete={() => setPendingDelete(server)}
                        onProbe={() =>
                          void run(server.id, `${server.name} 연결을 확인했습니다.`, async () => {
                            const { health } = await api.probeMcpServer(server.id);
                            if (healthIsBad(health.state)) {
                              throw new Error(
                                probeErrorSummary(health.error) ?? health.error ?? `${server.name} 연결 상태: ${healthLabel(health.state)}`,
                              );
                            }
                          })
                        }
                        onRemove={
                          canUnadopt
                            ? () =>
                                void run(server.id, `${server.name} 서버를 내 커넥터에서 뺐습니다.`, () =>
                                  api.setMcpAdoption(server.id, false),
                                )
                            : null
                        }
                        onSaveCredential={(credential) =>
                          void run(
                            server.id,
                            credential === null ? "개인 키를 삭제했습니다." : "개인 키를 저장했습니다.",
                            () => api.setMcpCredential(server.id, credential),
                          )
                        }
                        onAdminSetStatus={adminSetStatusFor(server)}
                      />
                    );
                  }}
                />
              )}
            </section>

            <section className="library-column" aria-labelledby="library-shared-title">
              <h2 className="library-column-title" id="library-shared-title">
                공유된 커넥터 <span className="library-column-count">{shared.length}</span>
              </h2>
              <p className="library-column-hint">
                다른 사용자가 등록한 MCP 서버입니다. 스위치를 켜면 내 커넥터에 추가되고, 켜기 전에는 내 대화에서 어떤 것도
                실행되지 않습니다.
              </p>
              {shared.length === 0 ? (
                <EmptyState
                  title="공유된 커넥터가 없습니다"
                  reason="다른 사용자가 MCP 서버를 등록하면 여기에 나타나고, 내가 등록한 서버도 다른 사용자에게 이렇게 보입니다."
                  actionLabel="서버 등록"
                  onAction={() => setFormFor("new")}
                  actionDisabled={unavailable}
                />
              ) : (
                <Accordion
                  items={shared}
                  idOf={(server) => server.id}
                  openId={openShared}
                  onToggle={(id) => setOpenShared((current) => (current === id ? null : id))}
                  renderHead={(server) => (
                    <>
                      <span className="md-row-name">
                        {server.name}
                        <span className="library-badge">{server.createdBy} 님</span>
                        {adoptedIds.has(server.id) && <span className="library-badge">내 커넥터에 있음</span>}
                        {server.status === "disabled" && (
                          <span className="library-badge" data-tone="danger">
                            관리자 비활성화
                          </span>
                        )}
                        {server.status !== "disabled" && healthIsBad(server.health.state) && (
                          <span className="md-badge" data-tone="warning">
                            {healthLabel(server.health.state)}
                          </span>
                        )}
                      </span>
                      <span className="md-row-desc">{server.description}</span>
                    </>
                  )}
                  renderTrailing={(server) => (
                    <ToggleSwitch
                      on={adoptedIds.has(server.id)}
                      disabled={busyId === server.id}
                      label={`${server.name} 내 커넥터에 추가`}
                      onToggle={(next) =>
                        void run(
                          server.id,
                          next ? `${server.name} 서버를 내 커넥터에 추가했습니다.` : `${server.name} 서버를 내 커넥터에서 뺐습니다.`,
                          () => api.setMcpAdoption(server.id, next),
                        )
                      }
                    />
                  )}
                  renderBody={(server) => (
                    <SharedCard
                      server={server}
                      busy={busyId === server.id}
                      onAdminSetStatus={adminSetStatusFor(server)}
                    />
                  )}
                />
              )}
            </section>
          </div>
        )}
      </div>

      {formFor && (
        <McpServerForm
          server={formFor === "new" ? null : formFor}
          onSubmit={submitDraft}
          onClose={() => setFormFor(null)}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={`${pendingDelete.name} 서버를 삭제할까요?`}
          message="이 서버를 추가한 다른 사용자의 커넥터에서도 사라집니다. 되돌릴 수 없습니다."
          confirmLabel="삭제"
          danger
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            const target = pendingDelete;
            setPendingDelete(null);
            void run(target.id, `${target.name} 서버를 삭제했습니다.`, () => api.deleteMcpServer(target.id));
          }}
        />
      )}
    </div>
  );
}
