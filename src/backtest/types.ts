export interface BacktestConfig {
  configPath: string;
  startDate: string;
  endDate: string;
  speed: 'realtime' | 'accelerated' | 'burst';
  speedMultiplier: number;
}

export interface BacktestReport {
  totalPnl: number;
  sharpeRatio: number;
  sortinoRatio: number;
  maxDrawdownPct: number;
  winRate: number;
  profitFactor: number;
  totalTrades: number;
  avgTradeReturn: number;
  coherenceUptime: number;
  gateRejectionRate: number;
}

export interface TradeRecord {
  symbolId: number;
  side: 'buy' | 'sell';
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnl: number;
  entryTsNs: bigint;
  exitTsNs: bigint;
}

export const DEFAULT_BACKTEST_CONFIG: BacktestConfig = {
  configPath: '',
  startDate: '',
  endDate: '',
  speed: 'burst',
  speedMultiplier: 1,
};
