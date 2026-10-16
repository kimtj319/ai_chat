import { useEffect, useState } from "react";
import { getCompactionStatus } from "../api/client";
import type { CompactionKind } from "../api/types";

const POLL_MS = 1000;

/**
 * 이 페이지가 흘려 받고 있지 않은 압축 — 압축 도중 새로 고쳤거나 다시 연 페이지 —
 * 을 서버에 물어 진행률을 돌려준다. 서버는 압축을 끝까지 하고 저장하므로
 * (routes/conversations.ts) 끝나면 onFinished 로 대화를 다시 불러온다.
 *
 * `enabled` 가 거짓이면(이 페이지가 그 대화를 흘려 받는 중) 묻지 않는다 — 그때는
 * 스트림의 compaction 이벤트가 같은 값을 준다.
 */
export function useRemoteCompaction(
  conversationId: string | null,
  enabled: boolean,
  onFinished: () => void,
): { kind: CompactionKind; progress: number } | null {
  const [status, setStatus] = useState<{ kind: CompactionKind; progress: number } | null>(null);

  useEffect(() => {
    setStatus(null);
    if (!conversationId || !enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wasActive = false;
    const poll = async () => {
      try {
        const next = await getCompactionStatus(conversationId);
        if (cancelled) return;
        if (next.active) {
          wasActive = true;
          setStatus({ kind: next.kind, progress: next.progress });
          timer = setTimeout(() => void poll(), POLL_MS);
          return;
        }
        setStatus(null);
        if (wasActive) onFinished();
      } catch {
        // 한 번 못 물은 것은 다음 열기 때 다시 묻는다.
        if (!cancelled) setStatus(null);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // onFinished 는 매번 새로 만들어지는 함수라 의존성에 넣지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, enabled]);

  return status;
}
