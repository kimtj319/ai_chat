import { LruCache } from "./lruCache";

/**
 * 출처 창이 한 번 불러온 문서를 붙잡아 두는 곳.
 *
 * 출처 "[n]" 을 누를 때마다 창의 본문이 새로 그려지는데, 예전에는 그때마다 문서를 다시
 * 받고 PDF 를 처음부터 다시 그렸다 — 같은 PDF 의 다른 단락을 눌러도 "PDF 를 그리는
 * 중…" 이 다시 떴다. 이제 문서 id 마다 한 벌을 남겨 두고, 다시 열면 그대로 붙인다.
 *
 * 메모리는 개수로 묶는다. PDF 는 그린 쪽(캔버스)이 커서 최근 4개만, 글로 된 문서는
 * 응답 글만이라 8개까지. 밀려난 PDF 는 pdf.js 문서와 캔버스를 놓는다(dispose).
 *
 * 이 파일은 pdf.js 를 끌어오지 않는다 — PDF 쪽 구현은 sourcePdf.ts 에 있고, 그 파일은
 * 출처를 처음 열 때만 받아 온다. 여기는 "있는가" 를 그 자리에서 알 수 있게만 한다.
 */

export interface PdfPlacement {
  /** 단락을 찾았는가. 못 찾으면 첫 쪽을 보여 준다. */
  found: boolean;
  page: number;
  pages: number;
}

/** 다 그려 둔 PDF 한 벌. 구현은 sourcePdf.ts 의 PdfView. */
export interface CachedPdf {
  readonly pages: number;
  /** 쪽들이 담긴 스크롤 칸을 이 자리로 옮겨 붙인다. */
  attach(slot: HTMLElement): void;
  /** 앞 강조를 지우고 이 단락을 칠한 뒤 그리로 스크롤한다. 쪽이 이미 그려져 있으면 그 자리에서 끝난다. */
  show(passage: string): PdfPlacement;
  dispose(): void;
}

/** 글로 보여 주는 문서의 응답. 단락 위치(ranges)는 단락마다 달라 여기 두지 않는다. */
export type TextLoad =
  | { kind: "text"; text: string; note?: string }
  /** 검색 색인에서 다시 엮은 글. 단락 순번으로 자리를 찾는다. */
  | { kind: "rebuilt"; text: string; note: string; chunks: Array<{ ord: number; start: number; end: number }> };

export const PDF_CACHE_LIMIT = 4;
export const TEXT_CACHE_LIMIT = 8;

export const pdfCache = new LruCache<string, CachedPdf>(PDF_CACHE_LIMIT, (pdf) => pdf.dispose());
export const textCache = new LruCache<string, TextLoad>(TEXT_CACHE_LIMIT);

/** 로그아웃하면 비운다 — 같은 탭에서 다른 계정으로 들어오면 앞 사람의 문서가 남아 있으면 안 된다. */
export function clearSourceCache(): void {
  pdfCache.clear();
  textCache.clear();
}
