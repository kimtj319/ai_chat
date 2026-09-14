import type { UiPreferences } from "./types";

export const MIN_THINKING_TOKEN_BUDGET = 512;
export const MAX_THINKING_TOKEN_BUDGET = 32768;
export const MIN_MAX_TOKENS = 1024;
export const MAX_MAX_TOKENS = 65536;

// Mirrors the server's own conversation defaults (see API contract) so the
// composer's reasoning control has sane bounds before a conversation loads.
export const DEFAULT_THINKING_TOKEN_BUDGET = 2048;

export function createDefaultUiPreferences(): UiPreferences {
  return {
    theme: "system",
    sidebarCollapsed: false,
    lastReasoningLevel: "off",
    lastReasoningMode: "external",
    lastThinkingTokenBudget: DEFAULT_THINKING_TOKEN_BUDGET,
    lastModel: "",
  };
}

/**
 * Id for the in-flight assistant message.
 *
 * `crypto.randomUUID` exists only in a **secure context**, so on a plain-HTTP
 * deployment it is `undefined` and calling it throws. That was not
 * hypothetical: served over http on a LAN address, `window.isSecureContext`
 * is false, every streaming event handler threw here, and the whole turn
 * appeared at once at the end instead of streaming. `crypto.getRandomValues`
 * carries no such restriction, so fall back to building a v4 uuid from it.
 */
export function createId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(bytes, (n) => n.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
