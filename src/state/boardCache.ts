import * as api from "../api/client";
import type { BoardListResponse } from "../api/types";

/**
 * The board list as last seen, kept for the life of the page.
 *
 * Opening the board used to start from an empty list every time and draw
 * "불러오는 중…" until the request came back. The request itself is fast, but on
 * a slow link that blank moment is what reads as a slow page. The page now
 * draws this copy at once and refreshes it underneath; hovering the board
 * button starts the request early, so even the first visit usually has it.
 */
let cached: BoardListResponse | null = null;
let inflight: Promise<BoardListResponse> | null = null;

export function cachedBoardList(): BoardListResponse | null {
  return cached;
}

/** Fetches the list (sharing a request already on its way) and keeps the result. */
export function loadBoardList(): Promise<BoardListResponse> {
  if (inflight) return inflight;
  inflight = api
    .listBoardPosts()
    .then((body) => {
      cached = body;
      return body;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Warm the cache without caring about the outcome (pointer over the button). */
export function prefetchBoardList(): void {
  void loadBoardList().catch(() => {});
}
