// Client-side validation for the login and signup forms.
//
// This exists for immediate feedback only — the server stays the authority on
// every one of these rules, and a field that passes here can still come back
// refused (duplicate_id, weak_password, ...). No React, so the harness can
// exercise it directly.

export interface LoginInput {
  id: string;
  password: string;
}

export interface SignupInput {
  id: string;
  name: string;
  email: string;
  password: string;
  confirm: string;
}

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
  confirm: string;
}

/** One Korean message per offending field; an empty object means "looks fine". */
export type FieldErrors<K extends string> = Partial<Record<K, string>>;

export const ID_MIN_LENGTH = 4;
export const ID_MAX_LENGTH = 32;
export const NAME_MAX_LENGTH = 64;
export const PASSWORD_MIN_LENGTH = 8;

/** Letters, digits and the three separators an id is normally allowed. */
const ID_PATTERN = new RegExp(`^[A-Za-z0-9._-]{${ID_MIN_LENGTH},${ID_MAX_LENGTH}}$`);

/**
 * Deliberately loose: "something@something.something" with no whitespace.
 * Anything stricter rejects addresses that are perfectly valid, and the server
 * (and the inbox) decide in the end anyway.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmailLike(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

/** Login only checks for emptiness — guessing at the id/password shape here
 *  would tell an attacker which half of a wrong pair was wrong. */
export function validateLogin(input: LoginInput): FieldErrors<"id" | "password"> {
  const errors: FieldErrors<"id" | "password"> = {};
  if (input.id.trim().length === 0) errors.id = "아이디를 입력해주세요.";
  if (input.password.length === 0) errors.password = "비밀번호를 입력해주세요.";
  return errors;
}

export function validateSignup(input: SignupInput): FieldErrors<"id" | "name" | "email" | "password" | "confirm"> {
  const errors: FieldErrors<"id" | "name" | "email" | "password" | "confirm"> = {};

  const id = input.id.trim();
  if (id.length === 0) {
    errors.id = "아이디를 입력해주세요.";
  } else if (!ID_PATTERN.test(id)) {
    errors.id = `아이디는 영문·숫자와 . _ - 만 사용해 ${ID_MIN_LENGTH}~${ID_MAX_LENGTH}자로 입력해주세요.`;
  }

  const name = input.name.trim();
  if (name.length === 0) {
    errors.name = "실명을 입력해주세요.";
  } else if (name.length > NAME_MAX_LENGTH) {
    errors.name = `실명은 ${NAME_MAX_LENGTH}자 이하로 입력해주세요.`;
  }

  const email = input.email.trim();
  if (email.length === 0) {
    errors.email = "이메일을 입력해주세요.";
  } else if (!isEmailLike(email)) {
    errors.email = "이메일 형식이 올바르지 않습니다.";
  }

  if (input.password.length === 0) {
    errors.password = "비밀번호를 입력해주세요.";
  } else if (input.password.length < PASSWORD_MIN_LENGTH) {
    errors.password = `비밀번호는 ${PASSWORD_MIN_LENGTH}자 이상이어야 합니다.`;
  }

  if (input.confirm.length === 0) {
    errors.confirm = "비밀번호를 한 번 더 입력해주세요.";
  } else if (input.confirm !== input.password) {
    errors.confirm = "비밀번호가 일치하지 않습니다.";
  }

  return errors;
}

/**
 * The change-password form. The "not the one you already use" rule is checked
 * here as well as on the server, because the server can only answer it after a
 * round trip that re-derives the stored hash.
 */
export function validateChangePassword(
  input: ChangePasswordInput,
): FieldErrors<"currentPassword" | "newPassword" | "confirm"> {
  const errors: FieldErrors<"currentPassword" | "newPassword" | "confirm"> = {};

  if (input.currentPassword.length === 0) {
    errors.currentPassword = "현재 비밀번호를 입력해주세요.";
  }

  if (input.newPassword.length === 0) {
    errors.newPassword = "새 비밀번호를 입력해주세요.";
  } else if (input.newPassword.length < PASSWORD_MIN_LENGTH) {
    errors.newPassword = `비밀번호는 ${PASSWORD_MIN_LENGTH}자 이상이어야 합니다.`;
  } else if (input.currentPassword.length > 0 && input.newPassword === input.currentPassword) {
    errors.newPassword = "현재 사용 중인 비밀번호와 다른 비밀번호를 입력해주세요.";
  }

  if (input.confirm.length === 0) {
    errors.confirm = "새 비밀번호를 한 번 더 입력해주세요.";
  } else if (input.confirm !== input.newPassword) {
    errors.confirm = "비밀번호가 일치하지 않습니다.";
  }

  return errors;
}

export function hasErrors(errors: Record<string, string | undefined>): boolean {
  return Object.values(errors).some((value) => value !== undefined);
}
