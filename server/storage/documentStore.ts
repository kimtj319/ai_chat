/**
 * Uploaded documents on disk: the source text, and the metadata beside it.
 *
 * The engine holds the searchable chunks, but this is the system of record.
 * That direction matters — it is what makes "publish this document" and "re-cut
 * the chunks" possible at all, since both need the original text back, and the
 * engine only ever had pieces of it.
 *
 * Same shape and the same atomic writes as attachmentStore, which this is
 * deliberately a sibling of rather than a generalisation: the two differ in
 * lifetime (a conversation's vs an account's) and that difference is the whole
 * reason both exist.
 */
import fs from "node:fs/promises";
import { readJsonFile, readdirOrEmpty, writeFileAtomic, writeJsonFileAtomic } from "./atomic.js";
import {
  documentChunksFile,
  documentMetaFile,
  documentOriginalFile,
  documentSourceFile,
  documentTextFile,
  documentsDir,
  isValidId,
  ownersRoot,
} from "./paths.js";
import type { RagDocument } from "../types.js";

/** PDF 원본을 그대로 둔다. 여러 조각으로 나뉜 PDF 는 조각마다 한 벌씩 — 한 조각을 지워도 나머지가 원본을 잃지 않는다. */
export async function saveDocumentSource(ownerId: string, documentId: string, bytes: Buffer): Promise<void> {
  await writeFileAtomic(documentSourceFile(ownerId, documentId), bytes);
}

/** 원본이 있으면 그 경로, 없으면 null. */
export async function documentSourcePath(ownerId: string, documentId: string): Promise<string | null> {
  const file = documentSourceFile(ownerId, documentId);
  try {
    await fs.access(file);
    return file;
  } catch {
    return null;
  }
}

/** 올린 텍스트 파일의 원본 글. 조각이 여럿이어도 한 번만 쓴다 — 조각들은 메타의 originalId 로 가리킨다. */
export async function saveDocumentOriginal(ownerId: string, originalId: string, text: string): Promise<void> {
  await writeFileAtomic(documentOriginalFile(ownerId, originalId), text);
}

export async function readDocumentOriginal(ownerId: string, originalId: string): Promise<string | null> {
  if (!isValidId(originalId)) return null;
  try {
    return await fs.readFile(documentOriginalFile(ownerId, originalId), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function saveDocumentText(ownerId: string, documentId: string, text: string): Promise<void> {
  await writeFileAtomic(documentTextFile(ownerId, documentId), text);
}

export async function readDocumentText(ownerId: string, documentId: string): Promise<string | null> {
  try {
    return await fs.readFile(documentTextFile(ownerId, documentId), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export interface StoredChunk {
  text: string;
  /** 앞 청크에서 이월된 머리 글자 수. 뷰어가 겹침과 본문을 갈라 보여 준다. */
  overlapLen: number;
}

/** The chunks as indexed. Written after a successful index, read by the viewer. */
export async function saveDocumentChunks(ownerId: string, documentId: string, chunks: StoredChunk[]): Promise<void> {
  await writeJsonFileAtomic(documentChunksFile(ownerId, documentId), chunks);
}

/**
 * What is on disk, which is one of two shapes: the first sidecars were plain
 * strings. The caller normalises — reading an older document must not require
 * indexing it again.
 */
export async function readDocumentChunks(
  ownerId: string,
  documentId: string,
): Promise<Array<string | StoredChunk> | null> {
  return readJsonFile<Array<string | StoredChunk>>(documentChunksFile(ownerId, documentId));
}

export async function saveDocumentMeta(ownerId: string, meta: RagDocument): Promise<void> {
  await writeJsonFileAtomic(documentMetaFile(ownerId, meta.id), meta);
}

export async function getDocument(ownerId: string, documentId: string): Promise<RagDocument | null> {
  if (!isValidId(documentId)) return null;
  return readJsonFile<RagDocument>(documentMetaFile(ownerId, documentId));
}

/** Newest first, which is the order the page shows them in and the order people look for. */
export async function listDocuments(ownerId: string): Promise<RagDocument[]> {
  const docs: RagDocument[] = [];
  for (const entry of await readdirOrEmpty(documentsDir(ownerId))) {
    // `.chunks.json` is a sidecar of a document, not a document — matching on
    // ".json" alone would list every document twice, the second time with a
    // null meta that silently disappears.
    if (!entry.endsWith(".json") || entry.endsWith(".chunks.json")) continue;
    // One unreadable file is skipped, not thrown: through listSharedDocuments
    // it would otherwise fail the 문서 page for every account, not just this one.
    try {
      const meta = await readJsonFile<RagDocument>(documentMetaFile(ownerId, entry.slice(0, -".json".length)));
      if (meta) docs.push(meta);
    } catch (err) {
      console.warn(`[documentStore] skipping corrupt document file "${entry}" (owner ${ownerId}):`, err);
    }
  }
  docs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return docs;
}

/**
 * Forget a document locally. The engine's copy is removed by the caller first —
 * doing it the other way round would leave a document that is gone from the
 * page but still turns up in search, with nothing left to identify it by.
 */
export async function deleteDocumentFiles(ownerId: string, documentId: string): Promise<void> {
  const originalId = (await getDocument(ownerId, documentId))?.originalId;
  await Promise.all([
    fs.rm(documentTextFile(ownerId, documentId), { force: true }),
    fs.rm(documentMetaFile(ownerId, documentId), { force: true }),
    fs.rm(documentChunksFile(ownerId, documentId), { force: true }),
    fs.rm(documentSourceFile(ownerId, documentId), { force: true }),
  ]);
  // 원본은 같은 파일에서 나온 조각들이 함께 쓴다. 마지막 조각이 지워질 때만 지운다 —
  // 한 조각을 지웠다고 남은 조각이 원본을 잃으면 안 된다. 지우기는 소유자의 색인
  // 잠금 안에서 하나씩 돌므로 두 조각이 서로를 "아직 남았다" 고 볼 일은 없다.
  if (originalId && isValidId(originalId)) {
    const stillUsed = (await listDocuments(ownerId)).some((d) => d.originalId === originalId);
    if (!stillUsed) await fs.rm(documentOriginalFile(ownerId, originalId), { force: true });
  }
}

/**
 * 소유자까지 붙은 문서. **저장하지 않고 읽을 때 만든다** — 소유자는 파일이
 * 어디에 놓여 있는지가 이미 말해 주고, 따로 적어 두면 둘이 어긋날 수 있다.
 */
export interface OwnedRagDocument extends RagDocument {
  ownerId: string;
}

/**
 * 모두에게 공개된 문서 전부. 소유자를 가로질러 모은다.
 *
 * 왜 필요한가: 문서 페이지는 여태 **자기 것만** 보여 주었다. 그런데 공개 문서는
 * 이미 모두의 검색에 걸린다 — 화면에 없을 뿐 답변에는 나온다. 그 간극이
 * "이 내용은 어디서 온 거지" 를 물어볼 데 없는 상태로 만들었다.
 *
 * 공개(shared)만 담는다. 이 함수가 비공개를 한 건이라도 흘리면 그건 남의
 * 문서 목록을 보여 주는 일이 되므로, 거르는 조건은 여기 한 곳에만 둔다.
 */
export async function listSharedDocuments(): Promise<OwnedRagDocument[]> {
  const docs: OwnedRagDocument[] = [];
  for (const ownerId of await readdirOrEmpty(ownersRoot())) {
    // 디렉터리 이름이 곧 계정 id 다. 이상한 이름은 우리가 만든 것이 아니다.
    if (!isValidId(ownerId)) continue;
    for (const doc of await listDocuments(ownerId)) {
      if (doc.scope !== "shared") continue;
      docs.push({ ...doc, ownerId });
    }
  }
  docs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return docs;
}

/**
 * 공개 문서 하나를 id 로 찾는다. 누가 올렸든 상관없다.
 *
 * 원문 보기를 위한 것이다. 공개 문서의 내용은 이미 RAG 검색으로 모두가 읽을 수
 * 있으므로, 목록에 올려 놓고 못 열게 하는 것이 오히려 앞뒤가 안 맞는다.
 * **비공개는 절대 여기로 나오지 않는다** — listSharedDocuments 를 거치기 때문이다.
 */
export async function findSharedDocument(documentId: string): Promise<OwnedRagDocument | null> {
  if (!isValidId(documentId)) return null;
  const all = await listSharedDocuments();
  return all.find((d) => d.id === documentId) ?? null;
}
