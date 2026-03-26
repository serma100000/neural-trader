/**
 * Low-level linear algebra utilities operating on Float32Array.
 * All operations are pure TypeScript for portability.
 */

/** Xavier/Glorot uniform initialization. */
export function xavierInit(fanIn: number, fanOut: number): Float32Array {
  const limit = Math.sqrt(6.0 / (fanIn + fanOut));
  const weights = new Float32Array(fanIn * fanOut);
  for (let i = 0; i < weights.length; i++) {
    weights[i] = (Math.random() * 2 - 1) * limit;
  }
  return weights;
}

/** He/Kaiming initialization for ReLU layers. */
export function heInit(fanIn: number, fanOut: number): Float32Array {
  const std = Math.sqrt(2.0 / fanIn);
  const weights = new Float32Array(fanIn * fanOut);
  for (let i = 0; i < weights.length; i++) {
    weights[i] = gaussianRandom() * std;
  }
  return weights;
}

/** Zero-initialized bias vector. */
export function zeroBias(dim: number): Float32Array {
  return new Float32Array(dim);
}

/** Box-Muller transform for Gaussian random numbers. */
export function gaussianRandom(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/**
 * Matrix-vector multiply: y = W * x + b
 * W is (outDim x inDim), stored row-major in flat Float32Array.
 */
export function matVecMul(
  W: Float32Array,
  x: Float32Array,
  bias: Float32Array | null,
  inDim: number,
  outDim: number,
): Float32Array {
  const y = new Float32Array(outDim);
  for (let i = 0; i < outDim; i++) {
    let sum = bias ? bias[i] : 0;
    const rowOffset = i * inDim;
    for (let j = 0; j < inDim; j++) {
      sum += W[rowOffset + j] * x[j];
    }
    y[i] = sum;
  }
  return y;
}

/** Element-wise ReLU activation. */
export function relu(x: Float32Array): Float32Array {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    out[i] = x[i] > 0 ? x[i] : 0;
  }
  return out;
}

/** Element-wise sigmoid activation. */
export function sigmoid(x: Float32Array): Float32Array {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    out[i] = 1.0 / (1.0 + Math.exp(-x[i]));
  }
  return out;
}

/** Element-wise softplus activation: log(1 + exp(x)). */
export function softplus(x: Float32Array): Float32Array {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    // Numerical stability: for large x, softplus(x) ~ x
    out[i] = x[i] > 20 ? x[i] : Math.log(1 + Math.exp(x[i]));
  }
  return out;
}

/** Softmax activation over a vector. */
export function softmax(x: Float32Array): Float32Array {
  const out = new Float32Array(x.length);
  let maxVal = -Infinity;
  for (let i = 0; i < x.length; i++) {
    if (x[i] > maxVal) maxVal = x[i];
  }
  let sumExp = 0;
  for (let i = 0; i < x.length; i++) {
    out[i] = Math.exp(x[i] - maxVal);
    sumExp += out[i];
  }
  for (let i = 0; i < x.length; i++) {
    out[i] /= sumExp;
  }
  return out;
}

/** GELU activation: x * Phi(x) approximation. */
export function gelu(x: Float32Array): Float32Array {
  const out = new Float32Array(x.length);
  const sqrt2OverPi = Math.sqrt(2.0 / Math.PI);
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    const cdf = 0.5 * (1.0 + Math.tanh(sqrt2OverPi * (v + 0.044715 * v * v * v)));
    out[i] = v * cdf;
  }
  return out;
}

/** Element-wise vector addition. */
export function vecAdd(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) {
    out[i] = a[i] + b[i];
  }
  return out;
}

/** Scalar multiply. */
export function vecScale(a: Float32Array, s: number): Float32Array {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) {
    out[i] = a[i] * s;
  }
  return out;
}

/** Dot product of two vectors. */
export function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

/** L2 norm of a vector. */
export function norm(a: Float32Array): number {
  return Math.sqrt(dot(a, a));
}

/** Concatenate multiple Float32Arrays. */
export function concat(...arrays: Float32Array[]): Float32Array {
  let totalLen = 0;
  for (const arr of arrays) totalLen += arr.length;
  const out = new Float32Array(totalLen);
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
}

/** Slice a Float32Array (offset, length). */
export function slice(arr: Float32Array, start: number, len: number): Float32Array {
  return new Float32Array(arr.buffer, arr.byteOffset + start * 4, len);
}

/** Mean pool over a list of vectors. */
export function meanPool(vectors: Float32Array[]): Float32Array {
  if (vectors.length === 0) {
    throw new Error('Cannot mean-pool empty array');
  }
  const dim = vectors[0].length;
  const out = new Float32Array(dim);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) {
      out[i] += v[i];
    }
  }
  const scale = 1.0 / vectors.length;
  for (let i = 0; i < dim; i++) {
    out[i] *= scale;
  }
  return out;
}

/** Sum pool over a list of vectors. */
export function sumPool(vectors: Float32Array[]): Float32Array {
  if (vectors.length === 0) {
    throw new Error('Cannot sum-pool empty array');
  }
  const dim = vectors[0].length;
  const out = new Float32Array(dim);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) {
      out[i] += v[i];
    }
  }
  return out;
}

/** Max pool over a list of vectors (element-wise max). */
export function maxPool(vectors: Float32Array[]): Float32Array {
  if (vectors.length === 0) {
    throw new Error('Cannot max-pool empty array');
  }
  const dim = vectors[0].length;
  const out = new Float32Array(dim);
  out.set(vectors[0]);
  for (let vi = 1; vi < vectors.length; vi++) {
    for (let i = 0; i < dim; i++) {
      if (vectors[vi][i] > out[i]) {
        out[i] = vectors[vi][i];
      }
    }
  }
  return out;
}
