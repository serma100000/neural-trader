import type { ControlSignal } from '../gnn/types.js';
import type { ControlHead } from './types.js';
import { MLP } from './mlp.js';
import { TOTAL_EMBEDDING_DIM } from '../gnn/types.js';

/**
 * PlaceHead: Decides whether to place a new order.
 * Output: sigmoid probability of placing.
 */
export class PlaceHead implements ControlHead {
  readonly name = 'place';
  private readonly mlp: MLP;

  constructor(inputDim: number = TOTAL_EMBEDDING_DIM) {
    this.mlp = new MLP([inputDim, 128, 1], 'relu', 'sigmoid');
  }

  evaluate(embedding: Float32Array): ControlSignal {
    const output = this.mlp.forward(embedding);
    return {
      headName: this.name,
      value: output[0],
      confidence: Math.abs(2 * output[0] - 1),
    };
  }
}

/**
 * ModifyHead: Decides whether to modify an existing order.
 * Output: sigmoid probability of modifying.
 */
export class ModifyHead implements ControlHead {
  readonly name = 'modify';
  private readonly mlp: MLP;

  constructor(inputDim: number = TOTAL_EMBEDDING_DIM) {
    this.mlp = new MLP([inputDim, 128, 1], 'relu', 'sigmoid');
  }

  evaluate(embedding: Float32Array): ControlSignal {
    const output = this.mlp.forward(embedding);
    return {
      headName: this.name,
      value: output[0],
      confidence: Math.abs(2 * output[0] - 1),
    };
  }
}

/**
 * SizeHead: Determines order size as a fraction of max position.
 * Output: sigmoid [0, 1] representing fraction of max size.
 */
export class SizeHead implements ControlHead {
  readonly name = 'size';
  private readonly mlp: MLP;

  constructor(inputDim: number = TOTAL_EMBEDDING_DIM) {
    this.mlp = new MLP([inputDim, 128, 1], 'relu', 'sigmoid');
  }

  evaluate(embedding: Float32Array): ControlSignal {
    const output = this.mlp.forward(embedding);
    return {
      headName: this.name,
      value: output[0],
      confidence: 1.0 - Math.abs(output[0] - 0.5) * 2, // More confident near edges
    };
  }
}

/**
 * VenueHead: Selects optimal venue for order routing.
 * Output: softmax over N venues (default 4).
 */
export class VenueHead implements ControlHead {
  readonly name = 'venue';
  private readonly mlp: MLP;
  private readonly numVenues: number;

  constructor(inputDim: number = TOTAL_EMBEDDING_DIM, numVenues: number = 4) {
    this.numVenues = numVenues;
    this.mlp = new MLP([inputDim, 128, numVenues], 'relu', 'softmax');
  }

  evaluate(embedding: Float32Array): ControlSignal {
    const output = this.mlp.forward(embedding);
    // Find best venue
    let maxIdx = 0;
    let maxProb = output[0];
    for (let i = 1; i < output.length; i++) {
      if (output[i] > maxProb) {
        maxProb = output[i];
        maxIdx = i;
      }
    }
    const confidence = Math.max(0, (maxProb - 1.0 / this.numVenues) / (1.0 - 1.0 / this.numVenues));
    return {
      headName: this.name,
      value: maxIdx,
      confidence,
    };
  }
}

/**
 * WriteAdmissionHead: Gate for coherence-verified state mutations.
 * Output: sigmoid probability that a write should be admitted.
 */
export class WriteAdmissionHead implements ControlHead {
  readonly name = 'write_admission';
  private readonly mlp: MLP;

  constructor(inputDim: number = TOTAL_EMBEDDING_DIM) {
    this.mlp = new MLP([inputDim, 128, 1], 'relu', 'sigmoid');
  }

  evaluate(embedding: Float32Array): ControlSignal {
    const output = this.mlp.forward(embedding);
    return {
      headName: this.name,
      value: output[0],
      confidence: Math.abs(2 * output[0] - 1),
    };
  }
}

/** Create all five control heads. */
export function createAllControlHeads(inputDim?: number): ControlHead[] {
  const dim = inputDim ?? TOTAL_EMBEDDING_DIM;
  return [
    new PlaceHead(dim),
    new ModifyHead(dim),
    new SizeHead(dim),
    new VenueHead(dim),
    new WriteAdmissionHead(dim),
  ];
}
