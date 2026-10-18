import { readJsonFile, writeJsonFileAtomic } from "./atomic.js";
import { withLock } from "./mutex.js";
import { ownerKeysFile } from "./paths.js";

/**
 * 계정마다 본인이 등록한 외부 서비스 키(wise 모델·웹 검색·GitLab·Alpha Vantage). `{DATA_DIR}/owners/<id>/keys.json`.
 *
 * 공용 키를 쓸 수 있는 계정(auth/privilege.ts)이 아니면 이 키가 있어야 그 기능을 쓴다.
 * 공용 키를 쓸 수 있는 계정이라도 본인 키를 등록하면 본인 키가 먼저 쓰인다.
 * 키는 API 로 되돌려 주지 않는다 — 등록 여부와 끝 네 자리만 보인다.
 */
export const PERSONAL_KEYS = {
  wise: { label: "wise 모델 키" },
  tavily: { label: "웹 검색(Tavily) API 키" },
  gitlab: { label: "GitLab 토큰(wisenut 이슈)" },
  alphavantage: { label: "Alpha Vantage API 키" },
} as const;

export type PersonalKeyName = keyof typeof PERSONAL_KEYS;

export function isPersonalKeyName(name: unknown): name is PersonalKeyName {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(PERSONAL_KEYS, name);
}

/**
 * GitLab 은 토큰을 여러 개 둘 수 있다 — 프로젝트마다 발급한 토큰을 따로 넣어
 * 여러 프로젝트를 함께 본다(gitlabmcp 가 토큰마다 볼 수 있는 프로젝트를 찾는다).
 * 나머지는 키 하나다.
 */
const MULTI: ReadonlySet<PersonalKeyName> = new Set<PersonalKeyName>(["gitlab"]);
export const MAX_MULTI_KEYS = 10;

interface KeyEntry {
  id: string;
  token: string;
  label?: string;
}

/** 저장 모양. 예전 파일의 gitlab 은 문자열 하나였다 — 읽을 때 목록 하나로 바꾼다. */
type KeyFile = Partial<Record<PersonalKeyName, string | KeyEntry[]>>;

const lockFor = (ownerId: string) => `keys:${ownerId}`;

/** 키를 쓰거나 보여 줄 때. 못 읽으면 "키 없음" 으로 넘어간다 — 요청을 실패시키지 않는다. */
async function read(ownerId: string): Promise<KeyFile> {
  return (await readJsonFile<KeyFile>(ownerKeysFile(ownerId)).catch(() => null)) ?? {};
}

/** 고쳐 쓸 때. 파일을 통째로 다시 쓰므로 읽기 실패는 쓰기 실패여야 한다 — 아니면 나머지 키가 지워진다. */
async function readForUpdate(ownerId: string): Promise<KeyFile> {
  return (await readJsonFile<KeyFile>(ownerKeysFile(ownerId))) ?? {};
}

function entriesOf(value: string | KeyEntry[] | undefined): KeyEntry[] {
  if (typeof value === "string") return value ? [{ id: "k1", token: value }] : [];
  return Array.isArray(value) ? value.filter((e) => e && typeof e.token === "string" && e.token) : [];
}

/** 등록된 키 전부(GitLab 은 여러 개, 나머지는 많아야 하나). */
export async function getPersonalKeys(ownerId: string | undefined, name: PersonalKeyName): Promise<string[]> {
  if (!ownerId) return [];
  return entriesOf((await read(ownerId))[name]).map((e) => e.token);
}

export async function getPersonalKey(ownerId: string | undefined, name: PersonalKeyName): Promise<string | null> {
  return (await getPersonalKeys(ownerId, name))[0] ?? null;
}

export class PersonalKeyInvalidError extends Error {}

/** 하나짜리 키는 바꾸고, GitLab 은 덧붙인다(같은 토큰은 한 번만). */
export async function setPersonalKey(ownerId: string, name: PersonalKeyName, raw: string, rawLabel?: string): Promise<void> {
  const value = raw.trim();
  if (value.length < 8 || value.length > 400 || /\s/.test(value)) {
    throw new PersonalKeyInvalidError("키는 공백 없이 8~400자여야 합니다.");
  }
  const label = typeof rawLabel === "string" ? rawLabel.trim().slice(0, 60) : "";
  await withLock(lockFor(ownerId), async () => {
    const keys = await readForUpdate(ownerId);
    if (!MULTI.has(name)) {
      await writeJsonFileAtomic(ownerKeysFile(ownerId), { ...keys, [name]: value });
      return;
    }
    const entries = entriesOf(keys[name]);
    if (entries.some((e) => e.token === value)) throw new PersonalKeyInvalidError("이미 등록한 토큰입니다.");
    if (entries.length >= MAX_MULTI_KEYS) throw new PersonalKeyInvalidError(`토큰은 ${MAX_MULTI_KEYS}개까지 등록할 수 있습니다.`);
    const id = `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await writeJsonFileAtomic(ownerKeysFile(ownerId), { ...keys, [name]: [...entries, { id, token: value, ...(label ? { label } : {}) }] });
  });
}

/** entryId 가 있으면 그 하나만, 없으면 그 이름의 키 전부를 지운다. */
export async function deletePersonalKey(ownerId: string, name: PersonalKeyName, entryId?: string): Promise<boolean> {
  return withLock(lockFor(ownerId), async () => {
    const keys = await readForUpdate(ownerId);
    if (!keys[name]) return false;
    if (entryId && MULTI.has(name)) {
      const entries = entriesOf(keys[name]);
      const next = entries.filter((e) => e.id !== entryId);
      if (next.length === entries.length) return false;
      if (next.length > 0) keys[name] = next;
      else delete keys[name];
    } else {
      delete keys[name];
    }
    await writeJsonFileAtomic(ownerKeysFile(ownerId), keys);
    return true;
  });
}

export interface PersonalKeyState {
  set: boolean;
  hint: string | null;
  /** GitLab 처럼 여러 개를 두는 키의 하나하나(값은 끝 네 자리만). */
  items?: Array<{ id: string; label: string | null; hint: string }>;
}

/** 화면에 보일 것: 등록 여부와 끝 네 자리. */
export async function personalKeySummary(ownerId: string): Promise<Record<PersonalKeyName, PersonalKeyState>> {
  const keys = await read(ownerId);
  const out = {} as Record<PersonalKeyName, PersonalKeyState>;
  for (const name of Object.keys(PERSONAL_KEYS) as PersonalKeyName[]) {
    const entries = entriesOf(keys[name]);
    const first = entries[0];
    out[name] = {
      set: entries.length > 0,
      hint: first ? `…${first.token.slice(-4)}` : null,
      ...(MULTI.has(name) ? { items: entries.map((e) => ({ id: e.id, label: e.label ?? null, hint: `…${e.token.slice(-4)}` })) } : {}),
    };
  }
  return out;
}
