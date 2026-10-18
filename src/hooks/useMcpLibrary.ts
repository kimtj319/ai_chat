import { useCallback, useEffect, useState } from "react";
import { listMcpServers, McpError } from "../api/client";
import type { McpServerSummary, McpServersResponse } from "../api/types";
import { errorMessage } from "../state/friendlyError";

export interface McpLibrary {
  servers: McpServerSummary[];
  adopted: string[];
  /** Ids of any server (builtin, self-registered or adopted) this user switched off. */
  hidden: string[];
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

/**
 * 대화 화면과 + 메뉴의 도구 고르기가 거의 같은 때 마운트되어 목록을 두 번 받던 것.
 * 마운트할 때는 진행 중인 요청이나 몇 초 안에 받은 답을 같이 쓴다. reload() 는 늘
 * 새로 받는다(라이브러리에서 무언가 바꾼 뒤) — 그 답이 다음 마운트의 몫이 된다.
 */
const SHARED_FRESH_MS = 5000;
let shared: { at: number; request: Promise<McpServersResponse> } | null = null;
function loadServers(force: boolean): Promise<McpServersResponse> {
  const now = Date.now();
  if (force || !shared || now - shared.at > SHARED_FRESH_MS) {
    const request = listMcpServers();
    shared = { at: now, request };
    // 실패는 같이 쓰지 않는다 — 다음 마운트가 다시 해 본다.
    request.catch(() => {
      if (shared?.request === request) shared = null;
    });
  }
  return shared.request;
}

export function useMcpLibrary(): McpLibrary {
  const [servers, setServers] = useState<McpServerSummary[]>([]);
  const [adopted, setAdopted] = useState<string[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (force: boolean) => {
    try {
      const data = await loadServers(force);
      // Defaulted rather than trusted: a half-answered body must leave an empty
      // page behind, not a crash in the first `.filter` that reads it.
      setServers(data.servers ?? []);
      setAdopted(data.adopted ?? []);
      setHidden(data.hidden ?? []);
      setUnavailable(false);
      setError(null);
    } catch (err) {
      const notDeployed = err instanceof McpError && err.status === 404;
      setServers([]);
      setAdopted([]);
      setHidden([]);
      setUnavailable(notDeployed);
      setError(notDeployed ? null : errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const reload = useCallback(() => load(true), [load]);

  useEffect(() => {
    void load(false);
  }, [load]);

  return { servers, adopted, hidden, loading, unavailable, error, reload };
}
