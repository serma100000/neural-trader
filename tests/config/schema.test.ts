import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { appConfigSchema } from '../../src/config/schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(__dirname, '../../config/default.yaml');

describe('AppConfig Schema', () => {
  it('should validate the default config file (with env substitution mocked)', () => {
    const raw = readFileSync(configPath, 'utf-8');
    // Replace env var placeholders with test values before parsing
    const substituted = raw.replace(/\$\{[A-Z_][A-Z0-9_]*\}/g, 'test-value');
    const parsed = parseYaml(substituted);
    const result = appConfigSchema.safeParse(parsed);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.version).toBe('0.1.0');
      expect(result.data.environment).toBe('development');
      expect(result.data.venues).toHaveLength(1);
      expect(result.data.symbols).toHaveLength(1);
      expect(result.data.strategies).toHaveLength(1);
    }
  });

  it('should apply defaults for empty config', () => {
    const result = appConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.version).toBe('0.1.0');
      expect(result.data.environment).toBe('development');
      expect(result.data.graph.max_nodes).toBe(1_000_000);
      expect(result.data.coherence.mincut_threshold).toBe(0.5);
      expect(result.data.risk.max_position_usd).toBe(10000);
      expect(result.data.server.port).toBe(8080);
    }
  });

  it('should reject invalid environment value', () => {
    const result = appConfigSchema.safeParse({ environment: 'invalid' });
    expect(result.success).toBe(false);
  });

  it('should reject negative venue id', () => {
    const result = appConfigSchema.safeParse({
      venues: [{ id: -1, name: 'bad', adapter: 'test' }],
    });
    expect(result.success).toBe(false);
  });

  it('should reject invalid ws_url', () => {
    const result = appConfigSchema.safeParse({
      venues: [{ id: 0, name: 'test', adapter: 'test', ws_url: 'not-a-url' }],
    });
    expect(result.success).toBe(false);
  });

  it('should accept valid venue config', () => {
    const result = appConfigSchema.safeParse({
      venues: [{
        id: 0,
        name: 'test-exchange',
        adapter: 'generic',
        ws_url: 'wss://example.com/ws',
        rest_url: 'https://example.com/api',
        rate_limit_rps: 5,
      }],
    });
    expect(result.success).toBe(true);
  });

  it('should validate coherence regime thresholds', () => {
    const result = appConfigSchema.safeParse({
      coherence: {
        mincut_threshold: 0.5,
        drift_window: 500,
        cusum_h: 3.0,
        cusum_k: 0.5,
        regime_thresholds: {
          calm: 0.2,
          normal: 0.5,
          volatile: 0.9,
        },
        evaluation_interval_ms: 50,
      },
    });
    expect(result.success).toBe(true);
  });

  it('should reject risk drawdown over 100%', () => {
    const result = appConfigSchema.safeParse({
      risk: { circuit_breaker_drawdown_pct: 150 },
    });
    expect(result.success).toBe(false);
  });

  it('should accept valid strategy config', () => {
    const result = appConfigSchema.safeParse({
      strategies: [{
        name: 'test-strat',
        enabled: true,
        symbols: [0, 1],
        params: { threshold: 0.5 },
      }],
    });
    expect(result.success).toBe(true);
  });
});
