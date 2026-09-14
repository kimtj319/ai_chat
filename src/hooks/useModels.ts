import { useEffect, useState } from "react";
import { getModels } from "../api/client";
import type { ModelCatalogEntry } from "../api/types";

// Three separate components read the catalog (the sidebar's model selector,
// its endpoint dialog, the chat view) and each holds its own copy. Registering
// a serving server has to reach all of them at once, or the new model stays
// invisible until a reload — which is the opposite of the point.
const listeners = new Set<() => void>();

/** Make every mounted `useModels` refetch — call after changing endpoints. */
export function refreshModels(): void {
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

    getModels()
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
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [nonce]);

  return { models, catalog, current, error, loading };
}
