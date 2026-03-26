import { EMBEDDING_FAMILIES, TOTAL_EMBEDDING_DIM } from '../gnn/types.js';
import type { EmbeddingFamily } from '../gnn/types.js';

/**
 * Composes and decomposes embedding family vectors into/from
 * a single 512-dimensional vector.
 *
 * The composed vector is a simple concatenation of all family
 * embeddings in canonical order, validated for dimension correctness.
 */
export class EmbeddingComposer {
  private readonly families: EmbeddingFamily[];
  private readonly offsets: Map<string, { start: number; dim: number }>;
  private readonly totalDim: number;

  constructor(families?: EmbeddingFamily[]) {
    this.families = families ?? EMBEDDING_FAMILIES;
    this.offsets = new Map();

    let offset = 0;
    for (const family of this.families) {
      this.offsets.set(family.name, { start: offset, dim: family.dimension });
      offset += family.dimension;
    }
    this.totalDim = offset;
  }

  /**
   * Concatenate family embeddings into a single vector.
   *
   * @param familyEmbeddings Map of family name -> embedding vector.
   * @returns Composed embedding of dimension totalDim.
   * @throws If a family embedding has incorrect dimensions.
   */
  compose(familyEmbeddings: Map<string, Float32Array>): Float32Array {
    const result = new Float32Array(this.totalDim);

    for (const family of this.families) {
      const vec = familyEmbeddings.get(family.name);
      const meta = this.offsets.get(family.name)!;

      if (!vec) {
        // Missing family: leave as zeros
        continue;
      }

      if (vec.length !== family.dimension) {
        throw new Error(
          `Embedding family '${family.name}' has dimension ${vec.length}, ` +
          `expected ${family.dimension}`,
        );
      }

      result.set(vec, meta.start);
    }

    return result;
  }

  /**
   * Decompose a composed vector back into family embeddings.
   *
   * @param composed Full composed embedding vector.
   * @returns Map of family name -> embedding vector.
   * @throws If the composed vector has incorrect total dimension.
   */
  decompose(composed: Float32Array): Map<string, Float32Array> {
    if (composed.length !== this.totalDim) {
      throw new Error(
        `Composed embedding has dimension ${composed.length}, expected ${this.totalDim}`,
      );
    }

    const result = new Map<string, Float32Array>();
    for (const family of this.families) {
      const meta = this.offsets.get(family.name)!;
      const slice = new Float32Array(family.dimension);
      for (let i = 0; i < family.dimension; i++) {
        slice[i] = composed[meta.start + i];
      }
      result.set(family.name, slice);
    }
    return result;
  }

  /** Get the total embedding dimension. */
  getTotalDim(): number {
    return this.totalDim;
  }

  /** Get the offset and dimension for a given family. */
  getFamilyLayout(name: string): { start: number; dim: number } | undefined {
    return this.offsets.get(name);
  }

  /** Get all family names in order. */
  getFamilyNames(): string[] {
    return this.families.map((f) => f.name);
  }
}
