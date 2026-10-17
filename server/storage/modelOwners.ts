import { readJsonFile, writeJsonFileAtomic } from "./atomic.js";
import { withLock } from "./mutex.js";
import { modelOwnersFile } from "./paths.js";

/**
 * 사용자가 화면에서 등록한 모델 엔드포인트의 등록자. `{DATA_DIR}/model-owners.json` 에
 * baseUrl(소문자) → 계정 id 로 둔다. .model 파일의 줄 모양(label|baseUrl|apiKey)은
 * VLLM_ENDPOINTS 와 같은 해석기를 쓰므로 거기에 칸을 늘리지 않고 따로 둔다.
 *
 * 여기에 없는 .model 의 항목(이 기능 전에 등록된 것, 손으로 넣은 것)은 등록자가 없다 —
 * 공용 자원을 쓰는 계정(auth/privilege.ts)만 쓸 수 있다.
 */
type OwnerMap = Record<string, string>;
const LOCK = "model-owners";
const key = (baseUrl: string) => baseUrl.trim().toLowerCase();

/** 권한을 볼 때 쓴다. 못 읽으면 "등록자 없음" 으로 넘어간다 — 요청을 실패시키지 않는다. */
export async function readModelOwners(): Promise<OwnerMap> {
  return (await readJsonFile<OwnerMap>(modelOwnersFile()).catch(() => null)) ?? {};
}

/**
 * 고쳐 쓸 때 쓴다. 이 파일은 모든 계정이 함께 쓰고 통째로 다시 쓰이므로, 읽기
 * 실패는 쓰기 실패여야 한다 — 빈 것으로 보고 계속하면 다음 쓰기가 제 항목 하나만
 * 남기고, 다른 계정은 모두 자기 엔드포인트를 잃는다(vllm/access.ts owns).
 */
async function readForUpdate(): Promise<OwnerMap> {
  return (await readJsonFile<OwnerMap>(modelOwnersFile())) ?? {};
}

export async function modelOwnerOf(baseUrl: string): Promise<string | null> {
  return (await readModelOwners())[key(baseUrl)] ?? null;
}

export async function setModelOwner(baseUrl: string, ownerId: string): Promise<void> {
  await withLock(LOCK, async () => {
    const owners = await readForUpdate();
    await writeJsonFileAtomic(modelOwnersFile(), { ...owners, [key(baseUrl)]: ownerId });
  });
}

export async function removeModelOwner(baseUrl: string): Promise<void> {
  await withLock(LOCK, async () => {
    const owners = await readForUpdate();
    if (!(key(baseUrl) in owners)) return;
    delete owners[key(baseUrl)];
    await writeJsonFileAtomic(modelOwnersFile(), owners);
  });
}

/**
 * 이 계정이 등록한 엔드포인트의 등록자 기록을 모두 지운다(계정 삭제). 엔드포인트
 * 자체는 .model 에 등록자 없이 남는다 — 공용 자원 계정만 쓸 수 있다. 남겨 두면 같은
 * id 로 다음에 가입한 사람이 그 엔드포인트를 쓰고 지울 수 있게 된다. 지운 수를 돌려준다.
 */
export async function removeModelOwnersOf(ownerId: string): Promise<number> {
  return withLock(LOCK, async () => {
    const owners = await readForUpdate();
    const mine = Object.keys(owners).filter((baseUrl) => owners[baseUrl] === ownerId);
    if (mine.length === 0) return 0;
    for (const baseUrl of mine) delete owners[baseUrl];
    await writeJsonFileAtomic(modelOwnersFile(), owners);
    return mine.length;
  });
}

export function ownerKey(baseUrl: string): string {
  return key(baseUrl);
}
