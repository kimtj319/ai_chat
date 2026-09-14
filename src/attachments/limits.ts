// The attachment ceilings are the live model's, not ours: the server derives
// them from that model's context window and publishes them on the catalog
// entry, so a conversation on a smaller model gets a smaller budget. Nothing
// here hardcodes a copy — the shares below are only used when the catalog has
// not (yet) answered.

import type { AttachmentLimits, ModelCatalogEntry } from "../api/types";
import { MAX_IMAGE_EDGE } from "./format";

/** Server defaults, restated only as the fallback derivation. */
const MESSAGE_TOKEN_SHARE = 0.25;
const FILE_TOKEN_SHARE = 0.5;
const FALLBACK_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Last resort only: the window every model in this deployment reports today.
 * Used while `/api/models` is still in flight, never in place of a real entry.
 */
export const FALLBACK_CONTEXT_WINDOW = 262144;

// The server is being written in parallel, so accept the same five numbers
// under a nested object or hoisted onto the entry. A missing number falls
// back to the documented derivation rather than to a guess.
type PublishedLimit = Exclude<keyof AttachmentLimits, "contextWindow">;

const KEY_CANDIDATES: Record<PublishedLimit, string[]> = {
  maxMessageTokens: ["maxMessageTokens", "messageTokens", "tokenBudget", "attachmentTokenBudget", "maxAttachmentTokens"],
  maxFileTokens: ["maxFileTokens", "fileTokens", "perFileTokens", "attachmentFileTokenLimit", "maxAttachmentFileTokens"],
  maxFileBytes: ["maxFileBytes", "maxBytes", "fileBytes", "attachmentMaxBytes", "maxAttachmentBytes"],
  maxImageWidth: ["maxImageWidth", "maxWidth", "imageMaxWidth", "attachmentMaxImageWidth"],
  maxImageHeight: ["maxImageHeight", "maxHeight", "imageMaxHeight", "attachmentMaxImageHeight"],
};

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function pick(entry: ModelCatalogEntry, field: PublishedLimit): number | null {
  const record = entry as unknown as Record<string, unknown>;
  const sources: Array<Record<string, unknown>> = [record];
  for (const nest of ["attachments", "attachmentLimits", "limits"]) {
    const nested = record[nest];
    if (nested && typeof nested === "object") sources.unshift(nested as Record<string, unknown>);
  }
  for (const source of sources) {
    for (const key of KEY_CANDIDATES[field]) {
      const found = positiveNumber(source[key]);
      if (found !== null) return found;
    }
  }
  return null;
}

/**
 * The ceilings that apply to one conversation. `entry` is the catalog entry
 * for the conversation's own model; `windowFallback` covers the moment before
 * the catalog has loaded.
 */
export function attachmentLimitsFor(
  entry: ModelCatalogEntry | undefined,
  windowFallback: number = FALLBACK_CONTEXT_WINDOW,
): AttachmentLimits {
  const contextWindow = positiveNumber(entry?.maxModelLen) ?? windowFallback;
  const derivedMessage = Math.round(contextWindow * MESSAGE_TOKEN_SHARE);

  const maxMessageTokens = (entry && pick(entry, "maxMessageTokens")) ?? derivedMessage;
  const maxFileTokens = (entry && pick(entry, "maxFileTokens")) ?? Math.round(maxMessageTokens * FILE_TOKEN_SHARE);
  const maxFileBytes = (entry && pick(entry, "maxFileBytes")) ?? FALLBACK_FILE_BYTES;
  const maxImageWidth = (entry && pick(entry, "maxImageWidth")) ?? MAX_IMAGE_EDGE;
  const maxImageHeight = (entry && pick(entry, "maxImageHeight")) ?? MAX_IMAGE_EDGE;

  return { contextWindow, maxMessageTokens, maxFileTokens, maxFileBytes, maxImageWidth, maxImageHeight };
}

/**
 * Longest edge the client downscales to: our own 2048px rule, tightened if the
 * server's dimension cap is smaller. Downscaling to the cap is what keeps the
 * dimension refusal from ever being the user's problem.
 */
export function downscaleEdge(limits: AttachmentLimits): number {
  return Math.max(1, Math.min(MAX_IMAGE_EDGE, limits.maxImageWidth, limits.maxImageHeight));
}

/**
 * Which attachments a user would have to drop to get back under the
 * per-message budget — largest first, because that is the shortest route out.
 * Returns the ids to drop (empty when the draft already fits).
 */
export function overBudgetIds<T extends { localId: string; estimatedTokens: number }>(
  items: T[],
  maxMessageTokens: number,
): Set<string> {
  const total = items.reduce((sum, item) => sum + item.estimatedTokens, 0);
  if (total <= maxMessageTokens) return new Set();

  const ordered = [...items].sort((a, b) => b.estimatedTokens - a.estimatedTokens);
  const drop = new Set<string>();
  let remaining = total;
  for (const item of ordered) {
    if (remaining <= maxMessageTokens) break;
    drop.add(item.localId);
    remaining -= item.estimatedTokens;
  }
  return drop;
}
