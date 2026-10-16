import { getGroup } from "../storage/groupStore.js";
import { getUser } from "../storage/userStore.js";
import type { UserRecord } from "../types.js";

/**
 * 공용 자원(공용 API 키, 공용 GitLab 토큰, 모든 모델)을 쓸 수 있는 계정인가.
 *
 * 관리자이거나, 이름이 PRIVILEGED_GROUPS(쉼표로 여럿, 기본 "AI Product")에 든 그룹의
 * 구성원이면 그렇다. 그 밖의 계정은 웹 검색·이슈 검색에 본인 키를 등록해야 하고,
 * 모델은 기본(wise) 모델과 본인이 등록한 모델만 쓴다.
 *
 * 그룹을 이름으로 가리는 이유: 그룹 id 는 관리 화면에서 만들 때 생기는 값이라 배포마다
 * 다르고, 사람이 알아보는 것은 이름이다. 이름이 바뀌면 권한도 바뀐다는 뜻이기도 하다.
 */
export function privilegedGroupNames(): string[] {
  const raw = process.env.PRIVILEGED_GROUPS;
  return (raw && raw.trim() ? raw.split(",") : ["AI Product"]).map((name) => name.trim().toLowerCase()).filter(Boolean);
}

export async function isPrivilegedUser(user: Pick<UserRecord, "role" | "groupId"> | null | undefined): Promise<boolean> {
  if (!user) return false;
  if (user.role === "admin") return true;
  if (!user.groupId) return false;
  const group = await getGroup(user.groupId).catch(() => null);
  return Boolean(group) && privilegedGroupNames().includes(group!.name.trim().toLowerCase());
}

export async function isPrivilegedOwner(ownerId: string | undefined): Promise<boolean> {
  if (!ownerId) return false;
  return isPrivilegedUser(await getUser(ownerId).catch(() => null));
}
