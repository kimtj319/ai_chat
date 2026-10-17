import type { ChatMessage, ReasoningLevel, ReasoningMode } from "../api/types";

export type ThemeMode = "dark" | "light" | "system";

/** View-level preferences only — everything else lives on the server. */
export interface UiPreferences {
  theme: ThemeMode;
  sidebarCollapsed: boolean;
  lastReasoningLevel: ReasoningLevel;
  lastReasoningMode: ReasoningMode;
  lastThinkingTokenBudget: number;
  /** Model to use for the next conversation created while none is open yet. "" = server default. */
  lastModel: string;
}

/** A tool result while it is still streaming in (server only sends a truncated preview). */
export interface LiveToolResult {
  id: string;
  name: string;
  ok: boolean;
  durationMs: number;
  preview: string;
  error?: string;
}

/**
 * Client-side view of a message. Persisted messages come straight from the
 * server as `ChatMessage`; a message currently being generated additionally
 * carries `streaming`/`liveToolResults` until the `done` event replaces it
 * with the server's own persisted message.
 */
export interface ClientChatMessage extends ChatMessage {
  streaming?: boolean;
  liveToolResults?: LiveToolResult[];
  /** 진행 중인 컨텍스트 압축(진행률 막대). 끝나면 지운다. */
  compaction?: { kind: import("../api/types").CompactionKind; progress: number };
  /** 첫 reasoning delta 가 온 시각(epoch ms). 클라이언트에서만 쓴다 — 서버로 보내지 않는다. */
  reasoningStartedAt?: number;
  /** 생각이 끝난 시각(epoch ms): 생각 뒤 첫 content delta 나 도구 호출이 온 때. */
  reasoningEndedAt?: number;
}
