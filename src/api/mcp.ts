import { errorMessage } from "../state/friendlyError";
import { apiPath } from "./base";
import { ApiError, notifyUnauthorized, readErrorBody } from "./http";
import type { CreateMcpServerRequest, McpHealth, McpServerSummary, McpServersResponse, McpToolSummary, PatchMcpServerRequest } from "./types";

// ---- MCP servers ----
//
// Their own fetch helper, like the auth and endpoint groups, for one
// reason `request()` cannot serve: the status code has to survive. A 404 here
// means the routes are not deployed, which the library page renders as an
// empty library rather than as a failure the user is asked to act on, and a
// 409 on a delete carries how many people adopted the server.

export class McpError extends ApiError {
  readonly status: number;
  /** Only set on the 409 a registrant gets when others adopted the server. */
  readonly adoptedCount: number | null;

  constructor(message: string, status: number, adoptedCount: number | null = null) {
    super(message);
    this.status = status;
    this.adoptedCount = adoptedCount;
  }
}

async function mcpRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(apiPath(path), {
      credentials: "include",
      headers: init?.body ? { "Content-Type": "application/json" } : undefined,
      ...init,
    });
  } catch (error) {
    throw new McpError(`서버에 연결할 수 없습니다: ${errorMessage(error)}`, 0);
  }

  if (!response.ok) {
    if (response.status === 401) notifyUnauthorized();
    const body = await readErrorBody(response);
    // Not JSON — the status line is all we have.
    throw new McpError(body.error ?? `요청이 실패했습니다 (${response.status})`, response.status, body.adoptedCount);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function listMcpServers(): Promise<McpServersResponse> {
  return mcpRequest<McpServersResponse>("/mcp/servers");
}

export function createMcpServer(body: CreateMcpServerRequest): Promise<{ server: McpServerSummary }> {
  return mcpRequest<{ server: McpServerSummary }>("/mcp/servers", { method: "POST", body: JSON.stringify(body) });
}

export async function updateMcpServer(id: string, patch: PatchMcpServerRequest): Promise<void> {
  await mcpRequest<unknown>(`/mcp/servers/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export async function deleteMcpServer(id: string): Promise<void> {
  await mcpRequest<unknown>(`/mcp/servers/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Take a server into (or out of) the signed-in user's own library. */
export function setMcpAdoption(id: string, adopted: boolean): Promise<{ adopted: string[] }> {
  return mcpRequest<{ adopted: string[] }>(`/mcp/servers/${encodeURIComponent(id)}/adoption`, {
    method: "PUT",
    body: JSON.stringify({ adopted }),
  });
}

/** Switch a server's tools on/off in the picker and in the model's prompt —
 *  same call for a builtin, a self-registered server or an adopted one. */
export function setMcpHidden(id: string, hidden: boolean): Promise<{ hidden: string[] }> {
  return mcpRequest<{ hidden: string[] }>(`/mcp/servers/${encodeURIComponent(id)}/hidden`, {
    method: "PUT",
    body: JSON.stringify({ hidden }),
  });
}

/** `null` clears it. The value is passed straight through and never stored here. */
export function setMcpCredential(id: string, credential: string | null): Promise<{ hasCredential: boolean }> {
  return mcpRequest<{ hasCredential: boolean }>(`/mcp/servers/${encodeURIComponent(id)}/credential`, {
    method: "PUT",
    body: JSON.stringify({ credential }),
  });
}

export function probeMcpServer(id: string): Promise<{ health: McpHealth; tools: McpToolSummary[] }> {
  return mcpRequest<{ health: McpHealth; tools: McpToolSummary[] }>(`/mcp/servers/${encodeURIComponent(id)}/probe`, {
    method: "POST",
  });
}

/** Administrator only: take a server out of service for everyone. */
export async function setMcpServerStatus(id: string, disabled: boolean, reason?: string): Promise<void> {
  await mcpRequest<unknown>(`/admin/mcp/servers/${encodeURIComponent(id)}/status`, {
    method: "PUT",
    body: JSON.stringify(reason ? { disabled, reason } : { disabled }),
  });
}
