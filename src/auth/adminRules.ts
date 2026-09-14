// What one row of the admin account list is allowed to offer, and what its
// status reads as. Pure, so the harness can pin the rules down — above all the
// one the server must not be left to enforce alone: an administrator cannot
// block their own account and lock themselves out.

import type { AccountStatus, AdminGroup, AdminUser } from "../api/types";

export type StatusFilter = "all" | AccountStatus;

export const SELF_BLOCK_REASON = "본인 계정은 차단할 수 없습니다.";
export const SELF_DELETE_REASON = "본인 계정은 삭제할 수 없습니다.";

/** The group filter's value for "accounts that are in no group at all". */
export const NO_GROUP = "__none__";

export const STATUS_LABELS: Record<AccountStatus, string> = {
  pending: "승인 대기",
  active: "활성",
  blocked: "차단됨",
};

export const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "전체" },
  { value: "pending", label: "승인 대기" },
  { value: "active", label: "활성" },
  { value: "blocked", label: "차단됨" },
];

/** A status the client does not know is shown verbatim rather than hidden. */
export function statusLabel(status: string): string {
  return STATUS_LABELS[status as AccountStatus] ?? status;
}

export interface AdminActions {
  approve: boolean;
  block: boolean;
  unblock: boolean;
  /** Why 차단 is unavailable, or null when it is offered (or simply N/A). */
  blockDisabledReason: string | null;
  /** Deleting removes the account and its conversations, so never the self row. */
  remove: boolean;
  removeDisabledReason: string | null;
}

/**
 * `currentAdminId` is the signed-in administrator. The self row keeps 승인 and
 * 차단 해제 (neither can lock anyone out) but never offers 차단.
 */
export function adminActions(user: AdminUser, currentAdminId: string): AdminActions {
  const isSelf = user.id === currentAdminId;
  const blockable = user.status !== "blocked";
  return {
    approve: user.status === "pending",
    block: blockable && !isSelf,
    unblock: user.status === "blocked",
    blockDisabledReason: isSelf && blockable ? SELF_BLOCK_REASON : null,
    remove: !isSelf,
    removeDisabledReason: isSelf ? SELF_DELETE_REASON : null,
  };
}

/**
 * Group is a second, independent axis: filtering by it must not disturb the
 * status filter, and vice versa, so the two are applied one after the other
 * rather than collapsed into a single list of tabs.
 */
export function filterByGroup(users: AdminUser[], groupId: string | null): AdminUser[] {
  if (groupId === null) return users;
  if (groupId === NO_GROUP) return users.filter((user) => !user.groupId);
  return users.filter((user) => user.groupId === groupId);
}

export function groupName(groups: AdminGroup[], groupId: string | undefined): string | null {
  if (!groupId) return null;
  return groups.find((group) => group.id === groupId)?.name ?? null;
}

export function groupMemberCount(users: AdminUser[], groupId: string): number {
  return users.filter((user) => user.groupId === groupId).length;
}

export function filterUsers(users: AdminUser[], filter: StatusFilter): AdminUser[] {
  return filter === "all" ? users : users.filter((user) => user.status === filter);
}

export function pendingCount(users: AdminUser[]): number {
  return users.filter((user) => user.status === "pending").length;
}

/** What the list says when the chosen filter matches nothing. */
export function emptyListMessage(filter: StatusFilter): string {
  switch (filter) {
    case "pending":
      return "승인 대기 중인 계정이 없습니다.";
    case "active":
      return "활성 계정이 없습니다.";
    case "blocked":
      return "차단된 계정이 없습니다.";
    case "all":
    default:
      return "등록된 계정이 없습니다.";
  }
}
