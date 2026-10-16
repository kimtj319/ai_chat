import { isPrivilegedUser } from "../auth/privilege.js";
import { ownerKey, readModelOwners } from "../storage/modelOwners.js";
import { getUser } from "../storage/userStore.js";
import type { UserRecord } from "../types.js";
import { fetchCatalog } from "./client.js";
import { isEnvEndpoint } from "./endpoints.js";

/**
 * 누가 어느 모델을 쓸 수 있는가.
 *   - 공용 자원 계정(관리자·AI Product, auth/privilege.ts): 전부.
 *   - 그 밖의 계정: 기본 모델(VLLM_ENDPOINTS — 운영에서는 wise 모델만 둔다)과
 *     본인이 화면에서 등록한 엔드포인트의 모델.
 * 화면에서 가리는 것만으로는 부족하다 — 모델 선택·질문 전송·예약 실행이 모두 이 규칙을 지난다.
 */
export interface ModelAccess {
  privileged: boolean;
  allows(entry: { baseUrl: string }): boolean;
  /** 이 엔드포인트를 등록한 사람이 이 계정인가. */
  owns(baseUrl: string): boolean;
}

export async function modelAccessFor(user: Pick<UserRecord, "id" | "role" | "groupId"> | null | undefined): Promise<ModelAccess> {
  const privileged = await isPrivilegedUser(user);
  const owners = await readModelOwners();
  const owns = (baseUrl: string) => Boolean(user) && owners[ownerKey(baseUrl)] === user!.id;
  return {
    privileged,
    owns,
    allows: (entry) => privileged || isEnvEndpoint(entry.baseUrl) || owns(entry.baseUrl),
  };
}

export async function modelAccessForOwner(ownerId: string): Promise<ModelAccess> {
  return modelAccessFor(await getUser(ownerId).catch(() => null));
}

/**
 * 이 계정이 고를 수 없는 모델인가. 목록에 있는데 허용된 엔드포인트가 하나도 그 모델을
 * 내지 않을 때만 참이다 — 목록에 없는 id(지워진 모델, 목록을 못 가져온 때)는 지금처럼
 * 받아 두고, 질문할 때 resolveModel 이 쓸 수 있는 모델로 돌린다.
 */
export async function modelIsForbidden(access: ModelAccess, modelId: string): Promise<boolean> {
  const wanted = modelId.trim();
  if (!wanted || access.privileged) return false;
  const entries = (await fetchCatalog().catch(() => [])).filter((e) => e.id === wanted);
  return entries.length > 0 && !entries.some(access.allows);
}
