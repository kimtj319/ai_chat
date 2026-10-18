import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api/client";
import type { AdminUserAction } from "../api/client";
import type { AdminGroup, AdminUser } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { authFailureMessage } from "../auth/messages";
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
import { AdminModelsTab } from "./AdminModelsTab";
import { AdminNoticesTab } from "./AdminNoticesTab";
import { ConfirmDialog } from "./ConfirmDialog";
import { ListSkeleton, LoadFailed } from "./ListSkeleton";
import { PageHeader } from "./PageHeader";
import { RefreshIcon } from "./icons";
import "./AdminPage.css";

/** "2026-09-12" from an ISO timestamp; an unparseable value is shown as-is. */
function formatDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" });
}

interface AdminPageProps {
  onBack: () => void;
}

type AdminTab = "accounts" | "models" | "notices";

const TABS: Array<{ value: AdminTab; label: string }> = [
  { value: "accounts", label: "계정" },
  { value: "models", label: "모델" },
  { value: "notices", label: "공지사항" },
];

export function AdminPage({ onBack }: AdminPageProps) {
  const { me } = useAuth();
  const [tab, setTab] = useState<AdminTab>("accounts");
  const currentAdminId = me?.id ?? "";

  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("pending");
  // 처음 열 때만: 승인 대기가 없으면 "전체" 로 연다. "승인 대기 중인 계정이 없습니다." 한 줄이
  // 첫 화면이면 계정이 하나도 없는 것처럼 보인다. 그 뒤로는 고른 필터를 건드리지 않는다.
  const filterDefaulted = useRef(false);
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
      if (!filterDefaulted.current) {
        filterDefaulted.current = true;
        if (pendingCount(nextUsers) === 0) setFilter("all");
      }
    } catch (error) {
      setLoadError(authFailureMessage(error));
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
      setActionError(authFailureMessage(error));
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
      <PageHeader
        title="관리자 메뉴"
        onBack={onBack}
        subtitle={
          tab === "models"
            ? "연결된 모델 서버와 모델"
            : tab === "notices"
              ? "모든 계정에 보이는 공지"
              : users === null
                ? "계정 목록을 불러오는 중…"
                : pending > 0
                  ? `전체 ${all.length}명 · 승인 대기 ${pending}명`
                  : `전체 ${all.length}명 · 승인 대기 없음`
        }
        actions={
          tab === "accounts" && (
            <button type="button" className="btn-icon" onClick={() => void load()} data-tooltip="목록 새로고침" aria-label="목록 새로고침">
              <RefreshIcon />
            </button>
          )
        }
      />

      {/* 탭은 본문 밖에 선다 — 본문을 내려도 늘 보이고, 계정 탭 안의 상태 필터(알약 모양)와
          한 줄에 붙어 하나의 컨트롤처럼 보이지 않게 밑줄 탭으로 둔다. */}
      <div className="admin-tabbar" role="tablist" aria-label="관리자 메뉴">
        {TABS.map((entry) => (
          <button
            key={entry.value}
            type="button"
            role="tab"
            aria-selected={tab === entry.value}
            className="admin-tab"
            data-active={tab === entry.value || undefined}
            onClick={() => setTab(entry.value)}
          >
            {entry.label}
            {entry.value === "accounts" && pending > 0 && <span className="admin-filter-count">{pending}</span>}
          </button>
        ))}
      </div>

      <div className="admin-body">
        {tab === "models" ? (
          <AdminModelsTab />
        ) : tab === "notices" ? (
          <AdminNoticesTab />
        ) : (
        <>
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
              <button type="submit" className="btn btn-sm" disabled={busyId === "group:new" || !newGroupName.trim()}>
                추가
              </button>
            </form>
          </div>

          {groups.length === 0 ? (
            <p className="admin-groups-empty">아직 그룹이 없습니다. 계정을 묶어서 관리하려면 그룹을 먼저 만들어 주세요.</p>
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
                      <button type="submit" className="btn btn-sm" disabled={busyId === group.id || !renameValue.trim()}>
                        저장
                      </button>
                      <button type="button" className="btn btn-sm btn-secondary" onClick={() => setRenamingId(null)}>
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
        {loadError && users !== null && (
          <p className="admin-error" role="alert">
            {loadError}
          </p>
        )}

        {users === null && loadError ? (
          <LoadFailed message="계정 목록을 불러오지 못했습니다." detail={loadError} onRetry={() => void load()} />
        ) : users === null ? (
          <ListSkeleton rows={4} />
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
                              className="btn btn-sm"
                              disabled={busy}
                              onClick={() => void runAction(user, "approve", `${user.id} 계정을 승인했습니다.`)}
                            >
                              승인
                            </button>
                          )}
                          {actions.unblock && (
                            <button
                              type="button"
                              className="btn btn-sm"
                              disabled={busy}
                              onClick={() => void runAction(user, "unblock", `${user.id} 계정의 차단을 해제했습니다.`)}
                            >
                              차단 해제
                            </button>
                          )}
                          {/* 차단은 되돌릴 수 있다(차단 해제). 되돌릴 수 없는 삭제와 같은 빨간 단추로
                              두면 둘의 무게가 같아 보인다 — 빨강은 삭제에만. */}
                          {actions.block && (
                            <button
                              type="button"
                              className="btn btn-sm"
                              disabled={busy}
                              onClick={() => setPendingBlock(user)}
                            >
                              차단
                            </button>
                          )}
                          {actions.remove && (
                            <button
                              type="button"
                              className="btn btn-sm btn-danger-quiet"
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
        </>
        )}
      </div>

      {pendingBlock && (
        <ConfirmDialog
          title={`${pendingBlock.id} 계정을 차단할까요?`}
          message={`${pendingBlock.name} 님은 차단된 동안 로그인할 수 없습니다. 차단 해제로 되돌릴 수 있습니다.`}
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
          title={`${pendingDelete.id} 계정을 삭제할까요?`}
          message={`${pendingDelete.name} 님의 대화와 첨부파일도 함께 삭제됩니다. 되돌릴 수 없습니다.`}
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
          title={`${pendingGroupDelete.name} 그룹을 삭제할까요?`}
          message="소속된 계정은 삭제되지 않고 그룹에서만 빠집니다. 되돌릴 수 없습니다."
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
