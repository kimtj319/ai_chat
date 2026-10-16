import { Router } from "express";
import { isPrivilegedUser } from "../auth/privilege.js";
import {
  deletePersonalKey,
  isPersonalKeyName,
  PersonalKeyInvalidError,
  personalKeySummary,
  setPersonalKey,
} from "../storage/personalKeys.js";

/**
 * 내 접근 권한과 개인 키. 늘 호출한 계정 자기 것만 다룬다.
 *
 *   GET    /me/access        { privileged, keys: { tavily:{set,hint}, gitlab:{set,hint} } }
 *   PUT    /me/keys/:name    { value, label? }   등록·교체(GitLab 은 덧붙임)
 *   DELETE /me/keys/:name           그 이름의 키 전부
 *   DELETE /me/keys/:name/:id       여러 개 둔 키(GitLab) 중 하나
 */
export const meRouter = Router();

meRouter.get("/me/access", async (req, res, next) => {
  try {
    res.json({ privileged: await isPrivilegedUser(req.user), keys: await personalKeySummary(req.ownerId) });
  } catch (err) {
    next(err);
  }
});

meRouter.put("/me/keys/:name", async (req, res, next) => {
  try {
    const { name } = req.params;
    if (!isPersonalKeyName(name)) return res.status(404).json({ error: "알 수 없는 키입니다." });
    const value = typeof req.body?.value === "string" ? req.body.value : "";
    const label = typeof req.body?.label === "string" ? req.body.label : undefined;
    await setPersonalKey(req.ownerId, name, value, label);
    res.json({ keys: await personalKeySummary(req.ownerId) });
  } catch (err) {
    if (err instanceof PersonalKeyInvalidError) return res.status(400).json({ error: err.message });
    next(err);
  }
});

meRouter.delete("/me/keys/:name/:id", async (req, res, next) => {
  try {
    const { name, id } = req.params;
    if (!isPersonalKeyName(name)) return res.status(404).json({ error: "알 수 없는 키입니다." });
    if (!(await deletePersonalKey(req.ownerId, name, id))) return res.status(404).json({ error: "등록되지 않은 토큰입니다." });
    res.json({ keys: await personalKeySummary(req.ownerId) });
  } catch (err) {
    next(err);
  }
});

meRouter.delete("/me/keys/:name", async (req, res, next) => {
  try {
    const { name } = req.params;
    if (!isPersonalKeyName(name)) return res.status(404).json({ error: "알 수 없는 키입니다." });
    await deletePersonalKey(req.ownerId, name);
    res.json({ keys: await personalKeySummary(req.ownerId) });
  } catch (err) {
    next(err);
  }
});
