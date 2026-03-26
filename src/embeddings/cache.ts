/**
 * LRU embedding cache with hit-rate tracking.
 *
 * Uses a Map with insertion-order iteration to implement LRU eviction.
 * Keys are typically "{symbolId}:{familyName}" or similar domain identifiers.
 */
export class EmbeddingCache {
  private readonly cache = new Map<string, Float32Array>();
  private hits = 0;
  private misses = 0;

  constructor(private readonly maxSize: number) {
    if (maxSize < 1) {
      throw new Error('Cache maxSize must be at least 1');
    }
  }

  /**
   * Retrieve a cached embedding.
   * On hit, moves the entry to most-recent position.
   */
  get(key: string): Float32Array | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      this.hits++;
      // Move to end (most recently used) by re-inserting
      this.cache.delete(key);
      this.cache.set(key, value);
      return value;
    }
    this.misses++;
    return undefined;
  }

  /**
   * Store an embedding in the cache.
   * If at capacity, evicts the least recently used entry.
   */
  set(key: string, embedding: Float32Array): void {
    // If key exists, delete first to refresh position
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict least recently used (first entry in Map iteration order)
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, embedding);
  }

  /** Check if a key is in the cache without affecting LRU order. */
  has(key: string): boolean {
    return this.cache.has(key);
  }

  /** Get the current hit rate as a fraction [0, 1]. */
  hitRate(): number {
    const total = this.hits + this.misses;
    return total === 0 ? 0 : this.hits / total;
  }

  /** Get cache statistics. */
  stats(): { size: number; maxSize: number; hits: number; misses: number; hitRate: number } {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hits: this.hits,
      misses: this.misses,
      hitRate: this.hitRate(),
    };
  }

  /** Remove all entries from the cache and reset statistics. */
  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /** Get the current number of cached entries. */
  size(): number {
    return this.cache.size;
  }
}
