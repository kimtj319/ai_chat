// Pure logic behind the 모델 연동 dialog: what a pasted address means, what a
// refusal says in Korean, and what one row of the list is allowed to offer.
// No React, so the harness can exercise all three directly.

import type { ModelEndpoint, ModelEndpointErrorCode } from "../api/types";
import { formatEndpointHost } from "./modelCatalog";

export type NormalizedEndpoint = { ok: true; baseUrl: string; host: string } | { ok: false };

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Accept what a user will actually paste — "10.0.0.10:8000",
 * "http://10.0.0.10:8000", or ".../v1" — and tidy it just enough to
 * send. The server does the authoritative normalisation, so nothing is
 * appended here; only a missing scheme and a trailing slash are fixed.
 */
export function normalizeEndpointInput(raw: string): NormalizedEndpoint {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false };
  // A space can never appear in an authority, and letting one through would
  // reach the URL parser as a path and quietly "succeed".
  if (/\s/.test(trimmed)) return { ok: false };

  // "myserver:8000" parses as scheme "myserver" unless we look for "://".
  const withScheme = HAS_SCHEME.test(trimmed) ? trimmed : `http://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ok: false };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false };
  if (parsed.hostname.length === 0) return { ok: false };

  const path = parsed.pathname.replace(/\/+$/, "");
  const baseUrl = `${parsed.protocol}//${parsed.host}${path}`;
  return { ok: true, baseUrl, host: formatEndpointHost(baseUrl) };
}

/** The Korean copy for each refusal the server can send back. */
export function endpointErrorMessage(code: ModelEndpointErrorCode | null, host: string): string {
  switch (code) {
    case "invalid_url":
      return "주소 형식이 올바르지 않습니다.";
    case "not_vllm":
      return `vLLM 서버로 보이지 않습니다: ${host} (모델 목록을 받지 못했습니다)`;
    case "duplicate":
      return `이미 등록된 주소입니다: ${host}`;
    case "forbidden":
      return "권한이 없습니다. 관리 토큰을 확인하세요.";
    case "write_failed":
      return "설정 파일에 저장하지 못했습니다.";
    case "unreachable":
    default:
      // An unmapped failure is almost always the endpoint not answering.
      return `서버에 연결할 수 없습니다: ${host}`;
  }
}

export function connectedMessage(models: string[]): string {
  return `연결됨: 모델 ${models.length}개 (${models.join(", ")})`;
}

export interface EndpointRow {
  host: string;
  label: string;
  models: string;
  reachable: boolean;
  statusText: string;
  /** False for an "env" entry: DELETE would 409, so no button is offered. */
  removable: boolean;
  /** Why it cannot be removed, or null when it can. */
  sourceNote: string | null;
}

export const ENV_SOURCE_NOTE = "환경변수로 지정된 서버는 여기서 제거할 수 없습니다.";

/** Everything one row of the endpoint list renders, decided in one place. */
export function endpointRow(entry: ModelEndpoint): EndpointRow {
  const host = formatEndpointHost(entry.baseUrl);
  return {
    host,
    label: entry.label.trim().length > 0 ? entry.label : host,
    models: entry.models.length > 0 ? entry.models.join(", ") : "모델 없음",
    reachable: entry.reachable,
    statusText: entry.reachable ? "연결됨" : "연결할 수 없음",
    removable: entry.source !== "env",
    sourceNote: entry.source === "env" ? ENV_SOURCE_NOTE : null,
  };
}
