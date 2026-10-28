/** The relative accuracy of quantiles. */
export const RELATIVE_ACCURACY = 0.01;
/** The smallest latency told apart, in milliseconds; smaller values count in the first bucket. */
export const MIN_VALUE = 0.1;
/** The largest latency told apart, in milliseconds (one hour); larger values count in the last bucket. */
export const MAX_VALUE = 3_600_000;

const GAMMA = (1 + RELATIVE_ACCURACY) / (1 - RELATIVE_ACCURACY);
const LOG_GAMMA = Math.log(GAMMA);
/** The index of the bucket of `MIN_VALUE`. */
const OFFSET = Math.ceil(Math.log(MIN_VALUE) / LOG_GAMMA);
/** The number of buckets between `MIN_VALUE` and `MAX_VALUE`, under 2048. */
export const BUCKETS = Math.ceil(Math.log(MAX_VALUE) / LOG_GAMMA) - OFFSET + 1;

/** The encoded form of a sketch, as stores keep it: sparse bucket counts with the total, sum and maximum. */
export interface EncodedSketch {
  /** Pairs of bucket index and count, by index. */
  b: number[];
  n: number;
  s: number;
  m: number;
}

/**
 * A mergeable logarithmic bucket sketch of latencies (in milliseconds) with 1% relative accuracy between 0.1 ms and one
 * hour: each value counts in the bucket `ceil(log_γ(value))`, so any quantile is answered within 1% of an actual value
 * of that rank, and sketches of windows, series, workers and replicas merge by adding their counts.
 */
export class LatencySketch {
  readonly counts = new Map<number, number>();
  count = 0;
  sum = 0;
  max = 0;

  /** Counts one latency. */
  add(value: number): void {
    const clamped = value < MIN_VALUE ? MIN_VALUE : value > MAX_VALUE ? MAX_VALUE : value;
    const index = Math.ceil(Math.log(clamped) / LOG_GAMMA) - OFFSET;
    this.counts.set(index, (this.counts.get(index) ?? 0) + 1);
    this.count += 1;
    this.sum += value;
    if (value > this.max) this.max = value;
  }

  /** Adds another sketch's counts to this one. */
  merge(other: LatencySketch): this {
    for (const [index, count] of other.counts) this.counts.set(index, (this.counts.get(index) ?? 0) + count);
    this.count += other.count;
    this.sum += other.sum;
    if (other.max > this.max) this.max = other.max;
    return this;
  }

  /** The value at quantile `q` (0 to 1), within 1% of the actual value of that rank; 0 for an empty sketch. */
  quantile(q: number): number {
    if (this.count === 0) return 0;
    const rank = Math.floor(Math.min(Math.max(q, 0), 1) * (this.count - 1));
    const indices = [...this.counts.keys()].sort((a, b) => a - b);
    let seen = 0;
    for (const index of indices) {
      seen += this.counts.get(index)!;
      if (seen > rank) return Math.min((2 * GAMMA ** (index + OFFSET)) / (GAMMA + 1), this.max);
    }
    return this.max;
  }

  /** The sketch as stores keep it. */
  encode(): EncodedSketch {
    const b: number[] = [];
    for (const index of [...this.counts.keys()].sort((a, c) => a - c)) b.push(index, this.counts.get(index)!);
    return { b, n: this.count, s: this.sum, m: this.max };
  }

  /** A sketch from its encoded form. */
  static decode(encoded: EncodedSketch): LatencySketch {
    const sketch = new LatencySketch();
    for (let at = 0; at + 1 < encoded.b.length; at += 2) sketch.counts.set(encoded.b[at]!, encoded.b[at + 1]!);
    sketch.count = encoded.n;
    sketch.sum = encoded.s;
    sketch.max = encoded.m;
    return sketch;
  }
}
