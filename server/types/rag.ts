/**
 * ONE uploaded document, at {DATA_DIR}/owners/{ownerId}/documents/{id}.json,
 * with its source text beside it as {id}.txt.
 *
 * `chunks` is written BEFORE the chunks reach the engine, not after. It is the
 * only record of what to clean up if indexing stops halfway, and a count
 * written afterwards would be missing in exactly the case it is needed.
 *
 * `scope` is what the reader sees, and it is the document's own property rather
 * than the owner's: publishing one document must not publish the rest.
 */
export type RagDocumentScope = "private" | "shared";

export interface RagDocument {
  id: string;
  /** As uploaded, after sanitising. Shown in the list and indexed as the chunk title. */
  name: string;
  mime: string;
  /** Source bytes, before chunking. */
  bytes: number;
  chars: number;
  chunks: number;
  /** Who chose the chunk boundaries: the model, or the rules. */
  chunkedBy: "llm" | "rule";
  scope: RagDocumentScope;
  /** "ready" once the engine has it; "failed" if it does not, with the reason. */
  status: "ready" | "failed";
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 공개 문서 한 건에 **누가 올렸는지**를 붙인 모양. 목록 응답에만 쓰인다.
 *
 * RagDocument 에 소유자를 넣지 않는 이유: 그건 파일이 어디에 놓였는지가 이미
 * 말해 주는 사실이고, 따로 적어 두면 둘이 어긋날 수 있다. 읽을 때 만든다.
 */
export interface SharedRagDocument extends RagDocument {
  ownerId: string;
  /** 계정이 지워졌으면 null. 없는 이름을 지어내지 않는다. */
  ownerName: string | null;
}
