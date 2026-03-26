import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ShutdownHandler } from '../../src/pipeline/shutdown-handler.js';
import type { LivePipeline } from '../../src/pipeline/live-pipeline.js';
import type { OrderManager } from '../../src/execution/order-manager.js';
import type { KillSwitch } from '../../src/risk/kill-switch.js';
import type { Logger } from '../../src/shared/logger.js';
import type { PositionSnapshot } from '../../src/policy/types.js';
import type { SymbolId } from '../../src/shared/types.js';

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: 'info',
  } as unknown as Logger;
}

function createMockPositionTracker() {
  const positions = new Map<SymbolId, PositionSnapshot>();
  return {
    getAllPositions: vi.fn(() => positions),
    getPosition: vi.fn(),
    applyFill: vi.fn(),
    getNetQty: vi.fn(() => 0n),
    getStateHash: vi.fn(() => 'hash'),
  };
}

describe('ShutdownHandler', () => {
  let mockPipeline: {
    stop: ReturnType<typeof vi.fn>;
    getPositionTracker: ReturnType<typeof vi.fn>;
    getKillSwitch: ReturnType<typeof vi.fn>;
  };
  let mockOrderManager: {
    cancelAll: ReturnType<typeof vi.fn>;
    processFills: ReturnType<typeof vi.fn>;
    getOpenOrders: ReturnType<typeof vi.fn>;
  };
  let mockKillSwitch: {
    activate: ReturnType<typeof vi.fn>;
    deactivate: ReturnType<typeof vi.fn>;
    isActive: ReturnType<typeof vi.fn>;
  };
  let logger: Logger;
  let handler: ShutdownHandler;
  let mockPositionTracker: ReturnType<typeof createMockPositionTracker>;

  // Mock process.exit to prevent actual exits
  const originalExit = process.exit;

  beforeEach(() => {
    vi.useFakeTimers();

    mockPositionTracker = createMockPositionTracker();

    mockPipeline = {
      stop: vi.fn().mockResolvedValue(undefined),
      getPositionTracker: vi.fn(() => mockPositionTracker),
      getKillSwitch: vi.fn(),
    };

    mockOrderManager = {
      cancelAll: vi.fn().mockResolvedValue(undefined),
      processFills: vi.fn().mockResolvedValue([]),
      getOpenOrders: vi.fn(() => []),
    };

    mockKillSwitch = {
      activate: vi.fn(),
      deactivate: vi.fn(),
      isActive: vi.fn(() => false),
    };

    logger = createMockLogger();

    // Mock process.exit
    process.exit = vi.fn() as never;

    handler = new ShutdownHandler(
      mockPipeline as unknown as LivePipeline,
      mockOrderManager as unknown as OrderManager,
      mockKillSwitch as unknown as KillSwitch,
      logger,
    );
  });

  afterEach(() => {
    process.exit = originalExit;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should cancel all orders during shutdown', async () => {
    const shutdownPromise = handler.shutdown('test');

    // Advance past fill wait (processFills returns empty so it exits immediately)
    await vi.advanceTimersByTimeAsync(100);
    await shutdownPromise;

    expect(mockOrderManager.cancelAll).toHaveBeenCalledWith(
      'test',
      expect.objectContaining({ tokenId: 'shutdown-emergency' }),
    );
  });

  it('should stop the pipeline during shutdown', async () => {
    const shutdownPromise = handler.shutdown('test');
    await vi.advanceTimersByTimeAsync(100);
    await shutdownPromise;

    expect(mockPipeline.stop).toHaveBeenCalled();
  });

  it('should activate kill switch during shutdown', async () => {
    const shutdownPromise = handler.shutdown('test reason');
    await vi.advanceTimersByTimeAsync(100);
    await shutdownPromise;

    expect(mockKillSwitch.activate).toHaveBeenCalledWith('Shutdown: test reason');
  });

  it('should force exit after timeout', async () => {
    // Make pipeline.stop hang forever
    mockPipeline.stop.mockImplementation(
      () => new Promise(() => {/* never resolves */}),
    );

    // Start shutdown (don't await - it will hang)
    void handler.shutdown('test');

    // Advance past the 30s force exit timeout
    await vi.advanceTimersByTimeAsync(31_000);

    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('should reject duplicate shutdown calls', async () => {
    const shutdownPromise = handler.shutdown('first');
    await vi.advanceTimersByTimeAsync(100);

    // Second call should be ignored
    await handler.shutdown('second');

    expect(mockKillSwitch.activate).toHaveBeenCalledTimes(1);
    expect(mockKillSwitch.activate).toHaveBeenCalledWith('Shutdown: first');

    await shutdownPromise;
  });

  it('should report isShuttingDown correctly', async () => {
    expect(handler.isShuttingDown()).toBe(false);

    const shutdownPromise = handler.shutdown('test');

    expect(handler.isShuttingDown()).toBe(true);

    await vi.advanceTimersByTimeAsync(100);
    await shutdownPromise;

    expect(handler.isShuttingDown()).toBe(true);
  });

  it('should call process.exit(0) on successful shutdown', async () => {
    const shutdownPromise = handler.shutdown('test');
    await vi.advanceTimersByTimeAsync(100);
    await shutdownPromise;

    expect(process.exit).toHaveBeenCalledWith(0);
  });
});
