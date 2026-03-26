import {
  heInit,
  zeroBias,
  matVecMul,
  relu,
  sigmoid,
  softplus,
  softmax,
  gelu,
} from '../gnn/math-utils.js';
import type { ActivationName } from './types.js';

/**
 * Resolve an activation name to its function.
 */
function getActivation(name: ActivationName): (x: Float32Array) => Float32Array {
  switch (name) {
    case 'relu':
      return relu;
    case 'sigmoid':
      return sigmoid;
    case 'softplus':
      return softplus;
    case 'softmax':
      return softmax;
    case 'gelu':
      return gelu;
    case 'linear':
      return (x: Float32Array) => new Float32Array(x);
    default:
      return relu;
  }
}

/**
 * Multi-Layer Perceptron with configurable layers and activations.
 *
 * Example: new MLP([512, 256, 1], 'relu', 'sigmoid')
 *   - Hidden layer: 512 -> 256 with ReLU
 *   - Output layer: 256 -> 1 with Sigmoid
 */
export class MLP {
  private readonly weights: Float32Array[] = [];
  private readonly biases: Float32Array[] = [];
  private readonly hiddenActivation: (x: Float32Array) => Float32Array;
  private readonly outputActivation: (x: Float32Array) => Float32Array;
  private readonly layerDims: number[];

  constructor(
    layers: number[],
    hiddenActivation: ActivationName = 'relu',
    outputActivation: ActivationName = 'linear',
  ) {
    if (layers.length < 2) {
      throw new Error('MLP requires at least 2 layer dimensions (input + output)');
    }

    this.layerDims = layers;
    this.hiddenActivation = getActivation(hiddenActivation);
    this.outputActivation = getActivation(outputActivation);

    // Initialize weight matrices and biases for each layer transition
    for (let i = 0; i < layers.length - 1; i++) {
      const inDim = layers[i];
      const outDim = layers[i + 1];
      this.weights.push(heInit(inDim, outDim));
      this.biases.push(zeroBias(outDim));
    }
  }

  /**
   * Forward pass through all layers.
   */
  forward(input: Float32Array): Float32Array {
    let x = input;

    for (let i = 0; i < this.weights.length; i++) {
      const inDim = this.layerDims[i];
      const outDim = this.layerDims[i + 1];

      x = matVecMul(this.weights[i], x, this.biases[i], inDim, outDim);

      // Apply activation: hidden activation for intermediate layers,
      // output activation for the last layer
      if (i < this.weights.length - 1) {
        x = this.hiddenActivation(x);
      } else {
        x = this.outputActivation(x);
      }
    }

    return x;
  }

  /** Get the number of layers (including input). */
  getNumLayers(): number {
    return this.layerDims.length;
  }

  /** Get the output dimension. */
  getOutputDim(): number {
    return this.layerDims[this.layerDims.length - 1];
  }

  /** Get the input dimension. */
  getInputDim(): number {
    return this.layerDims[0];
  }
}
