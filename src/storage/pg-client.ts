import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger, type Logger } from '../shared/logger.js';
import type { PgClientConfig, MigrationResult } from './types.js';

const { Pool } = pg;

/** Default configuration values */
const DEFAULTS: Omit<PgClientConfig, 'host' | 'port' | 'database' | 'user' | 'password'> = {
  minConnections: 5,
  maxConnections: 50,
  idleTimeoutMs: 30_000,
  connectionTimeoutMs: 5_000,
};

/**
 * Typed Postgres client wrapper with connection pool management,
 * transaction support, migration runner, and health checks.
 */
export class PgClient {
  private readonly pool: pg.Pool;
  private readonly log: Logger;
  private closed = false;

  constructor(config: Partial<PgClientConfig> = {}) {
    this.log = createLogger({ component: 'PgClient' });

    const resolved: PgClientConfig = {
      host: config.host ?? process.env['PG_HOST'] ?? 'localhost',
      port: config.port ?? Number(process.env['PG_PORT'] ?? 5432),
      database: config.database ?? process.env['PG_DATABASE'] ?? 'neural_trader',
      user: config.user ?? process.env['PG_USER'] ?? 'postgres',
      password: config.password ?? process.env['PG_PASSWORD'] ?? '',
      minConnections: config.minConnections ?? DEFAULTS.minConnections,
      maxConnections: config.maxConnections ?? DEFAULTS.maxConnections,
      idleTimeoutMs: config.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs,
      connectionTimeoutMs: config.connectionTimeoutMs ?? DEFAULTS.connectionTimeoutMs,
      ssl: config.ssl,
    };

    this.pool = new Pool({
      host: resolved.host,
      port: resolved.port,
      database: resolved.database,
      user: resolved.user,
      password: resolved.password,
      min: resolved.minConnections,
      max: resolved.maxConnections,
      idleTimeoutMillis: resolved.idleTimeoutMs,
      connectionTimeoutMillis: resolved.connectionTimeoutMs,
      ssl: resolved.ssl ? { rejectUnauthorized: false } : undefined,
    });

    this.pool.on('error', (err) => {
      this.log.error({ err }, 'Unexpected pool error');
    });

    this.log.info(
      { host: resolved.host, port: resolved.port, database: resolved.database },
      'PgClient initialized',
    );
  }

  /**
   * Execute a parameterized query and return typed rows.
   */
  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<T>> {
    this.assertOpen();
    const start = Date.now();
    try {
      const result = await this.pool.query<T>(text, params);
      const durationMs = Date.now() - start;
      this.log.debug({ durationMs, rows: result.rowCount }, 'Query executed');
      return result;
    } catch (err) {
      const durationMs = Date.now() - start;
      this.log.error({ err, durationMs, text: text.slice(0, 100) }, 'Query failed');
      throw err;
    }
  }

  /**
   * Run a function within a transaction. Commits on success, rolls back on error.
   */
  async transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    this.assertOpen();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Acquire a raw pool client for operations like COPY.
   * Caller is responsible for releasing it.
   */
  async getClient(): Promise<pg.PoolClient> {
    this.assertOpen();
    return this.pool.connect();
  }

  /**
   * Run all pending SQL migrations from the migrations directory.
   * Migrations are applied in alphabetical order, skipping already-applied ones.
   */
  async runMigrations(migrationsDir: string): Promise<MigrationResult[]> {
    this.assertOpen();
    this.log.info({ migrationsDir }, 'Running migrations');

    // Ensure schema version table exists
    await this.query(`
      CREATE TABLE IF NOT EXISTS nt_schema_version (
        version    INT PRIMARY KEY,
        name       TEXT NOT NULL,
        applied_at TIMESTAMPTZ DEFAULT now()
      )
    `);

    // Get already applied versions
    const applied = await this.query<{ version: number }>(
      'SELECT version FROM nt_schema_version ORDER BY version',
    );
    const appliedVersions = new Set(applied.rows.map((r) => r.version));

    // Read migration files
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const results: MigrationResult[] = [];

    for (const file of files) {
      const match = file.match(/^(\d+)/);
      if (!match) {
        this.log.warn({ file }, 'Skipping migration file with no version prefix');
        continue;
      }

      const version = parseInt(match[1], 10);
      if (appliedVersions.has(version)) {
        this.log.debug({ version, file }, 'Migration already applied');
        continue;
      }

      const sql = readFileSync(join(migrationsDir, file), 'utf-8');
      this.log.info({ version, file }, 'Applying migration');

      await this.transaction(async (client) => {
        // Split on semicolons for multi-statement migrations, filtering empty
        const statements = sql
          .split(/;\s*$/m)
          .map((s) => s.trim())
          .filter((s) => s.length > 0);

        for (const stmt of statements) {
          await client.query(stmt);
        }

        // Record in schema version (only if not already an INSERT for this version)
        if (!sql.includes(`INSERT INTO nt_schema_version`)) {
          await client.query(
            'INSERT INTO nt_schema_version (version, name) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [version, file],
          );
        }
      });

      results.push({
        version,
        name: file,
        appliedAt: new Date(),
      });
    }

    this.log.info({ applied: results.length }, 'Migrations complete');
    return results;
  }

  /**
   * Health check: execute a simple query to verify connectivity.
   */
  async ping(): Promise<boolean> {
    try {
      await this.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Pool statistics for monitoring.
   */
  getPoolStats(): { total: number; idle: number; waiting: number } {
    return {
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
    };
  }

  /**
   * Graceful shutdown: drain the connection pool.
   */
  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.log.info('Shutting down PgClient');
    await this.pool.end();
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('PgClient has been shut down');
    }
  }
}
