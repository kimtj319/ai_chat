import { useCallback, useEffect, useState } from "react";
import * as api from "../api/client";
import { AuthError, type AdminUserAction } from "../api/client";
import type { AdminGroup, AdminUser } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { authErrorMessage } from "../auth/messages";
import {
  adminActions,
  emptyListMessage,
  filterByGroup,
  filterUsers,
  groupMemberCount,
  groupName,
  NO_GROUP,
  pendingCount,
  statusLabel,
  STATUS_FILTERS,
  type StatusFilter,
} from "../auth/adminRules";
import { ConfirmDialog } from "./ConfirmDialog";
import "./AdminPage.css";

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 12H5" />
      <path d="M12 19l-7-7 7-7" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 11a8 8 0 1 0-.6 4" />
      <path d="M20 4v7h-7" />
    </svg>
  );
}

/** "2026-09-12" from an ISO timestamp; an unparseable value is shown as-is. */
function formatDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" });
}

interface AdminPageProps {
  onBack: () => void;
}

export function AdminPage({ onBack }: AdminPageProps) {
  const { me } = useAuth();
  const currentAdminId = me?.id ?? "";

  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("pending");
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingBlock, setPendingBlock] = useState<AdminUser | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AdminUser | null>(null);

  const [groups, setGroups] = useState<AdminGroup[]>([]);
  // null means "every group"; NO_GROUP means "accounts in none".
  const [groupFilter, setGroupFilter] = useState<string | null>(null);
  const [newGroupName, setNewGroupName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [pendingGroupDelete, setPendingGroupDelete] = useState<AdminGroup | null>(null);

  const load = useCallback(async () => {
    try {
      const [nextUsers, nextGroups] = await Promise.all([api.listAdminUsers(), api.listAdminGroups()]);
      setUsers(nextUsers);
      setGroups(nextGroups);
      setLoadError(null);
    } catch (error) {
      const code = error instanceof AuthError ? error.code : null;
      const fallback = error instanceof Error ? error.message : undefined;
      setLoadError(authErrorMessage(code, fallback));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Every write goes through here so one failure path serves them all. */
  async function run(id: string, doneMessage: string, work: () => Promise<unknown>) {
    setBusyId(id);
    setActionError(null);
    setNotice(null);
    try {
      await work();
      setNotice(doneMessage);
      await load();
      return true;
    } catch (error) {
      const code = error instanceof AuthError ? error.code : null;
      const fallback = error instanceof Error ? error.message : undefined;
      setActionError(authErrorMessage(code, fallback));
      return false;
    } finally {
      setBusyId(null);
    }
  }

  function runAction(user: AdminUser, action: AdminUserAction, doneMessage: string) {
    return run(user.id, doneMessage, () => api.updateUserStatus(user.id, action));
  }

  const all = users ?? [];
  const visible = filterByGroup(filterUsers(all, filter), groupFilter);
  const pending = pendingCount(all);

  return (
    <div className="admin-page">
      <header className="admin-header">
        <button type="button" className="btn-icon" onClick={onBack} data-tooltip="채팅으로 돌아가기" aria-label="채팅으로 돌아가기">
          <BackIcon />
        </button>
        <div className="admin-header-text">
          <h1 className="admin-title">계정 관리</h1>
          <p className="admin-subtitle">
            {users === null
              ? "계정 목록을 불러오는 중…"
              : pending > 0
                ? `전체 ${all.length}명 · 승인 대기 ${pending}명`
                : `전체 ${all.length}명 · 승인 대기 없음`}
          </p>
        </div>
        <button type="button" className="btn-icon" onClick={() => void load()} data-tooltip="목록 새로고침" aria-label="목록 새로고침">
          <RefreshIcon />
        </button>
      </header>

      <div className="admin-body">
        <div className="admin-filters" role="group" aria-label="상태 필터">
          {STATUS_FILTERS.map((entry) => (
            <button
              key={entry.value}
              type="button"
              className={`admin-filter${filter === entry.value ? " active" : ""}`}
              aria-pressed={filter === entry.value}
              onClick={() => setFilter(entry.value)}
            >
              {entry.label}
              {entry.value === "pending" && pending > 0 && <span className="admin-filter-count">{pending}</span>}
            </button>
          ))}
        </div>

        <section className="admin-groups" aria-label="그룹">
          <div className="admin-groups-head">
            <h2 className="admin-groups-title">그룹</h2>
            <form
              className="admin-group-add"
              onSubmit={(event) => {
                event.preventDefault();
                const name = newGroupName.trim();
                if (!name) return;
                void run("group:new", `"${name}" 그룹을 만들었습니다.`, () => api.createAdminGroup(name)).then((ok) => {
                  if (ok) setNewGroupName("");
                });
              }}
            >
              <input
                type="text"
                value={newGroupName}
                placeholder="새 그룹 이름"
                aria-label="새 그룹 이름"
                onChange={(event) => setNewGroupName(event.target.value)}
              />
              <button type="submit" className="btn admin-action" disabled={busyId === "group:new" || !newGroupName.trim()}>
                추가
              </button>
            </form>
          </div>

          {groups.length === 0 ? (
            <p className="admin-groups-empty">아직 그룹이 없습니다. 계정을 묶어서 관리하려면 그룹을 먼저 만들어주세요.</p>
          ) : (
            <ul className="admin-group-list">
              {groups.map((group) => (
                <li key={group.id} className="admin-group-chip">
                  {renamingId === group.id ? (
                    <form
                      className="admin-group-rename"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const name = renameValue.trim();
                        if (!name) return;
                        void run(group.id, `그룹 이름을 "${name}"(으)로 바꿨습니다.`, () =>
                          api.renameAdminGroup(group.id, name),
                        ).then((ok) => {
                          if (ok) setRenamingId(null);
                        });
                      }}
                    >
                      <input
                        type="text"
                        value={renameValue}
                        aria-label="그룹 이름"
                        autoFocus
                        onChange={(event) => setRenameValue(event.target.value)}
                      />
                      <button type="submit" className="btn admin-action" disabled={busyId === group.id}>
                        저장
                      </button>
                      <button type="button" className="btn btn-secondary admin-action" onClick={() => setRenamingId(null)}>
                        취소
                      </button>
                    </form>
                  ) : (
                    <>
                      <span className="admin-group-name">{group.name}</span>
                      <span className="admin-group-count">{groupMemberCount(all, group.id)}명</span>
                      <button
                        type="button"
                        className="admin-group-link"
                        onClick={() => {
                          setRenamingId(group.id);
                          setRenameValue(group.name);
                        }}
                      >
                        이름 변경
                      </button>
                      <button type="button" className="admin-group-link danger" onClick={() => setPendingGroupDelete(group)}>
                        삭제
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {groups.length > 0 && (
          <div className="admin-filters" role="group" aria-label="그룹 필터">
            <button
              type="button"
              className={`admin-filter${groupFilter === null ? " active" : ""}`}
              aria-pressed={groupFilter === null}
              onClick={() => setGroupFilter(null)}
            >
              모든 그룹
            </button>
            {groups.map((group) => (
              <button
                key={group.id}
                type="button"
                className={`admin-filter${groupFilter === group.id ? " active" : ""}`}
                aria-pressed={groupFilter === group.id}
                onClick={() => setGroupFilter(group.id)}
              >
                {group.name}
              </button>
            ))}
            <button
              type="button"
              className={`admin-filter${groupFilter === NO_GROUP ? " active" : ""}`}
              aria-pressed={groupFilter === NO_GROUP}
              onClick={() => setGroupFilter(NO_GROUP)}
            >
              그룹 없음
            </button>
          </div>
        )}

        {notice && (
          <p className="admin-notice" role="status">
            {notice}
          </p>
        )}
        {actionError && (
          <p className="admin-error" role="alert">
            {actionError}
          </p>
        )}
        {loadError && (
          <p className="admin-error" role="alert">
            {loadError}
          </p>
        )}

        {users === null && !loadError ? (
          <p className="admin-empty">불러오는 중…</p>
        ) : visible.length === 0 ? (
          <p className="admin-empty">{emptyListMessage(filter)}</p>
        ) : (
          <div className="admin-table-scroll">
            <table className="admin-table">
              <thead>
                <tr>
                  <th scope="col">아이디</th>
                  <th scope="col">이름</th>
                  <th scope="col">이메일</th>
                  <th scope="col">그룹</th>
                  <th scope="col">상태</th>
                  <th scope="col">가입일</th>
                  <th scope="col">작업</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((user) => {
                  const actions = adminActions(user, currentAdminId);
                  const busy = busyId === user.id;
                  const isSelf = user.id === currentAdminId;
                  return (
                    <tr key={user.id}>
                      <td className="admin-cell-id">
                        {user.id}
                        {isSelf && <span className="admin-self-tag">나</span>}
                      </td>
                      <td>{user.name}</td>
                      {/* The header has said 이메일 all along; this cell was the
                          one missing, which pushed every column after it under
                          the wrong heading — group under 이메일, status under
                          그룹, and 작업 left empty. */}
                      <td className="admin-cell-email">{user.email}</td>
                      <td className="admin-cell-group">
                        {groups.length === 0 ? (
                          <span className="admin-group-none">{groupName(groups, user.groupId) ?? "-"}</span>
                        ) : (
                          <select
                            aria-label={`${user.id} 그룹`}
                            value={user.groupId ?? ""}
                            disabled={busy}
                            onChange={(event) => {
                              const next = event.target.value || null;
                              const label = next ? groupName(groups, next) : null;
                              void run(
                                user.id,
                                label ? `${user.id} 계정을 "${label}" 그룹으로 옮겼습니다.` : `${user.id} 계정을 그룹에서 뺐습니다.`,
                                () => api.setAdminUserGroup(user.id, next),
                              );
                            }}
                          >
                            <option value="">그룹 없음</option>
                            {groups.map((group) => (
                              <option key={group.id} value={group.id}>
                                {group.name}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td>
                        <span className="admin-status" data-status={user.status}>
                          {statusLabel(user.status)}
                        </span>
                      </td>
                      <td className="admin-cell-date">{formatDate(user.createdAt)}</td>
                      <td>
                        <div className="admin-actions">
                          {actions.approve && (
                            <button
                              type="button"
                              className="btn btn-primary admin-action"
                              disabled={busy}
                              onClick={() => void runAction(user, "approve", `${user.id} 계정을 승인했습니다.`)}
                            >
                              승인
                            </button>
                          )}
                          {actions.unblock && (
                            <button
                              type="button"
                              className="btn admin-action"
                              disabled={busy}
                              onClick={() => void runAction(user, "unblock", `${user.id} 계정의 차단을 해제했습니다.`)}
                            >
                              차단 해제
                            </button>
                          )}
                          {actions.block && (
                            <button
                              type="button"
                              className="btn btn-danger admin-action"
                              disabled={busy}
                              onClick={() => setPendingBlock(user)}
                            >
                              차단
                            </button>
                          )}
                          {actions.remove && (
                            <button
                              type="button"
                              className="btn btn-danger admin-action"
                              disabled={busy}
                              onClick={() => setPendingDelete(user)}
                            >
                              삭제
                            </button>
                          )}
                          {/* The self row never offers 차단 or 삭제 — the server
                              would refuse both, and an administrator who locked
                              themselves out has no way back in. */}
                          {actions.blockDisabledReason && (
                            <span className="admin-action-note">{actions.blockDisabledReason}</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {pendingBlock && (
        <ConfirmDialog
          title="계정 차단"
          message={`${pendingBlock.id} (${pendingBlock.name}) 계정을 차단하시겠습니까? 차단된 계정은 로그인할 수 없습니다.`}
          confirmLabel="차단"
          danger
          onCancel={() => setPendingBlock(null)}
          onConfirm={() => {
            const target = pendingBlock;
            setPendingBlock(null);
            void runAction(target, "block", `${target.id} 계정을 차단했습니다.`);
          }}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          title="계정 삭제"
          message={`${pendingDelete.id} (${pendingDelete.name}) 계정을 삭제하시겠습니까? 이 계정의 대화와 첨부파일도 함께 지워지며 되돌릴 수 없습니다.`}
          confirmLabel="삭제"
          danger
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            const target = pendingDelete;
            setPendingDelete(null);
            void run(target.id, `${target.id} 계정을 삭제했습니다.`, () => api.deleteAdminUser(target.id));
          }}
        />
      )}

      {pendingGroupDelete && (
        <ConfirmDialog
          title="그룹 삭제"
          message={`"${pendingGroupDelete.name}" 그룹을 삭제하시겠습니까? 소속된 계정은 삭제되지 않고 그룹에서만 빠집니다.`}
          confirmLabel="삭제"
          danger
          onCancel={() => setPendingGroupDelete(null)}
          onConfirm={() => {
            const target = pendingGroupDelete;
            setPendingGroupDelete(null);
            if (groupFilter === target.id) setGroupFilter(null);
            void run(target.id, `"${target.name}" 그룹을 삭제했습니다.`, () => api.deleteAdminGroup(target.id));
          }}
        />
      )}
    </div>
  );
}
