import type { HealthStatus } from './types.js';

type HealthCheckFn = () => Promise<boolean>;

/**
 * Aggregates health checks for all pipeline components.
 * Each registered check returns a boolean indicating health.
 * The overall status is healthy only when all checks pass.
 */
export class HealthChecker {
  private readonly checks = new Map<string, HealthCheckFn>();
  private readonly startedAt: number;

  constructor() {
    this.startedAt = Date.now();
  }

  /**
   * Register a named health check function.
   * Replaces any existing check with the same name.
   */
  registerCheck(name: string, check: HealthCheckFn): void {
    this.checks.set(name, check);
  }

  /**
   * Remove a registered health check.
   */
  removeCheck(name: string): void {
    this.checks.delete(name);
  }

  /**
   * Evaluate all registered health checks and produce a HealthStatus.
   * Individual check failures are caught and reported as unhealthy.
   */
  async evaluate(lastTickNs: bigint = 0n): Promise<HealthStatus> {
    const components: Record<string, boolean> = {};

    for (const [name, checkFn] of this.checks) {
      try {
        components[name] = await checkFn();
      } catch {
        components[name] = false;
      }
    }

    const allHealthy = Object.values(components).every(Boolean);
    const uptime = Date.now() - this.startedAt;

    return {
      healthy: allHealthy,
      components: {
        wasm: components['wasm'] ?? true,
        database: components['database'] ?? true,
        feeds: components['feeds'] ?? true,
        graph: components['graph'] ?? true,
        gnn: components['gnn'] ?? true,
      },
      uptime,
      lastTickNs,
    };
  }

  /**
   * Number of registered health checks.
   */
  checkCount(): number {
    return this.checks.size;
  }
}
