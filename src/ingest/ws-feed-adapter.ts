import WebSocket from 'ws';
import type { FeedAdapter } from './feed-adapter.js';
import type { FeedConfig, RawFrame } from './types.js';
import type { Logger } from '../shared/logger.js';

/**
 * WebSocket-based feed adapter with exponential backoff reconnection.
 * Subclass this and override parseMessage() for venue-specific protocols.
 */
export class WsFeedAdapter implements FeedAdapter {
  private ws: WebSocket | null = null;
  private connected = false;
  private intentionalDisconnect = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private frameHandlers: Array<(frame: RawFrame) => void> = [];
  private errorHandlers: Array<(error: Error) => void> = [];
  private disconnectHandlers: Array<() => void> = [];

  constructor(
    protected readonly config: FeedConfig,
    protected readonly logger: Logger,
  ) {}

  async connect(): Promise<void> {
    this.intentionalDisconnect = false;
    this.reconnectAttempt = 0;
    return this.doConnect();
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    this.clearReconnectTimer();

    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close(1000, 'Intentional disconnect');
      }
      this.ws = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  onFrame(handler: (frame: RawFrame) => void): void {
    this.frameHandlers.push(handler);
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandlers.push(handler);
  }

  onDisconnect(handler: () => void): void {
    this.disconnectHandlers.push(handler);
  }

  /** Override in subclass to send subscription messages after connect */
  protected onConnected(): void {
    // no-op by default
  }

  /** Override in subclass to parse venue-specific messages */
  protected parseMessage(data: WebSocket.Data): unknown {
    if (typeof data === 'string') {
      return JSON.parse(data);
    }
    if (Buffer.isBuffer(data)) {
      return JSON.parse(data.toString('utf-8'));
    }
    return null;
  }

  /** Send a message through the WebSocket */
  protected send(data: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private doConnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const url = this.config.wsUrl;
      this.logger.info({ url, venue: this.config.venueName }, 'Connecting to feed');

      this.ws = new WebSocket(url);

      const onOpen = (): void => {
        this.connected = true;
        this.reconnectAttempt = 0;
        this.logger.info(
          { venue: this.config.venueName },
          'Feed connected',
        );
        this.onConnected();
        resolve();
      };

      const onMessage = (data: WebSocket.Data): void => {
        const receivedAtNs = process.hrtime.bigint();
        try {
          const parsed = this.parseMessage(data);
          if (parsed !== null) {
            const frame: RawFrame = {
              venueId: this.config.venueId,
              data: parsed,
              receivedAtNs,
            };
            for (const handler of this.frameHandlers) {
              handler(frame);
            }
          }
        } catch (err) {
          this.logger.warn(
            { err, venue: this.config.venueName },
            'Failed to parse message',
          );
        }
      };

      const onError = (err: Error): void => {
        this.logger.error(
          { err, venue: this.config.venueName },
          'WebSocket error',
        );
        for (const handler of this.errorHandlers) {
          handler(err);
        }
        if (!this.connected) {
          reject(err);
        }
      };

      const onClose = (code: number, reason: Buffer): void => {
        const wasConnected = this.connected;
        this.connected = false;
        this.logger.info(
          { code, reason: reason.toString(), venue: this.config.venueName },
          'WebSocket closed',
        );

        for (const handler of this.disconnectHandlers) {
          handler();
        }

        if (!this.intentionalDisconnect && wasConnected) {
          this.scheduleReconnect();
        }
      };

      this.ws.on('open', onOpen);
      this.ws.on('message', onMessage);
      this.ws.on('error', onError);
      this.ws.on('close', onClose);
    });
  }

  private scheduleReconnect(): void {
    this.reconnectAttempt++;
    const baseMs = this.config.reconnectBaseMs;
    const maxMs = this.config.reconnectMaxMs;
    const expDelay = Math.min(
      baseMs * Math.pow(2, this.reconnectAttempt - 1),
      maxMs,
    );
    // Add jitter: 0-25% of the calculated delay
    const jitter = Math.random() * expDelay * 0.25;
    const delay = Math.floor(expDelay + jitter);

    this.logger.info(
      { attempt: this.reconnectAttempt, delayMs: delay, venue: this.config.venueName },
      'Scheduling reconnect',
    );

    this.reconnectTimer = setTimeout(() => {
      this.doConnect().catch((err) => {
        this.logger.error(
          { err, venue: this.config.venueName },
          'Reconnect failed',
        );
        if (!this.intentionalDisconnect) {
          this.scheduleReconnect();
        }
      });
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
