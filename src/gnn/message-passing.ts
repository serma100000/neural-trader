import { heInit, zeroBias, matVecMul, relu, vecAdd, meanPool } from './math-utils.js';

/**
 * A single message-passing GNN layer with typed edges.
 *
 * For each edge type, a separate linear transformation is learned.
 * Messages from source nodes are transformed by the edge-type-specific
 * weight matrix, aggregated via mean pooling at each target node,
 * then added to the target node's features with a ReLU activation.
 */
export class MessagePassingLayer {
  private readonly weightsByType: Float32Array[];
  private readonly biasByType: Float32Array[];
  private readonly selfWeight: Float32Array;
  private readonly selfBias: Float32Array;

  constructor(
    private readonly inputDim: number,
    private readonly outputDim: number,
    private readonly edgeTypes: number,
  ) {
    // Per-edge-type weight matrices (inputDim -> outputDim)
    this.weightsByType = [];
    this.biasByType = [];
    for (let t = 0; t < edgeTypes; t++) {
      this.weightsByType.push(heInit(inputDim, outputDim));
      this.biasByType.push(zeroBias(outputDim));
    }
    // Self-loop transformation
    this.selfWeight = heInit(inputDim, outputDim);
    this.selfBias = zeroBias(outputDim);
  }

  /**
   * Forward pass: message passing on a graph.
   *
   * @param nodeFeatures Array of feature vectors, one per node.
   * @param edgeIndex Array of [source, target] index pairs.
   * @param edgeTypes Array of edge type indices corresponding to edgeIndex.
   * @returns Updated node feature vectors.
   */
  forward(
    nodeFeatures: Float32Array[],
    edgeIndex: [number, number][],
    edgeTypes: number[],
  ): Float32Array[] {
    const numNodes = nodeFeatures.length;

    // Collect incoming messages per node, grouped by target
    const incomingMessages: Float32Array[][] = new Array(numNodes);
    for (let i = 0; i < numNodes; i++) {
      incomingMessages[i] = [];
    }

    // Compute messages along each edge
    for (let e = 0; e < edgeIndex.length; e++) {
      const [src, tgt] = edgeIndex[e];
      const eType = edgeTypes[e] % this.edgeTypes;
      const srcFeats = nodeFeatures[src];

      // Transform source features by edge-type-specific weight
      const message = matVecMul(
        this.weightsByType[eType],
        srcFeats,
        this.biasByType[eType],
        this.inputDim,
        this.outputDim,
      );
      incomingMessages[tgt].push(message);
    }

    // Update each node: self-transform + mean-aggregated messages
    const output: Float32Array[] = new Array(numNodes);
    for (let i = 0; i < numNodes; i++) {
      // Self-loop transformation
      const selfTransform = matVecMul(
        this.selfWeight,
        nodeFeatures[i],
        this.selfBias,
        this.inputDim,
        this.outputDim,
      );

      if (incomingMessages[i].length > 0) {
        const aggregated = meanPool(incomingMessages[i]);
        output[i] = relu(vecAdd(selfTransform, aggregated));
      } else {
        output[i] = relu(selfTransform);
      }
    }

    return output;
  }

  /** Get input dimension. */
  getInputDim(): number {
    return this.inputDim;
  }

  /** Get output dimension. */
  getOutputDim(): number {
    return this.outputDim;
  }
}

/**
 * Stacked message-passing layers with configurable rounds.
 */
export class StackedMessagePassing {
  private layers: MessagePassingLayer[];

  constructor(
    inputDim: number,
    hiddenDim: number,
    outputDim: number,
    numEdgeTypes: number,
    rounds: number,
  ) {
    this.layers = [];
    for (let r = 0; r < rounds; r++) {
      const inD = r === 0 ? inputDim : hiddenDim;
      const outD = r === rounds - 1 ? outputDim : hiddenDim;
      this.layers.push(new MessagePassingLayer(inD, outD, numEdgeTypes));
    }
  }

  forward(
    nodeFeatures: Float32Array[],
    edgeIndex: [number, number][],
    edgeTypes: number[],
  ): Float32Array[] {
    let features = nodeFeatures;
    for (const layer of this.layers) {
      features = layer.forward(features, edgeIndex, edgeTypes);
    }
    return features;
  }

  getRounds(): number {
    return this.layers.length;
  }
}
