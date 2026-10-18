/**
 * 커넥터(MCP 서버) 연결 확인이 실패한 까닭을 사람이 읽는 한 줄로.
 *
 * 서버는 실패 원문을 "단계: 원문" 으로 남긴다(server/mcp/discovery.ts). 원문은 Node·
 * 네트워크 층의 영어인 경우가 많아(`Blocked: "…" resolves to a non-public address`)
 * 이것을 고칠 사람인지 아닌지가 읽히지 않았다. 아는 것만 바꾸고, 모르는 것은 null —
 * 그때는 원문을 그대로 보인다(서버가 이미 한국어로 쓴 문구일 수 있다). 원문은 '자세히'
 * 안에 늘 남긴다.
 */
const RULES: Array<[RegExp, string]> = [
  [/non-public address|Blocked:/i, "내부망 주소라 보안상 연결할 수 없습니다. 외부에서 닿는 주소인지 확인해 주세요."],
  [/Blocked protocol/i, "허용되지 않는 주소 형식입니다. https 주소만 쓸 수 있습니다."],
  [/ENOTFOUND|EAI_AGAIN|getaddrinfo/i, "주소의 호스트 이름을 찾을 수 없습니다. 주소를 확인해 주세요."],
  [/certificate|CERT_|self[- ]signed|SSL|TLS/i, "서버 인증서를 확인할 수 없습니다. 주소가 맞는지, 인증서가 유효한지 확인해 주세요."],
  [/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|socket hang up|fetch failed/i, "서버에 연결할 수 없습니다. 서버가 켜져 있는지, 주소가 맞는지 확인해 주세요."],
  [/응답 시간이 초과|timed? ?out|ETIMEDOUT/i, "서버가 제때 응답하지 않았습니다. 잠시 뒤 다시 확인해 주세요."],
  [/HTTP 40[13]\b/, "서버가 인증을 거절했습니다. 개인 키(또는 헤더 이름)를 확인해 주세요."],
  [/HTTP 404\b/, "이 주소에서 MCP 서버를 찾지 못했습니다. 경로(예: /mcp)를 확인해 주세요."],
  [/HTTP 5\d\d\b/, "MCP 서버 쪽 오류로 응답하지 못했습니다. 잠시 뒤 다시 확인해 주세요."],
  [/JSON이 아닌 응답/, "MCP 형식이 아닌 응답을 받았습니다. 주소가 MCP 엔드포인트인지 확인해 주세요."],
];

export function probeErrorSummary(raw: string | undefined | null): string | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  for (const [pattern, summary] of RULES) if (pattern.test(text)) return summary;
  return null;
}
