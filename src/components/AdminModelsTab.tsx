import { useCallback, useEffect, useState } from "react";
import * as api from "../api/client";
import type { ModelCatalogEntry, ModelEndpoint } from "../api/types";

/** "http://10.0.0.2:30023/v1" → 보이는 조각들. 포트를 안 적었으면 스킴의 기본값을 밝힌다. */
function partsOf(baseUrl: string): { scheme: string; host: string; port: string; path: string } {
  try {
    const url = new URL(baseUrl);
    const scheme = url.protocol.replace(":", "");
    const port = url.port || (scheme === "https" ? "443 (기본)" : "80 (기본)");
    return { scheme, host: url.hostname, port, path: url.pathname || "/" };
  } catch {
    return { scheme: "-", host: baseUrl, port: "-", path: "-" };
  }
}

const KIND: Record<string, string> = {
  chat: "대화",
  embedding: "임베딩",
  rerank: "재순위(rerank)",
  unusable: "사용 불가",
};

/** REASONING_PROFILES 의 값을 사람 말로. */
function reasoningLabel(entry: ModelCatalogEntry | undefined): string {
  if (!entry) return "-";
  if (entry.capability && entry.capability !== "chat") return "해당 없음";
  const profile = entry.reasoningProfile ?? (entry.reasoningFixed ? "fixed" : "budget:128");
  if (profile === "fixed") return "항상 생각함 (조절 불가)";
  const min = /^budget:(\d+)$/.exec(profile)?.[1];
  return min ? `생각 길이 조절 · 최소 ${Number(min).toLocaleString()} 토큰` : profile;
}

/**
 * 관리자 메뉴 › 모델 — 지금 연결된 서빙 서버와 그 서버가 내주는 모델.
 *
 * 서버마다 주소를 스킴·호스트(IP)·포트·경로로 나눠 보이고, 모델마다 종류(대화·임베딩·재순위),
 * 컨텍스트 길이, 추론 조절 방식(REASONING_PROFILES)을 보인다. 고치는 곳은 사이드바 설정의
 * "모델 연동" 이다 — 여기는 보는 곳.
 */
export function AdminModelsTab() {
  const [endpoints, setEndpoints] = useState<ModelEndpoint[] | null>(null);
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [ep, models] = await Promise.all([api.listModelEndpoints(), api.getModels()]);
      setEndpoints(ep.endpoints);
      setCatalog(models.catalog);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <p className="admin-error" role="alert">{error}</p>;
  if (!endpoints) return <p className="admin-empty">불러오는 중…</p>;
  if (endpoints.length === 0) return <p className="admin-empty">연결된 서빙 서버가 없습니다.</p>;

  return (
    <div className="admin-models">
      {endpoints.map((endpoint) => {
        const parts = partsOf(endpoint.baseUrl);
        const entries = catalog.filter((entry) => entry.baseUrl === endpoint.baseUrl || entry.endpoint === endpoint.label);
        const ids = endpoint.models.length > 0 ? endpoint.models : entries.map((entry) => entry.id);
        return (
          <section key={`${endpoint.label}@${endpoint.baseUrl}`} className="admin-model-card" aria-label={endpoint.label}>
            <div className="admin-model-head">
              <h2 className="admin-model-name">{endpoint.label}</h2>
              <span className="admin-model-state" data-ok={endpoint.reachable || undefined}>
                {endpoint.reachable ? `연결됨 · ${endpoint.latencyMs.toLocaleString()}ms` : "연결 안 됨"}
              </span>
              <span className="admin-model-source">{endpoint.source === "env" ? "기본(환경 변수)" : "등록한 서버"}</span>
            </div>
            <dl className="admin-model-meta">
              <div>
                <dt>스킴</dt>
                <dd>{parts.scheme}</dd>
              </div>
              <div>
                <dt>IP·호스트</dt>
                <dd>{parts.host}</dd>
              </div>
              <div>
                <dt>포트</dt>
                <dd>{parts.port}</dd>
              </div>
              <div>
                <dt>경로</dt>
                <dd>{parts.path}</dd>
              </div>
              <div>
                <dt>전체 주소</dt>
                <dd className="admin-model-url">{endpoint.baseUrl}</dd>
              </div>
            </dl>
            {ids.length === 0 ? (
              <p className="admin-empty">이 서버에서 받은 모델이 없습니다.</p>
            ) : (
              <div className="admin-table-scroll">
                <table className="admin-table admin-model-table">
                  <thead>
                    <tr>
                      <th>모델</th>
                      <th>종류</th>
                      <th>컨텍스트</th>
                      <th>추론</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ids.map((id) => {
                      const entry = entries.find((candidate) => candidate.id === id);
                      return (
                        <tr key={id}>
                          <td className="admin-model-id">{id}</td>
                          <td>{entry ? KIND[entry.capability ?? "chat"] ?? entry.capability : "목록에서 빠짐"}</td>
                          <td className="admin-cell-date">
                            {entry?.maxModelLen ? `${entry.maxModelLen.toLocaleString()} 토큰` : "-"}
                          </td>
                          <td>{reasoningLabel(entry)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}
      <p className="admin-model-foot">
        모델별 추론 조절 방식은 서버 설정 <code>REASONING_PROFILES</code> 로 정합니다(예:{" "}
        <code>모델이름=fixed,다른모델=budget:256</code>). 서버를 추가·삭제하는 곳은 사이드바 설정의 "모델 연동" 입니다.
      </p>
    </div>
  );
}
