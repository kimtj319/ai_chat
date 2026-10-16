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

export async function readModelOwners(): Promise<OwnerMap> {
  return (await readJsonFile<OwnerMap>(modelOwnersFile()).catch(() => null)) ?? {};
}

export async function modelOwnerOf(baseUrl: string): Promise<string | null> {
  return (await readModelOwners())[key(baseUrl)] ?? null;
}

export async function setModelOwner(baseUrl: string, ownerId: string): Promise<void> {
  await withLock(LOCK, async () => {
    const owners = await readModelOwners();
    await writeJsonFileAtomic(modelOwnersFile(), { ...owners, [key(baseUrl)]: ownerId });
  });
}

export async function removeModelOwner(baseUrl: string): Promise<void> {
  await withLock(LOCK, async () => {
    const owners = await readModelOwners();
    if (!(key(baseUrl) in owners)) return;
    delete owners[key(baseUrl)];
    await writeJsonFileAtomic(modelOwnersFile(), owners);
  });
}

export function ownerKey(baseUrl: string): string {
  return key(baseUrl);
}
