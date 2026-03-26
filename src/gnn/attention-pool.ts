import {
  heInit,
  zeroBias,
  matVecMul,
  softmax,
  concat,
  dot,
  vecScale,
  vecAdd,
} from './math-utils.js';

/**
 * Multi-head dot-product attention with optional causal masking.
 *
 * Used for temporal attention pooling over node sequences to produce
 * a fixed-size representation from a variable-length graph.
 */
export class AttentionPool {
  private readonly headDim: number;
  private readonly wQ: Float32Array[];
  private readonly bQ: Float32Array[];
  private readonly wK: Float32Array[];
  private readonly bK: Float32Array[];
  private readonly wV: Float32Array[];
  private readonly bV: Float32Array[];
  private readonly wO: Float32Array;
  private readonly bO: Float32Array;
  private readonly scale: number;

  constructor(
    private readonly inputDim: number,
    private readonly numHeads: number,
    private readonly outputDim?: number,
  ) {
    this.headDim = Math.floor(inputDim / numHeads);
    const totalHeadDim = this.headDim * numHeads;
    this.scale = 1.0 / Math.sqrt(this.headDim);

    // Per-head Q/K/V projection weights
    this.wQ = [];
    this.bQ = [];
    this.wK = [];
    this.bK = [];
    this.wV = [];
    this.bV = [];

    for (let h = 0; h < numHeads; h++) {
      this.wQ.push(heInit(inputDim, this.headDim));
      this.bQ.push(zeroBias(this.headDim));
      this.wK.push(heInit(inputDim, this.headDim));
      this.bK.push(zeroBias(this.headDim));
      this.wV.push(heInit(inputDim, this.headDim));
      this.bV.push(zeroBias(this.headDim));
    }

    // Output projection: concat of all heads -> outputDim or inputDim
    const outD = outputDim ?? inputDim;
    this.wO = heInit(totalHeadDim, outD);
    this.bO = zeroBias(outD);
  }

  /**
   * Forward pass: multi-head attention pooling.
   *
   * @param sequences Array of input vectors (one per position/node).
   * @param mask Optional boolean mask; true = attend, false = ignore.
   * @returns Pooled output vector and attention weights.
   */
  forward(
    sequences: Float32Array[],
    mask?: boolean[],
  ): { output: Float32Array; weights: Float32Array } {
    const seqLen = sequences.length;
    if (seqLen === 0) {
      const outD = this.outputDim ?? this.inputDim;
      return {
        output: new Float32Array(outD),
        weights: new Float32Array(0),
      };
    }

    // If only one element, project it directly
    if (seqLen === 1) {
      const headOutputs: Float32Array[] = [];
      for (let h = 0; h < this.numHeads; h++) {
        headOutputs.push(
          matVecMul(this.wV[h], sequences[0], this.bV[h], this.inputDim, this.headDim),
        );
      }
      const concatenated = concat(...headOutputs);
      const outD = this.outputDim ?? this.inputDim;
      const output = matVecMul(this.wO, concatenated, this.bO, concatenated.length, outD);
      return {
        output,
        weights: new Float32Array([1.0]),
      };
    }

    // Compute Q, K, V for each head
    const allWeights = new Float32Array(seqLen);
    const headOutputs: Float32Array[] = [];

    for (let h = 0; h < this.numHeads; h++) {
      // Project all sequence elements to Q, K, V for this head
      const Qs: Float32Array[] = [];
      const Ks: Float32Array[] = [];
      const Vs: Float32Array[] = [];

      for (let i = 0; i < seqLen; i++) {
        Qs.push(matVecMul(this.wQ[h], sequences[i], this.bQ[h], this.inputDim, this.headDim));
        Ks.push(matVecMul(this.wK[h], sequences[i], this.bK[h], this.inputDim, this.headDim));
        Vs.push(matVecMul(this.wV[h], sequences[i], this.bV[h], this.inputDim, this.headDim));
      }

      // Use last position as query for pooling (causal aggregation)
      const query = Qs[seqLen - 1];

      // Compute attention scores: score[i] = Q_last . K_i / sqrt(d_k)
      const scores = new Float32Array(seqLen);
      for (let i = 0; i < seqLen; i++) {
        scores[i] = dot(query, Ks[i]) * this.scale;
        // Apply mask: set masked positions to -inf
        if (mask && !mask[i]) {
          scores[i] = -1e9;
        }
      }

      // Softmax over scores
      const attnWeights = softmax(scores);

      // Weighted sum of values
      const headOut = new Float32Array(this.headDim);
      for (let i = 0; i < seqLen; i++) {
        for (let d = 0; d < this.headDim; d++) {
          headOut[d] += attnWeights[i] * Vs[i][d];
        }
        allWeights[i] += attnWeights[i] / this.numHeads;
      }

      headOutputs.push(headOut);
    }

    // Concatenate all heads
    const concatenated = concat(...headOutputs);

    // Output projection
    const outD = this.outputDim ?? this.inputDim;
    const output = matVecMul(this.wO, concatenated, this.bO, concatenated.length, outD);

    return { output, weights: allWeights };
  }

  /** Get the number of attention heads. */
  getNumHeads(): number {
    return this.numHeads;
  }

  /** Get per-head dimension. */
  getHeadDim(): number {
    return this.headDim;
  }
}
