/**
 * Two-tier sensing primitives.
 *
 * Tier 1 is regex over the live stream and Tier 2 is cosine similarity against
 * reference phrases at the turn boundary. Both tiers run in `DetectionMonitor`
 * (`server/detection.ts`), which owns the real timeline subscription, the user's
 * configured patterns, references and threshold, and the alert delivery path.
 * This module keeps only what that pipeline needs.
 */

export const OVERMIND_EVENT_ALERT = "OVERMIND_EVENT_ALERT" as const;

export type Embedding = readonly number[];

function isEmbedding(value: unknown): value is Embedding {
  return (
    Array.isArray(value) &&
    value.every((component) => typeof component === "number" && Number.isFinite(component))
  );
}

/** Cosine similarity in [-1, 1]. Empty, invalid, or mismatched vectors score 0. */
export function cosineSimilarity(left: Embedding, right: Embedding): number {
  if (
    !isEmbedding(left) ||
    !isEmbedding(right) ||
    left.length === 0 ||
    left.length !== right.length
  ) {
    return 0;
  }
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] * left[index];
    rightMagnitude += right[index] * right[index];
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}
