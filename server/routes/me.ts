import { Router } from "express";
import { isPrivilegedUser } from "../auth/privilege.js";
import { config } from "../config.js";
import { probeEndpoint } from "../vllm/endpoints.js";
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

/**
 * wise 키는 저장하기 전에 게이트웨이에 물어본다 — 틀린 키를 받아 두면 다음 질문에서야
 * 실패한다. 공용 키로 묶인 기본 엔드포인트에 그 키로 모델 목록을 달라고 해서 401·403
 * 이면 거절한다. 게이트웨이에 닿지 못한 것은 키의 잘못이 아니므로 받아 둔다.
 */
async function wiseKeyRefused(value: string): Promise<boolean> {
  const target = config.vllmEnvEndpoints.find((endpoint) => endpoint.apiKey);
  if (!target || !value.trim()) return false;
  const probe = await probeEndpoint(target.baseUrl, value.trim());
  return !probe.ok && /^HTTP 40[13]$/.test(probe.detail ?? "");
}

meRouter.put("/me/keys/:name", async (req, res, next) => {
  try {
    const { name } = req.params;
    if (!isPersonalKeyName(name)) return res.status(404).json({ error: "알 수 없는 키입니다." });
    const value = typeof req.body?.value === "string" ? req.body.value : "";
    const label = typeof req.body?.label === "string" ? req.body.label : undefined;
    if (name === "wise" && (await wiseKeyRefused(value))) {
      return res.status(400).json({ error: "wise 모델 서버가 이 키를 받지 않습니다. 키를 다시 확인해 주세요." });
    }
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
