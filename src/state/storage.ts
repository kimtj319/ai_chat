import { createDefaultUiPreferences } from "./defaults";
import type { UiPreferences } from "./types";

// View-level preferences only. Conversations, system prompts and settings
// live on the server now — see the API contract in src/api/types.ts.
const STORAGE_KEY = "qwen3-chat:ui-preferences";

export function loadUiPreferences(): UiPreferences {
  const defaults = createDefaultUiPreferences();
  // getItem itself throws when storage is blocked (Safari "block all cookies",
  // some webviews: SecurityError). This runs before any error boundary, so a
  // throw here would render a blank app — fall back to the defaults instead.
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<UiPreferences>;
    return {
      theme: parsed.theme ?? defaults.theme,
      sidebarCollapsed: parsed.sidebarCollapsed ?? defaults.sidebarCollapsed,
      lastReasoningLevel: parsed.lastReasoningLevel ?? defaults.lastReasoningLevel,
      lastReasoningMode: parsed.lastReasoningMode ?? defaults.lastReasoningMode,
      lastThinkingTokenBudget: parsed.lastThinkingTokenBudget ?? defaults.lastThinkingTokenBudget,
      lastModel: parsed.lastModel ?? defaults.lastModel,
    };
  } catch {
    return defaults;
  }
}

export function saveUiPreferences(preferences: UiPreferences): void {
  // A preference, so losing it (blocked storage, QuotaExceeded) is fine.
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // ignore
  }
}
