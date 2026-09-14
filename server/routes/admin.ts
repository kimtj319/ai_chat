import { Router, type Response } from "express";
import { requireAdmin } from "../middleware/auth.js";
import {
  clearGroupFromUsers,
  deleteUser,
  listUsers,
  normalizeUserId,
  setUserGroup,
  setUserStatus,
} from "../storage/userStore.js";
import {
  createGroup,
  deleteGroup,
  listGroups,
  normalizeGroupId,
  normalizeGroupName,
  renameGroup,
} from "../storage/groupStore.js";
import { deleteOwnerData } from "../storage/ownerData.js";
import { signOutAllSessions } from "../storage/sessionStore.js";
import { toPublicUser } from "../types.js";
import type { AuthErrorCode, UserStatus } from "../types.js";

export const adminRouter = Router();

function fail(res: Response, status: number, code: AuthErrorCode, error: string): void {
  res.status(status).json({ error, code });
}

// Every /api/admin route is admin-only; requireActiveUser (app.ts) has already
// established that there is an active account behind the request.
adminRouter.use("/admin", requireAdmin);

adminRouter.get("/admin/users", async (_req, res, next) => {
  try {
    res.json((await listUsers()).map(toPublicUser));
  } catch (err) {
    next(err);
  }
});

const PAST_TENSE = { approve: "approved", block: "blocked", unblock: "unblocked" } as const;

/**
 * approve / block / unblock. One handler, because they differ only in the
 * status they write and in one guard.
 *
 * "approve" and "unblock" both land on `active` and are kept as separate verbs
 * anyway: they mean different things to the admin pressing them, and the log
 * line is the audit trail.
 */
function statusRoute(verb: "approve" | "block" | "unblock", status: UserStatus): void {
  adminRouter.post(`/admin/users/:id/${verb}`, async (req, res, next) => {
    try {
      const id = normalizeUserId(req.params.id);
      if (!id) return fail(res, 404, "not_found", "존재하지 않는 계정입니다.");
      // Blocking yourself would lock the last admin out of their own admin
      // screen, with no way back in through the UI.
      if (verb === "block" && id === req.user?.id) {
        return fail(res, 400, "cannot_block_self", "자기 자신은 차단할 수 없습니다.");
      }
      const updated = await setUserStatus(id, status, req.user!.id);
      if (!updated) return fail(res, 404, "not_found", "존재하지 않는 계정입니다.");
      console.log(`[admin] ${req.user!.id} ${PAST_TENSE[verb]} ${updated.id} (status=${updated.status})`);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });
}

statusRoute("approve", "active");
statusRoute("block", "blocked");
statusRoute("unblock", "active");

/**
 * DELETE /api/admin/users/:id — remove an account and everything it owns.
 *
 * Irreversible, and deliberately thorough. The record, the conversations and
 * attachments under {DATA_DIR}/owners/{id}, and every session still pointing at
 * the id all go. Leaving any of them would hand the next account registered
 * under that id someone else's history, because all three are addressed by the
 * id string and nothing else.
 */
adminRouter.delete("/admin/users/:id", async (req, res, next) => {
  try {
    const id = normalizeUserId(req.params.id);
    if (!id) return fail(res, 404, "not_found", "존재하지 않는 계정입니다.");
    if (id === req.user?.id) {
      return fail(res, 400, "cannot_delete_self", "자기 자신의 계정은 삭제할 수 없습니다.");
    }

    // Note there is no separate "last administrator" guard: only an admin can
    // reach this route and nobody can delete themselves, so an admin being
    // deleted always leaves at least the one doing the deleting.
    const removed = await deleteUser(id);
    if (!removed) return fail(res, 404, "not_found", "존재하지 않는 계정입니다.");
    await deleteOwnerData(id);
    const signedOut = await signOutAllSessions(id);
    console.log(`[admin] ${req.user!.id} deleted ${id} (sessions signed out: ${signedOut})`);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/** GET /api/admin/groups — every group, name-sorted. */
adminRouter.get("/admin/groups", async (_req, res, next) => {
  try {
    res.json(await listGroups());
  } catch (err) {
    next(err);
  }
});

/** POST /api/admin/groups { name } — 201 with the new group. */
adminRouter.post("/admin/groups", async (req, res, next) => {
  try {
    const name = normalizeGroupName((req.body ?? {}).name);
    if (!name) return fail(res, 400, "invalid_input", "그룹 이름을 입력해주세요.");
    const created = await createGroup(name, req.user!.id);
    if (!created.ok) return fail(res, 409, "duplicate_group", "같은 이름의 그룹이 이미 있습니다.");
    console.log(`[admin] ${req.user!.id} created group "${created.group.name}"`);
    res.status(201).json(created.group);
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/admin/groups/:id { name } — rename in place, members untouched. */
adminRouter.patch("/admin/groups/:id", async (req, res, next) => {
  try {
    const id = normalizeGroupId(req.params.id);
    if (!id) return fail(res, 404, "not_found", "존재하지 않는 그룹입니다.");
    const name = normalizeGroupName((req.body ?? {}).name);
    if (!name) return fail(res, 400, "invalid_input", "그룹 이름을 입력해주세요.");
    const renamed = await renameGroup(id, name);
    if (!renamed.ok) {
      return renamed.code === "duplicate_group"
        ? fail(res, 409, "duplicate_group", "같은 이름의 그룹이 이미 있습니다.")
        : fail(res, 404, "not_found", "존재하지 않는 그룹입니다.");
    }
    res.json(renamed.group);
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/admin/groups/:id — remove the group, keep its members.
 *
 * Members are unfiled rather than deleted. A group is a label; deleting a label
 * must never delete the thing it was stuck to.
 */
adminRouter.delete("/admin/groups/:id", async (req, res, next) => {
  try {
    const id = normalizeGroupId(req.params.id);
    if (!id) return fail(res, 404, "not_found", "존재하지 않는 그룹입니다.");
    const removed = await deleteGroup(id);
    if (!removed) return fail(res, 404, "not_found", "존재하지 않는 그룹입니다.");
    const cleared = await clearGroupFromUsers(id);
    console.log(`[admin] ${req.user!.id} deleted group ${id} (accounts unfiled: ${cleared})`);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/** PUT /api/admin/users/:id/group { groupId } — null or "" unfiles the account. */
adminRouter.put("/admin/users/:id/group", async (req, res, next) => {
  try {
    const id = normalizeUserId(req.params.id);
    if (!id) return fail(res, 404, "not_found", "존재하지 않는 계정입니다.");
    const raw = (req.body ?? {}).groupId;
    const groupId = raw === null || raw === "" || raw === undefined ? null : normalizeGroupId(raw);
    if (raw !== null && raw !== "" && raw !== undefined && !groupId) {
      return fail(res, 404, "not_found", "존재하지 않는 그룹입니다.");
    }
    if (groupId && !(await listGroups()).some((group) => group.id === groupId)) {
      return fail(res, 404, "not_found", "존재하지 않는 그룹입니다.");
    }
    const updated = await setUserGroup(id, groupId);
    if (!updated) return fail(res, 404, "not_found", "존재하지 않는 계정입니다.");
    res.json(toPublicUser(updated));
  } catch (err) {
    next(err);
  }
});
