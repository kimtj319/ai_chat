import { isPrivilegedOwner, isPrivilegedUser } from "../auth/privilege.js";
import type { VllmEndpoint } from "../config.js";
import { getPersonalKey } from "../storage/personalKeys.js";
import { ownerKey, readModelOwners } from "../storage/modelOwners.js";
import { getUser } from "../storage/userStore.js";
import type { UserRecord } from "../types.js";
import { fetchCatalog } from "./client.js";
import { isEnvEndpoint } from "./endpoints.js";

/**
 * 누가 어느 모델을 쓸 수 있는가.
 *   - 공용 자원 계정(관리자·AI Product, auth/privilege.ts): 전부.
 *   - 그 밖의 계정: 기본 모델(VLLM_ENDPOINTS — 운영에서는 wise 모델만 둔다),
 *     본인이 화면에서 등록한 엔드포인트의 모델, 그리고 같은 그룹 사람이 등록한 엔드포인트의 모델.
 *     그룹은 등록할 때가 아니라 쓸 때 본다 — 등록한 사람이나 쓰는 사람이 그룹을 옮기면 공유도 따라간다.
 *     그룹이 없는 계정은 본인 것만, 등록한 사람이 기록되지 않은 엔드포인트는 공용 자원 계정만 쓴다.
 * 화면에서 가리는 것만으로는 부족하다 — 모델 선택·질문 전송·예약 실행이 모두 이 규칙을 지난다.
 */
export interface ModelAccess {
  privileged: boolean;
  allows(entry: { baseUrl: string }): boolean;
  /** 이 엔드포인트를 등록한 사람이 이 계정인가. */
  owns(baseUrl: string): boolean;
  /** 같은 그룹의 다른 사람이 등록한 엔드포인트인가. */
  sharedWithGroup(baseUrl: string): boolean;
}

export async function modelAccessFor(user: Pick<UserRecord, "id" | "role" | "groupId"> | null | undefined): Promise<ModelAccess> {
  const privileged = await isPrivilegedUser(user);
  const owners = await readModelOwners();
  const owns = (baseUrl: string) => Boolean(user) && owners[ownerKey(baseUrl)] === user!.id;
  const groupShared = new Set<string>();
  if (user?.groupId) {
    for (const [key, ownerId] of Object.entries(owners)) {
      if (ownerId === user.id) continue;
      const owner = await getUser(ownerId).catch(() => null);
      if (owner?.groupId === user.groupId) groupShared.add(key);
    }
  }
  const sharedWithGroup = (baseUrl: string) => groupShared.has(ownerKey(baseUrl));
  return {
    privileged,
    owns,
    sharedWithGroup,
    allows: (entry) => privileged || isEnvEndpoint(entry.baseUrl) || owns(entry.baseUrl) || sharedWithGroup(entry.baseUrl),
  };
}

export async function modelAccessForOwner(ownerId: string): Promise<ModelAccess> {
  return modelAccessFor(await getUser(ownerId).catch(() => null));
}

/** 본인 키가 있어야 하는데 없을 때. 문구는 그대로 화면에 나간다. */
export class ModelKeyRequiredError extends Error {
  constructor() {
    super("wise 모델을 쓰려면 설정 › 개인 키에서 'wise 모델 키'를 등록해 주세요.");
    this.name = "ModelKeyRequiredError";
  }
}

/**
 * 이 계정의 요청을 보낼 엔드포인트. 기본 모델(VLLM_ENDPOINTS — 운영에서는 wise 게이트웨이)은
 * 공용 키로 묶여 있어, 공용 자원 계정(관리자·AI Product, auth/privilege.ts)이 아니면
 * 본인이 등록한 wise 키로 보낸다 — 없으면 ModelKeyRequiredError. 다른 개인 키와 같이
 * 공용 자원 계정이라도 본인 키가 있으면 본인 키가 먼저다. 본인이 화면에서 등록한
 * 엔드포인트나 공용 키가 없는 엔드포인트는 그대로 둔다. 원래 객체는 바꾸지 않는다.
 */
export async function endpointForOwner(endpoint: VllmEndpoint, ownerId: string | undefined): Promise<VllmEndpoint> {
  if (!endpoint.apiKey || !isEnvEndpoint(endpoint.baseUrl)) return endpoint;
  const own = await getPersonalKey(ownerId, "wise");
  if (own) return { ...endpoint, apiKey: own };
  if (await isPrivilegedOwner(ownerId)) return endpoint;
  throw new ModelKeyRequiredError();
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
