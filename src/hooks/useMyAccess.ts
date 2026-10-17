import { useEffect, useState } from "react";
import { getMyAccess } from "../api/client";
import type { MyAccess, PersonalKeyName } from "../api/types";

/**
 * 내 권한과 개인 키 등록 상태(키 값은 오지 않는다). 키가 필요한 도구에
 * "키 필요" 를 미리 보여 주는 데 쓴다. 못 가져오면 null — 그때는 아무 표시도 하지
 * 않는다(서버가 실행할 때 어차피 막고 알린다).
 */
export function useMyAccess(): MyAccess | null {
  const [access, setAccess] = useState<MyAccess | null>(null);
  useEffect(() => {
    let alive = true;
    getMyAccess()
      .then((value) => alive && setAccess(value))
      .catch(() => alive && setAccess(null));
    return () => {
      alive = false;
    };
  }, []);
  return access;
}

/** 이 도구(내장 도구 이름) 또는 MCP 서버(builtin slug)를 쓰는 데 필요한 개인 키. 서버 server/tools·mcp 와 같은 표. */
const KEY_FOR_TOOL: Record<string, PersonalKeyName> = { web_search: "tavily" };
const KEY_FOR_MCP: Record<string, PersonalKeyName> = { gitlab: "gitlab", alphavantage: "alphavantage" };

/** 키가 없어 쓸 수 없으면 그 키 이름, 아니면 null. 공용 키를 쓰는 계정은 언제나 null. */
export function missingKey(
  access: MyAccess | null,
  target: { tool: string } | { mcpSlug: string; builtin: boolean },
): PersonalKeyName | null {
  if (!access || access.privileged) return null;
  const key = "tool" in target ? KEY_FOR_TOOL[target.tool] : target.builtin ? KEY_FOR_MCP[target.mcpSlug] : undefined;
  if (!key) return null;
  return access.keys[key]?.set ? null : key;
}

export const MISSING_KEY_NOTICE =
  "API 키가 등록되어 있지 않아 이 도구를 사용할 수 없습니다. 설정 › 개인 키 (API 키·토큰)에서 본인 키를 등록해 주세요.";
