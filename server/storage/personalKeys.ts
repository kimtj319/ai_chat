import { readJsonFile, writeJsonFileAtomic } from "./atomic.js";
import { withLock } from "./mutex.js";
import { ownerKeysFile } from "./paths.js";

/**
 * 계정마다 본인이 등록한 외부 서비스 키(웹 검색·GitLab·Alpha Vantage). `{DATA_DIR}/owners/<id>/keys.json`.
 *
 * 공용 키를 쓸 수 있는 계정(auth/privilege.ts)이 아니면 이 키가 있어야 그 기능을 쓴다.
 * 공용 키를 쓸 수 있는 계정이라도 본인 키를 등록하면 본인 키가 먼저 쓰인다.
 * 키는 API 로 되돌려 주지 않는다 — 등록 여부와 끝 네 자리만 보인다.
 */
export const PERSONAL_KEYS = {
  tavily: { label: "웹 검색(Tavily) API 키" },
  gitlab: { label: "GitLab 토큰(wisenut 이슈)" },
  alphavantage: { label: "Alpha Vantage API 키" },
} as const;

export type PersonalKeyName = keyof typeof PERSONAL_KEYS;

export function isPersonalKeyName(name: unknown): name is PersonalKeyName {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(PERSONAL_KEYS, name);
}

type KeyFile = Partial<Record<PersonalKeyName, string>>;

const lockFor = (ownerId: string) => `keys:${ownerId}`;

async function read(ownerId: string): Promise<KeyFile> {
  return (await readJsonFile<KeyFile>(ownerKeysFile(ownerId)).catch(() => null)) ?? {};
}

export async function getPersonalKey(ownerId: string | undefined, name: PersonalKeyName): Promise<string | null> {
  if (!ownerId) return null;
  const value = (await read(ownerId))[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export class PersonalKeyInvalidError extends Error {}

export async function setPersonalKey(ownerId: string, name: PersonalKeyName, raw: string): Promise<void> {
  const value = raw.trim();
  if (value.length < 8 || value.length > 400 || /\s/.test(value)) {
    throw new PersonalKeyInvalidError("키는 공백 없이 8~400자여야 합니다.");
  }
  await withLock(lockFor(ownerId), async () => {
    const keys = await read(ownerId);
    await writeJsonFileAtomic(ownerKeysFile(ownerId), { ...keys, [name]: value });
  });
}

export async function deletePersonalKey(ownerId: string, name: PersonalKeyName): Promise<boolean> {
  return withLock(lockFor(ownerId), async () => {
    const keys = await read(ownerId);
    if (!keys[name]) return false;
    delete keys[name];
    await writeJsonFileAtomic(ownerKeysFile(ownerId), keys);
    return true;
  });
}

/** 화면에 보일 것: 등록 여부와 끝 네 자리. */
export async function personalKeySummary(ownerId: string): Promise<Record<PersonalKeyName, { set: boolean; hint: string | null }>> {
  const keys = await read(ownerId);
  const out = {} as Record<PersonalKeyName, { set: boolean; hint: string | null }>;
  for (const name of Object.keys(PERSONAL_KEYS) as PersonalKeyName[]) {
    const value = keys[name];
    out[name] = value ? { set: true, hint: `…${value.slice(-4)}` } : { set: false, hint: null };
  }
  return out;
}
