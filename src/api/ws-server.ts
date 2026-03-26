import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { DomainEventBus } from '../shared/event-bus.js';
import type { Logger } from '../shared/logger.js';

interface WsClient {
  socket: WebSocket;
  channels: Set<string>;
}

/**
 * WebSocket server for real-time streaming of pipeline events.
 *
 * Channels:
 * - ticks:       real-time market events
 * - predictions: prediction updates per symbol
 * - fills:       execution fills
 * - alerts:      circuit breaker, kill switch, coherence alerts
 *
 * Clients subscribe to channels by sending JSON messages:
 *   { "action": "subscribe", "channel": "ticks" }
 *   { "action": "unsubscribe", "channel": "predictions" }
 */
export class WsServer {
  private readonly clients = new Set<WsClient>();
  private readonly eventBus: DomainEventBus;
  private readonly logger: Logger;
  private readonly wsPath: string;
  private server: FastifyInstance | null = null;

  constructor(
    eventBus: DomainEventBus,
    logger: Logger,
    wsPath = '/ws',
  ) {
    this.eventBus = eventBus;
    this.logger = logger;
    this.wsPath = wsPath;
  }

  /**
   * Register the WebSocket route on the Fastify server and wire up
   * event bus subscriptions to broadcast to clients.
   */
  async start(httpServer: FastifyInstance): Promise<void> {
    this.server = httpServer;

    // Register @fastify/websocket plugin
    const websocketPlugin = await import('@fastify/websocket');
    await httpServer.register(websocketPlugin.default);

    httpServer.get(this.wsPath, { websocket: true }, (socket: WebSocket) => {
      const client: WsClient = { socket, channels: new Set() };
      this.clients.add(client);
      this.logger.debug('WebSocket client connected');

      socket.on('message', (rawData: Buffer | string) => {
        this.handleClientMessage(client, rawData);
      });

      socket.on('close', () => {
        this.clients.delete(client);
        this.logger.debug('WebSocket client disconnected');
      });

      socket.on('error', (err: Error) => {
        this.logger.error({ error: err.message }, 'WebSocket client error');
        this.clients.delete(client);
      });
    });

    this.subscribeToEvents();
    this.logger.info({ wsPath: this.wsPath }, 'WebSocket server started');
  }

  /**
   * Disconnect all clients.
   */
  stop(): void {
    for (const client of this.clients) {
      client.socket.close();
    }
    this.clients.clear();
  }

  /**
   * Number of currently connected clients.
   */
  clientCount(): number {
    return this.clients.size;
  }

  private handleClientMessage(client: WsClient, rawData: Buffer | string): void {
    try {
      const msg = JSON.parse(rawData.toString()) as {
        action: string;
        channel: string;
      };

      if (msg.action === 'subscribe' && isValidChannel(msg.channel)) {
        client.channels.add(msg.channel);
        this.sendToClient(client, {
          type: 'subscribed',
          channel: msg.channel,
        });
      } else if (msg.action === 'unsubscribe') {
        client.channels.delete(msg.channel);
        this.sendToClient(client, {
          type: 'unsubscribed',
          channel: msg.channel,
        });
      }
    } catch {
      this.sendToClient(client, {
        type: 'error',
        message: 'Invalid message format. Expected JSON with action and channel.',
      });
    }
  }

  private subscribeToEvents(): void {
    // Market data -> ticks channel
    this.eventBus.subscribe('MarketDataReceived', (payload) => {
      this.broadcast('ticks', {
        type: 'tick',
        eventId: payload.event.eventId,
        symbolId: payload.event.symbolId,
        eventType: payload.event.eventType,
        priceFp: payload.event.priceFp.toString(),
        qtyFp: payload.event.qtyFp.toString(),
        tsNs: payload.event.tsExchangeNs.toString(),
      });
    });

    // Predictions -> predictions channel
    this.eventBus.subscribe('PredictionGenerated', (payload) => {
      this.broadcast('predictions', {
        type: 'prediction',
        symbolId: payload.symbolId,
        prediction: payload.prediction,
        confidence: payload.confidence,
        horizon: payload.horizon,
        tsNs: payload.tsNs.toString(),
      });
    });

    // Fills -> fills channel
    this.eventBus.subscribe('OrderFilled', (payload) => {
      this.broadcast('fills', {
        type: 'fill',
        orderId: payload.orderId,
        symbolId: payload.symbolId,
        venueId: payload.venueId,
        fillPrice: payload.fillPrice.toString(),
        fillQty: payload.fillQty.toString(),
        tsNs: payload.tsNs.toString(),
      });
    });

    // Circuit breaker -> alerts channel
    this.eventBus.subscribe('CircuitBreakerTriggered', (payload) => {
      this.broadcast('alerts', {
        type: 'circuit_breaker',
        reason: payload.reason,
        symbolId: payload.symbolId,
        tsNs: payload.tsNs.toString(),
      });
    });

    // Kill switch -> alerts channel
    this.eventBus.subscribe('KillSwitchActivated', (payload) => {
      this.broadcast('alerts', {
        type: 'kill_switch',
        reason: payload.reason,
        operator: payload.operator,
        tsNs: payload.tsNs.toString(),
      });
    });

    // Coherence -> alerts channel
    this.eventBus.subscribe('CoherenceEvaluated', (payload) => {
      if (!payload.decision.allowAct) {
        this.broadcast('alerts', {
          type: 'coherence_blocked',
          reasons: payload.decision.reasons,
          driftScore: payload.decision.driftScore,
          tsNs: payload.tsNs.toString(),
        });
      }
    });
  }

  private broadcast(channel: string, data: Record<string, unknown>): void {
    const message = JSON.stringify({ channel, ...data });

    for (const client of this.clients) {
      if (client.channels.has(channel) && client.socket.readyState === 1) {
        client.socket.send(message);
      }
    }
  }

  private sendToClient(client: WsClient, data: Record<string, unknown>): void {
    if (client.socket.readyState === 1) {
      client.socket.send(JSON.stringify(data));
    }
  }
}

const VALID_CHANNELS = new Set(['ticks', 'predictions', 'fills', 'alerts']);

function isValidChannel(channel: string): boolean {
  return VALID_CHANNELS.has(channel);
}
