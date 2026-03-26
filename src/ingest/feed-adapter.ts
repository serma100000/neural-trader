import type { RawFrame } from './types.js';

/**
 * Abstract interface for venue feed adapters.
 * Implementations handle venue-specific connection protocols
 * and emit normalized RawFrame events.
 */
export interface FeedAdapter {
  /** Establish connection to the venue feed */
  connect(): Promise<void>;

  /** Gracefully disconnect from the venue feed */
  disconnect(): Promise<void>;

  /** Whether the adapter is currently connected */
  isConnected(): boolean;

  /** Register handler for incoming raw frames */
  onFrame(handler: (frame: RawFrame) => void): void;

  /** Register handler for connection errors */
  onError(handler: (error: Error) => void): void;

  /** Register handler for disconnect events */
  onDisconnect(handler: () => void): void;
}
