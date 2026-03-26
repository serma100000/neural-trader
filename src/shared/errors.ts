export class NeuralTraderError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'NeuralTraderError';
  }
}

export class CoherenceBlockedError extends NeuralTraderError {
  constructor(
    message: string,
    context?: Record<string, unknown>,
  ) {
    super(message, 'COHERENCE_BLOCKED', context);
    this.name = 'CoherenceBlockedError';
  }
}

export class RiskBudgetExceededError extends NeuralTraderError {
  constructor(
    message: string,
    context?: Record<string, unknown>,
  ) {
    super(message, 'RISK_BUDGET_EXCEEDED', context);
    this.name = 'RiskBudgetExceededError';
  }
}

export class WasmInitError extends NeuralTraderError {
  constructor(
    message: string,
    context?: Record<string, unknown>,
  ) {
    super(message, 'WASM_INIT_FAILED', context);
    this.name = 'WasmInitError';
  }
}

export class FeedDisconnectedError extends NeuralTraderError {
  constructor(
    message: string,
    context?: Record<string, unknown>,
  ) {
    super(message, 'FEED_DISCONNECTED', context);
    this.name = 'FeedDisconnectedError';
  }
}

export class ValidationError extends NeuralTraderError {
  constructor(
    message: string,
    context?: Record<string, unknown>,
  ) {
    super(message, 'VALIDATION_ERROR', context);
    this.name = 'ValidationError';
  }
}

export class StorageError extends NeuralTraderError {
  constructor(
    message: string,
    context?: Record<string, unknown>,
  ) {
    super(message, 'STORAGE_ERROR', context);
    this.name = 'StorageError';
  }
}
