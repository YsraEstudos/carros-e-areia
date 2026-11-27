/**
 * BufferPool.ts
 * Zero-GC typed-array pooling and reusable scratch index lists for high-frequency
 * 3D simulation, terramechanics queries, collision resolution, and mesh batching.
 */

export type PooledTypedArray =
  | Float32Array
  | Uint16Array
  | Uint32Array
  | Int32Array;

type TypedArrayCtor<T extends PooledTypedArray> = new (length: number) => T;

const MIN_BUCKET_SHIFT = 4; // 16 elements minimum
const MAX_BUCKET_SHIFT = 22; // 4,194,304 elements max bucket

function nextBucketIndex(minLength: number): { shift: number; capacity: number } {
  const target = minLength < 16 ? 16 : minLength;
  let shift = MIN_BUCKET_SHIFT;
  let cap = 16;
  while (cap < target && shift < MAX_BUCKET_SHIFT) {
    cap <<= 1;
    shift++;
  }
  return { shift, capacity: cap >= target ? cap : target };
}

export interface TypedArrayPoolStats {
  hits: number;
  misses: number;
  pooledCount: number;
}

/**
 * Power-of-two bucketed pool for TypedArrays (`Float32Array`, `Uint16Array`, `Uint32Array`, `Int32Array`).
 * Reuses backing buffers across frames / batch rebuilds to eliminate Garbage Collector pauses at 120-400+ FPS.
 */
export class TypedArrayPool<T extends PooledTypedArray> {
  private readonly ctor: TypedArrayCtor<T>;
  private readonly maxPerBucket: number;
  private readonly buckets: T[][] = [];
  private hits = 0;
  private misses = 0;

  constructor(ctor: TypedArrayCtor<T>, maxPerBucket = 16) {
    this.ctor = ctor;
    this.maxPerBucket = Math.max(1, maxPerBucket);
  }

  /**
   * Acquires a typed array whose `.length >= minLength`.
   * Note: For exact logical length, callers should track `minLength` alongside the returned buffer.
   */
  public acquire(minLength: number): T {
    const safeMin = Math.max(0, minLength | 0);
    const { shift, capacity } = nextBucketIndex(safeMin);
    const bucketIdx = shift - MIN_BUCKET_SHIFT;
    const bucket = this.buckets[bucketIdx];
    if (bucket && bucket.length > 0) {
      this.hits++;
      return bucket.pop()!;
    }
    this.misses++;
    return new this.ctor(capacity);
  }

  /** Returns a previously acquired typed array to its power-of-two bucket for reuse. */
  public release(array: T | null | undefined): void {
    if (!array || array.length < 16) return;
    // Match exact power-of-two bucket if applicable, else floor bucket
    let shift = MIN_BUCKET_SHIFT;
    let cap = 16;
    while (cap < array.length && shift < MAX_BUCKET_SHIFT) {
      cap <<= 1;
      shift++;
    }
    if (cap !== array.length) {
      // Non-power-of-two custom length: still store in next smaller power-of-two if >=16
      if (shift <= MIN_BUCKET_SHIFT) return;
      shift--;
    }
    const bucketIdx = shift - MIN_BUCKET_SHIFT;
    let bucket = this.buckets[bucketIdx];
    if (!bucket) {
      bucket = [];
      this.buckets[bucketIdx] = bucket;
    }
    if (bucket.length < this.maxPerBucket) {
      bucket.push(array);
    }
  }

  public clear(): void {
    for (let i = 0; i < this.buckets.length; i++) {
      if (this.buckets[i]) this.buckets[i].length = 0;
    }
  }

  public getStats(): TypedArrayPoolStats {
    let pooledCount = 0;
    for (let i = 0; i < this.buckets.length; i++) {
      const b = this.buckets[i];
      if (b) pooledCount += b.length;
    }
    return { hits: this.hits, misses: this.misses, pooledCount };
  }
}

/**
 * Zero-allocation growable Int32 scratch list for spatial index query results.
 * Resetting `.clear()` sets `length = 0` without freeing or reallocating memory.
 */
export class ScratchIndexList {
  public data: Int32Array;
  public length = 0;

  constructor(initialCapacity = 32) {
    this.data = new Int32Array(Math.max(8, initialCapacity));
  }

  public clear(): void {
    this.length = 0;
  }

  public push(index: number): void {
    if (this.length >= this.data.length) {
      const next = new Int32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = index;
  }
}

/** Shared application-wide buffer pools for geometry batching & transient numeric scratch arrays */
export const SharedBufferPools = {
  float32: new TypedArrayPool(Float32Array, 24),
  uint16: new TypedArrayPool(Uint16Array, 24),
  uint32: new TypedArrayPool(Uint32Array, 16),
  int32: new TypedArrayPool(Int32Array, 16),
} as const;
