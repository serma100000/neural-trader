import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { appConfigSchema, type AppConfig } from './schema.js';
import { ValidationError } from '../shared/errors.js';

const ENV_VAR_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

function substituteEnvVars(value: string): string {
  return value.replace(ENV_VAR_PATTERN, (_match, varName: string) => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
      throw new ValidationError(
        `Environment variable ${varName} is not set`,
        { variable: varName },
      );
    }
    return envValue;
  });
}

function deepSubstitute(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return substituteEnvVars(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(deepSubstitute);
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = deepSubstitute(value);
    }
    return result;
  }
  return obj;
}

export function loadConfig(configPath: string): AppConfig {
  let rawContent: string;
  try {
    rawContent = readFileSync(configPath, 'utf-8');
  } catch (err) {
    throw new ValidationError(
      `Failed to read config file: ${configPath}`,
      { path: configPath, error: String(err) },
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(rawContent);
  } catch (err) {
    throw new ValidationError(
      `Failed to parse YAML config: ${configPath}`,
      { path: configPath, error: String(err) },
    );
  }

  const substituted = deepSubstitute(parsed);

  const result = appConfigSchema.safeParse(substituted);
  if (!result.success) {
    throw new ValidationError(
      `Config validation failed: ${result.error.message}`,
      { path: configPath, issues: result.error.issues },
    );
  }

  return result.data;
}

export function loadConfigFromEnv(): AppConfig {
  const configPath = process.env['NEURAL_TRADER_CONFIG'] ?? 'config/default.yaml';
  return loadConfig(configPath);
}
