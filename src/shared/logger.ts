import pino from 'pino';
import type { SymbolId, VenueId } from './types.js';

export interface LoggerContext {
  component: string;
  symbolId?: SymbolId;
  venueId?: VenueId;
  [key: string]: unknown;
}

export type Logger = pino.Logger;

let rootLogger: pino.Logger | undefined;

function getRootLogger(): pino.Logger {
  if (!rootLogger) {
    rootLogger = pino({
      level: process.env['LOG_LEVEL'] ?? 'info',
      transport:
        process.env['NODE_ENV'] === 'development'
          ? { target: 'pino/file', options: { destination: 1 } }
          : undefined,
    });
  }
  return rootLogger;
}

export function createLogger(context: LoggerContext): Logger {
  return getRootLogger().child(context);
}

export function setLogLevel(level: string): void {
  getRootLogger().level = level;
}
