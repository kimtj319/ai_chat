import { useCallback, useEffect, useState } from "react";
import { listMcpServers, McpError } from "../api/client";
import type { McpServerSummary } from "../api/types";

export interface McpLibrary {
  servers: McpServerSummary[];
  adopted: string[];
  optedOutBuiltins: string[];
  loading: boolean;
  /**
   * The routes answered 404. That is "this backend has no MCP support", not a
   * failure the user can do anything about, so the library and the picker show
   * their empty state instead of an error.
   */
  unavailable: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

export function useMcpLibrary(): McpLibrary {
  const [servers, setServers] = useState<McpServerSummary[]>([]);
  const [adopted, setAdopted] = useState<string[]>([]);
  const [optedOutBuiltins, setOptedOutBuiltins] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const data = await listMcpServers();
      // Defaulted rather than trusted: a half-answered body must leave an empty
      // page behind, not a crash in the first `.filter` that reads it.
      setServers(data.servers ?? []);
      setAdopted(data.adopted ?? []);
      setOptedOutBuiltins(data.optedOutBuiltins ?? []);
      setUnavailable(false);
      setError(null);
    } catch (err) {
      const notDeployed = err instanceof McpError && err.status === 404;
      setServers([]);
      setAdopted([]);
      setOptedOutBuiltins([]);
      setUnavailable(notDeployed);
      setError(notDeployed ? null : err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { servers, adopted, optedOutBuiltins, loading, unavailable, error, reload };
}
