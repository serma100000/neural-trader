import EventEmitter from 'eventemitter3';
import type {
  MarketEvent,
  GraphDelta,
  CoherenceDecision,
  SymbolId,
  VenueId,
} from './types.js';

// Domain event payload types
export interface MarketDataReceivedPayload {
  event: MarketEvent;
  receivedAt: bigint;
}

export interface GraphUpdatedPayload {
  symbolId: SymbolId;
  delta: GraphDelta;
  tsNs: bigint;
}

export interface EmbeddingComputedPayload {
  symbolId: SymbolId;
  embedding: Float64Array;
  tsNs: bigint;
}

export interface PredictionGeneratedPayload {
  symbolId: SymbolId;
  prediction: number;
  confidence: number;
  horizon: string;
  tsNs: bigint;
}

export interface CoherenceEvaluatedPayload {
  decision: CoherenceDecision;
  tsNs: bigint;
}

export interface ActionDecidedPayload {
  symbolId: SymbolId;
  action: string;
  params: Record<string, unknown>;
  tsNs: bigint;
}

export interface OrderFilledPayload {
  orderId: string;
  symbolId: SymbolId;
  venueId: VenueId;
  fillPrice: bigint;
  fillQty: bigint;
  tsNs: bigint;
}

export interface PositionChangedPayload {
  symbolId: SymbolId;
  previousQty: bigint;
  currentQty: bigint;
  avgPrice: bigint;
  tsNs: bigint;
}

export interface CircuitBreakerTriggeredPayload {
  reason: string;
  symbolId?: SymbolId;
  tsNs: bigint;
}

export interface KillSwitchActivatedPayload {
  reason: string;
  operator: string;
  tsNs: bigint;
}

// Map of event names to their payload types
export interface DomainEvents {
  MarketDataReceived: MarketDataReceivedPayload;
  GraphUpdated: GraphUpdatedPayload;
  EmbeddingComputed: EmbeddingComputedPayload;
  PredictionGenerated: PredictionGeneratedPayload;
  CoherenceEvaluated: CoherenceEvaluatedPayload;
  ActionDecided: ActionDecidedPayload;
  OrderFilled: OrderFilledPayload;
  PositionChanged: PositionChangedPayload;
  CircuitBreakerTriggered: CircuitBreakerTriggeredPayload;
  KillSwitchActivated: KillSwitchActivatedPayload;
}

export type DomainEventName = keyof DomainEvents;

type EventHandler<T> = (payload: T) => void;

export class DomainEventBus {
  private readonly emitter = new EventEmitter();

  subscribe<E extends DomainEventName>(
    event: E,
    handler: EventHandler<DomainEvents[E]>,
  ): void {
    this.emitter.on(event, handler as (...args: unknown[]) => void);
  }

  publish<E extends DomainEventName>(
    event: E,
    payload: DomainEvents[E],
  ): void {
    this.emitter.emit(event, payload);
  }

  unsubscribe<E extends DomainEventName>(
    event: E,
    handler: EventHandler<DomainEvents[E]>,
  ): void {
    this.emitter.off(event, handler as (...args: unknown[]) => void);
  }

  removeAllListeners(event?: DomainEventName): void {
    if (event) {
      this.emitter.removeAllListeners(event);
    } else {
      this.emitter.removeAllListeners();
    }
  }

  listenerCount(event: DomainEventName): number {
    return this.emitter.listenerCount(event);
  }
}

// Singleton instance
let defaultBus: DomainEventBus | undefined;

export function getEventBus(): DomainEventBus {
  if (!defaultBus) {
    defaultBus = new DomainEventBus();
  }
  return defaultBus;
}

export function createEventBus(): DomainEventBus {
  return new DomainEventBus();
}
