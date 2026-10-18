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
  return inPrivilegedGroup(user);
}

/** PRIVILEGED_GROUPS 에 든 그룹의 구성원인가. 관리자라는 것과는 따로 본다. */
async function inPrivilegedGroup(user: Pick<UserRecord, "groupId">): Promise<boolean> {
  if (!user.groupId) return false;
  const group = await getGroup(user.groupId).catch(() => null);
  return Boolean(group) && privilegedGroupNames().includes(group!.name.trim().toLowerCase());
}

/**
 * 대화 공유 링크를 만들 주소. AI Product 구성원은 지금 연 주소 그대로(undefined),
 * 그 밖의 계정은 SHARE_BASE_URL — 서버의 실제 주소다. AI Product 팀은 서버를 다른
 * 이름으로도 열기 때문에, 지금 연 주소로 만든 링크는 그 이름을 모르는 사람에게
 * 열리지 않는다. 관리자라도 그 그룹이 아니면 실제 주소로 공유한다(공용 자원을 쓸
 * 수 있는지와는 다른 질문이다). 값이 http(s) 주소가 아니면 쓰지 않는다.
 */
export async function shareBaseUrlFor(user: Pick<UserRecord, "groupId"> | null | undefined): Promise<string | undefined> {
  const raw = process.env.SHARE_BASE_URL?.trim();
  if (!raw || !user) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (await inPrivilegedGroup(user)) return undefined;
  return url.toString().replace(/\/+$/, "");
}

export async function isPrivilegedOwner(ownerId: string | undefined): Promise<boolean> {
  if (!ownerId) return false;
  return isPrivilegedUser(await getUser(ownerId).catch(() => null));
}
