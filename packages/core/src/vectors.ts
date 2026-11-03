import type { VectorMetric } from "./model.ts";

/** The default of `vectors.maxScan`: the most candidates a nearest query scans without pgvector. */
export const DEFAULT_MAX_SCAN = 10_000;

const SLOT = Symbol.for("quickservicets.vectors");
const settings = ((globalThis as unknown as Record<symbol, unknown>)[SLOT] ??= { maxScan: DEFAULT_MAX_SCAN }) as { maxScan: number };

/** Sets the running service's `vectors` settings. */
export function configureVectors(value: { maxScan: number }): void {
  settings.maxScan = value.maxScan;
}

/** The most candidates a nearest query scans without pgvector. */
export function maxScan(): number {
  return settings.maxScan;
}

/**
 * The distance between two vectors under a metric, as pgvector computes it: cosine distance (1 − cosine similarity),
 * Euclidean distance (`l2`) or the negated inner product (`ip`).
 */
export function vectorDistance(metric: VectorMetric, a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  let squares = 0;
  for (let index = 0; index < a.length; index++) {
    const x = a[index]!;
    const y = b[index]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
    squares += (x - y) * (x - y);
  }
  if (metric === "ip") return -dot;
  if (metric === "l2") return Math.sqrt(squares);
  // pgvector answers NaN for a zero vector; a distance of 1 ranks it as unrelated instead.
  if (normA === 0 || normB === 0) return 1;
  return 1 - dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** One ranked candidate. */
export interface Ranked {
  id: string;
  distance: number;
}

const before = (a: Ranked, b: Ranked) => a.distance < b.distance || (a.distance === b.distance && a.id < b.id);

/**
 * The best `k` candidates by ascending distance, then id, kept in a bounded max-heap, so scanning n candidates keeps
 * only k in memory.
 */
export function nearestOf(candidates: Iterable<Ranked>, k: number): Ranked[] {
  const heap: Ranked[] = [];
  const swap = (i: number, j: number) => ([heap[i], heap[j]] = [heap[j]!, heap[i]!]);
  for (const candidate of candidates) {
    if (heap.length < k) {
      heap.push(candidate);
      for (let at = heap.length - 1; at > 0; ) {
        const parent = (at - 1) >> 1;
        if (!before(heap[parent]!, heap[at]!)) break;
        swap(parent, at);
        at = parent;
      }
      continue;
    }
    if (!before(candidate, heap[0]!)) continue;
    heap[0] = candidate;
    for (let at = 0; ; ) {
      const left = at * 2 + 1;
      const right = left + 1;
      let largest = at;
      if (left < heap.length && before(heap[largest]!, heap[left]!)) largest = left;
      if (right < heap.length && before(heap[largest]!, heap[right]!)) largest = right;
      if (largest === at) break;
      swap(at, largest);
      at = largest;
    }
  }
  return heap.sort((a, b) => (before(a, b) ? -1 : before(b, a) ? 1 : 0));
}
