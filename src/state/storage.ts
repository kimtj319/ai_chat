import { createDefaultUiPreferences } from "./defaults";
import type { UiPreferences } from "./types";

// View-level preferences only. Conversations, system prompts and settings
// live on the server now — see the API contract in src/api/types.ts.
const STORAGE_KEY = "qwen3-chat:ui-preferences";

export function loadUiPreferences(): UiPreferences {
  const defaults = createDefaultUiPreferences();
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return defaults;

  try {
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
  localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
}
