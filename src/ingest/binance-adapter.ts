import type { FeedConfig } from './types.js';
import type { Logger } from '../shared/logger.js';
import type { SymbolId } from '../shared/types.js';
import { WsFeedAdapter } from './ws-feed-adapter.js';

/**
 * Binance-specific WebSocket feed adapter.
 * Subscribes to depth@100ms and trade streams for configured symbols.
 */
export class BinanceAdapter extends WsFeedAdapter {
  private readonly symbolMap: Map<string, SymbolId>;

  constructor(config: FeedConfig, logger: Logger) {
    super(config, logger);
    this.symbolMap = new Map();
  }

  /**
   * Register a mapping from Binance lowercase symbol string to internal SymbolId.
   * Must be called before connect() for proper symbol resolution.
   */
  setSymbolMap(mapping: Map<string, SymbolId>): void {
    for (const [k, v] of mapping) {
      this.symbolMap.set(k.toLowerCase(), v);
    }
  }

  getSymbolMap(): ReadonlyMap<string, SymbolId> {
    return this.symbolMap;
  }

  protected override onConnected(): void {
    const streams: string[] = [];
    for (const symbolId of this.config.symbols) {
      // Look up the string symbol name from our reverse map
      const symbolName = this.getSymbolNameById(symbolId);
      if (symbolName) {
        const lower = symbolName.toLowerCase();
        streams.push(`${lower}@depth@100ms`);
        streams.push(`${lower}@trade`);
      }
    }

    if (streams.length > 0) {
      this.send({
        method: 'SUBSCRIBE',
        params: streams,
        id: 1,
      });
      this.logger.info(
        { streams, venue: this.config.venueName },
        'Subscribed to Binance streams',
      );
    }
  }

  private getSymbolNameById(symbolId: SymbolId): string | undefined {
    for (const [name, id] of this.symbolMap) {
      if (id === symbolId) {
        return name;
      }
    }
    return undefined;
  }
}
