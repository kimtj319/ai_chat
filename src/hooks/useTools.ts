import { useEffect, useState } from "react";
import { listTools } from "../api/client";
import type { ToolDefinition } from "../api/types";

export function useTools() {
  const [tools, setTools] = useState<ToolDefinition[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    listTools()
      .then((result) => {
        if (cancelled) return;
        setTools(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { tools, error, loading };
}
