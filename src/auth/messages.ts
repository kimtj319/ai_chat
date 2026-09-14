// The Korean copy for every refusal the auth and admin routes can send back.
// Kept apart from the screens so the wording is decided in one place — in
// particular the distinction the login screen lives or dies on: a *pending*
// account typing the correct password must be told it is waiting for approval,
// not that its password is wrong.

import type { AuthErrorCode } from "../api/types";

export const PENDING_APPROVAL_NOTICE =
  "가입 신청이 접수되었습니다. 관리자 승인 후 로그인할 수 있습니다.";

export function authErrorMessage(code: AuthErrorCode | null, fallback?: string): string {
  switch (code) {
    case "invalid_credentials":
      return "아이디 또는 비밀번호가 올바르지 않습니다.";
    case "pending_approval":
      return "아직 승인되지 않은 계정입니다. 관리자 승인 후 로그인할 수 있습니다.";
    case "blocked":
      return "차단된 계정입니다. 관리자에게 문의해주세요.";
    case "duplicate_id":
      return "이미 사용 중인 아이디입니다. 다른 아이디를 입력해주세요.";
    case "weak_password":
      return "비밀번호가 너무 단순합니다. 더 복잡한 비밀번호로 다시 설정해주세요.";
    case "same_password":
      return "현재 사용 중인 비밀번호와 다른 비밀번호를 입력해주세요.";
    case "cannot_delete_self":
      return "자기 자신의 계정은 삭제할 수 없습니다.";
    case "duplicate_group":
      return "같은 이름의 그룹이 이미 있습니다.";
    case "not_admin":
      return "관리자만 사용할 수 있는 기능입니다.";
    case "invalid_input":
      return "입력한 내용을 다시 확인해주세요.";
    case "unauthorized":
      return "로그인이 필요합니다. 다시 로그인해주세요.";
    case null:
    default:
      // An unmapped failure keeps the server's own sentence when it sent one,
      // rather than replacing a specific message with a vague one.
      return fallback && fallback.trim().length > 0
        ? fallback
        : "요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.";
  }
}
