/**
 * Numerical gradient computation via central finite differences.
 *
 * This is intentionally simple and correct, though slow.
 * For production training, replace with WASM/ONNX autograd.
 */
export class NumericalGradient {
  private readonly epsilon: number;

  constructor(epsilon: number = 1e-5) {
    this.epsilon = epsilon;
  }

  /**
   * Compute the gradient of a loss function with respect to a weight array
   * using central finite differences: df/dw_i ~ (f(w+eps) - f(w-eps)) / (2*eps).
   *
   * @param weights - The weight array to differentiate with respect to
   * @param lossFunction - A function that evaluates the loss given modified weights.
   *   The weights array is mutated in-place for performance; the function must
   *   use the current state of the array when called.
   * @returns Gradient array of the same length as weights
   */
  computeGradient(
    weights: Float32Array,
    lossFunction: (weights: Float32Array) => number,
  ): Float32Array {
    const grad = new Float32Array(weights.length);

    for (let i = 0; i < weights.length; i++) {
      const original = weights[i];

      // Forward perturbation
      weights[i] = original + this.epsilon;
      const lossPlus = lossFunction(weights);

      // Backward perturbation
      weights[i] = original - this.epsilon;
      const lossMinus = lossFunction(weights);

      // Restore
      weights[i] = original;

      // Central difference
      grad[i] = (lossPlus - lossMinus) / (2 * this.epsilon);

      // Guard against NaN/Inf
      if (!Number.isFinite(grad[i])) {
        grad[i] = 0;
      }
    }

    return grad;
  }
}

/**
 * Clip a gradient vector to a maximum L2 norm.
 * If the gradient norm exceeds maxNorm, scale it down proportionally.
 *
 * @param gradient - The gradient vector (not mutated)
 * @param maxNorm - Maximum allowed L2 norm
 * @returns Clipped gradient (new array)
 */
export function clipGradient(
  gradient: Float32Array,
  maxNorm: number,
): Float32Array {
  let normSq = 0;
  for (let i = 0; i < gradient.length; i++) {
    normSq += gradient[i] * gradient[i];
  }
  const norm = Math.sqrt(normSq);

  if (norm <= maxNorm || norm === 0) {
    return new Float32Array(gradient);
  }

  const scale = maxNorm / norm;
  const clipped = new Float32Array(gradient.length);
  for (let i = 0; i < gradient.length; i++) {
    clipped[i] = gradient[i] * scale;
  }
  return clipped;
}

/**
 * Apply a gradient update to weights: w = w - lr * gradient.
 * Mutates the weights array in-place for performance.
 *
 * @param weights - Weight array to update (mutated in-place)
 * @param gradient - Gradient array
 * @param learningRate - Step size
 */
export function applyGradient(
  weights: Float32Array,
  gradient: Float32Array,
  learningRate: number,
): void {
  for (let i = 0; i < weights.length; i++) {
    weights[i] -= learningRate * gradient[i];
  }
}
