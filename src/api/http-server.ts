import Fastify, { type FastifyInstance } from 'fastify';
import type { LivePipeline } from '../pipeline/live-pipeline.js';
import type { Logger } from '../shared/logger.js';

export interface ApiConfig {
  host: string;
  port: number;
  apiPrefix: string;
  logger: Logger;
}

const DEFAULT_API_CONFIG: ApiConfig = {
  host: '0.0.0.0',
  port: 8080,
  apiPrefix: '/api/v1',
  logger: null as unknown as Logger,
};

/**
 * Fastify HTTP server exposing pipeline state and controls.
 *
 * Routes:
 * - GET  /health                -> HealthStatus
 * - GET  /predictions/:symbol   -> latest prediction outputs
 * - GET  /positions             -> all positions + PnL
 * - GET  /coherence/:symbol     -> gate status, drift, regime
 * - GET  /audit                 -> recent witness receipts (last 100)
 * - GET  /stats                 -> pipeline statistics
 * - POST /kill-switch/activate  -> activate kill switch
 * - POST /kill-switch/deactivate -> deactivate kill switch
 */
export class ApiServer {
  private readonly app: FastifyInstance;
  private readonly pipeline: LivePipeline;
  private readonly config: ApiConfig;

  constructor(pipeline: LivePipeline, config: Partial<ApiConfig> & { logger: Logger }) {
    this.pipeline = pipeline;
    this.config = { ...DEFAULT_API_CONFIG, ...config };
    this.app = Fastify({ logger: false });
    this.registerRoutes();
  }

  /**
   * Start listening on configured host and port.
   */
  async start(): Promise<void> {
    await this.app.listen({
      host: this.config.host,
      port: this.config.port,
    });
    this.config.logger.info(
      { host: this.config.host, port: this.config.port },
      'API server started',
    );
  }

  /**
   * Stop the server.
   */
  async stop(): Promise<void> {
    await this.app.close();
    this.config.logger.info('API server stopped');
  }

  /**
   * Access the underlying Fastify instance (for WebSocket registration).
   */
  getServer(): FastifyInstance {
    return this.app;
  }

  private registerRoutes(): void {
    const prefix = this.config.apiPrefix;

    // GET /health
    this.app.get(`${prefix}/health`, async (_req, reply) => {
      const health = await this.pipeline.getHealth();
      const statusCode = health.healthy ? 200 : 503;
      return reply.status(statusCode).send({
        ...health,
        lastTickNs: health.lastTickNs.toString(),
      });
    });

    // GET /predictions/:symbol
    this.app.get<{ Params: { symbol: string } }>(
      `${prefix}/predictions/:symbol`,
      async (req, reply) => {
        const symbolId = parseInt(req.params.symbol, 10);
        if (isNaN(symbolId)) {
          return reply.status(400).send({ error: 'Invalid symbol ID' });
        }

        const predictions = this.pipeline.getLatestPredictions(symbolId);
        if (!predictions) {
          return reply.status(404).send({ error: 'No predictions for symbol' });
        }

        return reply.send({
          symbolId,
          predictions: predictions.predictions.map((p) => ({
            headName: p.headName,
            value: p.value,
            confidence: p.confidence,
            tsNs: p.tsNs.toString(),
          })),
          controls: predictions.controls.map((c) => ({
            headName: c.headName,
            value: c.value,
            confidence: c.confidence,
          })),
          tsNs: predictions.tsNs.toString(),
        });
      },
    );

    // GET /positions
    this.app.get(`${prefix}/positions`, async (_req, reply) => {
      const tracker = this.pipeline.getPositionTracker();
      const positions = tracker.getAllPositionsArray().map((p) => ({
        symbolId: p.symbolId,
        netQtyFp: p.netQtyFp.toString(),
        avgEntryPriceFp: p.avgEntryPriceFp.toString(),
        realizedPnlFp: p.realizedPnlFp.toString(),
      }));
      return reply.send({ positions });
    });

    // GET /coherence/:symbol
    this.app.get<{ Params: { symbol: string } }>(
      `${prefix}/coherence/:symbol`,
      async (req, reply) => {
        const symbolId = parseInt(req.params.symbol, 10);
        if (isNaN(symbolId)) {
          return reply.status(400).send({ error: 'Invalid symbol ID' });
        }

        const coherence = this.pipeline.getLatestCoherence(symbolId);
        if (!coherence) {
          return reply.status(404).send({ error: 'No coherence data for symbol' });
        }

        return reply.send({
          symbolId,
          allowAct: coherence.allowAct,
          allowWrite: coherence.allowWrite,
          allowRetrieve: coherence.allowRetrieve,
          allowLearn: coherence.allowLearn,
          mincutValue: coherence.mincutValue.toString(),
          partitionHash: coherence.partitionHash,
          driftScore: coherence.driftScore,
          cusumScore: coherence.cusumScore,
          reasons: coherence.reasons,
        });
      },
    );

    // GET /audit
    this.app.get(`${prefix}/audit`, async (_req, reply) => {
      const receipts = this.pipeline.getRecentReceipts(100).map((r) => ({
        tsNs: r.tsNs.toString(),
        modelId: r.modelId,
        inputSegmentHash: r.inputSegmentHash,
        coherenceWitnessHash: r.coherenceWitnessHash,
        policyHash: r.policyHash,
        actionIntent: r.actionIntent,
        verifiedTokenId: r.verifiedTokenId,
        resultingStateHash: r.resultingStateHash,
      }));
      return reply.send({ receipts });
    });

    // GET /stats
    this.app.get(`${prefix}/stats`, async (_req, reply) => {
      const stats = this.pipeline.getStats();
      return reply.send(stats);
    });

    // POST /kill-switch/activate
    this.app.post(`${prefix}/kill-switch/activate`, async (req, reply) => {
      const body = req.body as { reason?: string } | null;
      const reason = body?.reason ?? 'Manual activation via API';
      this.pipeline.getKillSwitch().activate(reason);
      this.config.logger.warn({ reason }, 'Kill switch activated via API');
      return reply.send({ activated: true, reason });
    });

    // POST /kill-switch/deactivate
    this.app.post(`${prefix}/kill-switch/deactivate`, async (_req, reply) => {
      this.pipeline.getKillSwitch().deactivate();
      this.config.logger.info('Kill switch deactivated via API');
      return reply.send({ activated: false });
    });
  }
}
