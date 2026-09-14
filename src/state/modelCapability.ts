// What each model capability means for the UI: which models may be picked,
// which are shown-but-refused and why, and what a conversation of a given kind
// looks and reads like. Pure, so the harness can pin every rule down.

import type { ConversationKind, ModelCapability, ModelCatalogEntry } from "../api/types";

/** An entry from a backend that predates capabilities is an ordinary chat model. */
export function capabilityOf(entry: ModelCatalogEntry | undefined): ModelCapability {
  return entry?.capability ?? "chat";
}

/** A conversation record written before kinds existed is a chat conversation. */
export function kindOf(kind: ConversationKind | undefined | null): ConversationKind {
  return kind === "embedding" ? "embedding" : "chat";
}

/** The conversation kind a model of this capability starts. */
export function kindForCapability(capability: ModelCapability): ConversationKind | null {
  if (capability === "chat") return "chat";
  if (capability === "embedding") return "embedding";
  return null;
}

export const CAPABILITY_LABELS: Record<ModelCapability, string> = {
  chat: "채팅",
  embedding: "임베딩",
  rerank: "재순위",
  unusable: "사용 불가",
};

export const RERANK_UNAVAILABLE_REASON = "재순위 모델은 질의와 문서 목록이 필요해 채팅 입력에서 쓸 수 없습니다.";

export function kindMismatchReason(conversationKind: ConversationKind, capability: ModelCapability): string {
  const from = conversationKind === "embedding" ? "임베딩" : "채팅";
  const to = CAPABILITY_LABELS[capability];
  return `이 대화는 ${from} 대화로 시작되어 ${to} 모델로 바꿀 수 없습니다. 새 대화에서 사용해주세요.`;
}

export interface ModelAvailability {
  /** False for "unusable": it is left out of the list entirely. */
  listed: boolean;
  /** Whether picking it does anything. */
  selectable: boolean;
  capability: ModelCapability;
  /** Short tag beside the name, or null for an ordinary chat model. */
  badge: string | null;
  /** Why it cannot be picked, or null when it can. */
  reason: string | null;
}

/**
 * `conversationKind` is the open conversation's kind, or null when none is
 * open (or the open one is still empty, so nothing is locked in yet).
 */
export function modelAvailability(
  entry: ModelCatalogEntry,
  conversationKind: ConversationKind | null,
): ModelAvailability {
  const capability = capabilityOf(entry);

  if (capability === "unusable") {
    return { listed: false, selectable: false, capability, badge: null, reason: null };
  }

  if (capability === "rerank") {
    return {
      listed: true,
      selectable: false,
      capability,
      badge: CAPABILITY_LABELS.rerank,
      reason: RERANK_UNAVAILABLE_REASON,
    };
  }

  const badge = capability === "embedding" ? CAPABILITY_LABELS.embedding : null;

  if (conversationKind !== null && kindForCapability(capability) !== conversationKind) {
    return {
      listed: true,
      selectable: false,
      capability,
      badge,
      reason: kindMismatchReason(conversationKind, capability),
    };
  }

  return { listed: true, selectable: true, capability, badge, reason: null };
}

/** Every model worth showing, in catalog order. */
export function listableModels(catalog: ModelCatalogEntry[]): ModelCatalogEntry[] {
  return catalog.filter((entry) => capabilityOf(entry) !== "unusable");
}

export interface ConversationKindMeta {
  kind: ConversationKind;
  /** Which glyph `CapabilityIcon` draws. */
  icon: ConversationKind;
  /** Screen-reader / title text for the list row. */
  label: string;
}

export function conversationKindMeta(kind: ConversationKind | undefined | null): ConversationKindMeta {
  const resolved = kindOf(kind);
  return {
    kind: resolved,
    icon: resolved,
    label: resolved === "embedding" ? "임베딩 대화" : "채팅 대화",
  };
}

/**
 * The composer has to say what pressing Enter will do *before* anything is
 * typed: on an embedding model the text does not get answered, it gets turned
 * into numbers.
 */
export function composerPlaceholder(kind: ConversationKind): string {
  return kind === "embedding"
    ? "임베딩할 텍스트를 입력하세요…  (Enter 실행, Shift+Enter 줄바꿈)"
    : "메시지를 입력하세요…  (Enter 전송, Shift+Enter 줄바꿈)";
}

/** The one-line banner above an embedding conversation's composer. */
export const EMBEDDING_MODE_NOTICE =
  "임베딩 모델이 선택되어 있습니다. 답변 대신 입력한 텍스트의 벡터가 생성됩니다.";
