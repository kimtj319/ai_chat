import { useEffect, useState } from "react";
import { getModels } from "../api/client";
import type { ModelCatalogEntry, ModelsResponse } from "../api/types";
import { errorMessage } from "../state/friendlyError";

// Three separate components read the catalog (the sidebar's model selector,
// its endpoint dialog, the chat view) and each holds its own copy. Registering
// a serving server has to reach all of them at once, or the new model stays
// invisible until a reload — which is the opposite of the point.
const listeners = new Set<() => void>();

/**
 * 같은 순간에 마운트된 셋이 요청 하나를 같이 기다린다 — 첫 로드에 /api/models 가 세 번
 * 나가던 것. 끝난 결과는 기억하지 않는다: 다음 마운트는 새로 받는다.
 */
let inflight: Promise<ModelsResponse> | null = null;
function sharedModels(): Promise<ModelsResponse> {
  if (!inflight) {
    const request = getModels().finally(() => {
      if (inflight === request) inflight = null;
    });
    inflight = request;
  }
  return inflight;
}

/** Make every mounted `useModels` refetch — call after changing endpoints. */
export function refreshModels(): void {
  // 바꾸기 전에 나간 요청의 답을 같이 받으면 바뀐 것이 안 보인다.
  inflight = null;
  for (const listener of listeners) listener();
}

export function useModels() {
  const [models, setModels] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [current, setCurrent] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const listener = () => setNonce((value) => value + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    sharedModels()
      .then((response) => {
        if (cancelled) return;
        setModels(response.models);
        setCatalog(response.catalog);
        setCurrent(response.current);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setModels([]);
        setCatalog([]);
        setCurrent("");
        setError(errorMessage(err));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [nonce]);

  return { models, catalog, current, error, loading };
}
