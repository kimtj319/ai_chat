// Presentation helpers for an embedding turn. No React, so the harness can
// check the two numbers that actually matter: how the cosine reads, and how
// much of a 1024-dimension vector the preview shows.

import type { MessageEmbedding } from "../api/types";

/** How many components the collapsed preview shows. */
export const VECTOR_PREVIEW_COUNT = 8;

/**
 * Four decimals: measured cosines sit around 0.5170 vs 0.2168, and the fourth
 * digit is where two nearby texts actually separate.
 */
export const COSINE_DECIMALS = 4;

/** Enough digits to read a component whose magnitude is ~1/sqrt(dimensions). */
const VALUE_DECIMALS = 4;

export function formatVectorValue(value: number): string {
  if (!Number.isFinite(value)) return "—";
  // toFixed keeps the decimal point aligned down a column, which a raw
  // toString does not.
  return value.toFixed(VALUE_DECIMALS);
}

/** The cosine as it is displayed, or null when there is nothing to compare to. */
export function formatCosine(value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) return null;
  return value.toFixed(COSINE_DECIMALS);
}

export interface VectorPreview {
  /** The first `shown` components, already formatted. */
  values: string[];
  shown: number;
  total: number;
  truncated: boolean;
  hidden: number;
  /** "0.0312, -0.0071, … 외 1016개" — the whole preview as one line. */
  summary: string;
}

export function previewVector(vector: number[], count: number = VECTOR_PREVIEW_COUNT): VectorPreview {
  const total = vector.length;
  const shown = Math.max(0, Math.min(count, total));
  const values = vector.slice(0, shown).map(formatVectorValue);
  const hidden = total - shown;
  const joined = values.join(", ");
  const summary = hidden > 0 ? `${joined}, … 외 ${hidden.toLocaleString()}개` : joined;
  return { values, shown, total, truncated: hidden > 0, hidden, summary };
}

/** What the copy button puts on the clipboard and the download writes out. */
export function embeddingJson(embedding: MessageEmbedding): string {
  return JSON.stringify(
    {
      model: embedding.model,
      dimensions: embedding.dimensions,
      cosineToPrevious: embedding.cosineToPrevious ?? null,
      vector: embedding.vector,
    },
    null,
    2,
  );
}

/** A filename that says which model produced the vector. */
export function embeddingFilename(embedding: MessageEmbedding): string {
  const model = (embedding.model.split("/").pop() ?? embedding.model).replace(/[^A-Za-z0-9._-]+/g, "-");
  return `embedding-${model}-${embedding.dimensions}d.json`;
}

/**
 * The dimension count is the headline fact about a vector, so it gets said in
 * full rather than abbreviated.
 */
export function dimensionsLabel(embedding: MessageEmbedding): string {
  const declared = embedding.dimensions;
  const actual = embedding.vector.length;
  // A mismatch means the server and the payload disagree; show both rather
  // than silently trusting one.
  if (Number.isFinite(declared) && declared > 0 && declared !== actual) {
    return `${declared.toLocaleString()}차원 (수신 ${actual.toLocaleString()}개)`;
  }
  return `${actual.toLocaleString()}차원`;
}
