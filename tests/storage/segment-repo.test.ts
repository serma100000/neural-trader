import { describe, it, expect, beforeEach } from 'vitest';
import type {
  CoherenceDecision,
  SymbolId,
  Timestamp,
} from '../../src/shared/types.js';
import type { ISegmentRepository, ReplaySegment } from '../../src/storage/types.js';

// ---------------------------------------------------------------------------
// In-memory implementation for unit tests
// ---------------------------------------------------------------------------

class InMemorySegmentRepository implements ISegmentRepository {
  private segments: ReplaySegment[] = [];
  private nextId = 1n;

  async write(
    segment: Omit<ReplaySegment, 'segmentId'>,
    coherenceDecision: CoherenceDecision,
  ): Promise<boolean> {
    if (!coherenceDecision.allowWrite) {
      return false;
    }

    this.segments.push({
      ...segment,
      segmentId: this.nextId++,
    });
    return true;
  }

  async retrieveBySymbol(symbolId: SymbolId, limit: number): Promise<ReplaySegment[]> {
    return this.segments
      .filter((s) => s.symbolId === symbolId)
      .sort((a, b) => {
        const diff = BigInt(b.startTsNs) - BigInt(a.startTsNs);
        return diff < 0n ? -1 : diff > 0n ? 1 : 0;
      })
      .slice(0, limit);
  }

  async retrieveByKind(kind: string, limit: number): Promise<ReplaySegment[]> {
    return this.segments
      .filter((s) => s.segmentKind === kind)
      .sort((a, b) => {
        const diff = BigInt(b.startTsNs) - BigInt(a.startTsNs);
        return diff < 0n ? -1 : diff > 0n ? 1 : 0;
      })
      .slice(0, limit);
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeSegment(
  overrides: Partial<Omit<ReplaySegment, 'segmentId'>> = {},
): Omit<ReplaySegment, 'segmentId'> {
  return {
    symbolId: 100 as SymbolId,
    startTsNs: BigInt(1_000_000_000) as Timestamp,
    endTsNs: BigInt(2_000_000_000) as Timestamp,
    segmentKind: 'replay',
    dataBlob: Buffer.from('test-data'),
    signature: Buffer.from('sig'),
    witnessHash: Buffer.from('witness'),
    metadata: { source: 'test' },
    ...overrides,
  };
}

function makeCoherenceDecision(
  overrides: Partial<CoherenceDecision> = {},
): CoherenceDecision {
  return {
    allowRetrieve: true,
    allowWrite: true,
    allowLearn: true,
    allowAct: true,
    mincutValue: 100n,
    partitionHash: 'partition-hash',
    driftScore: 0.01,
    cusumScore: 0.02,
    reasons: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InMemorySegmentRepository', () => {
  let repo: InMemorySegmentRepository;

  beforeEach(() => {
    repo = new InMemorySegmentRepository();
  });

  describe('write', () => {
    it('should store segment when coherence allows write', async () => {
      const result = await repo.write(makeSegment(), makeCoherenceDecision());
      expect(result).toBe(true);

      const segments = await repo.retrieveBySymbol(100 as SymbolId, 10);
      expect(segments).toHaveLength(1);
      expect(segments[0].segmentKind).toBe('replay');
    });

    it('should reject write when coherence blocks it', async () => {
      const decision = makeCoherenceDecision({
        allowWrite: false,
        reasons: ['drift too high'],
      });

      const result = await repo.write(makeSegment(), decision);
      expect(result).toBe(false);

      const segments = await repo.retrieveBySymbol(100 as SymbolId, 10);
      expect(segments).toHaveLength(0);
    });

    it('should assign unique segment IDs', async () => {
      const decision = makeCoherenceDecision();
      await repo.write(makeSegment(), decision);
      await repo.write(makeSegment({ startTsNs: 3_000_000_000n as Timestamp }), decision);

      const segments = await repo.retrieveBySymbol(100 as SymbolId, 10);
      expect(segments).toHaveLength(2);

      const ids = new Set(segments.map((s) => s.segmentId));
      expect(ids.size).toBe(2);
    });
  });

  describe('retrieveBySymbol', () => {
    it('should return segments for the given symbol only', async () => {
      const decision = makeCoherenceDecision();
      await repo.write(makeSegment({ symbolId: 100 as SymbolId }), decision);
      await repo.write(makeSegment({ symbolId: 200 as SymbolId }), decision);
      await repo.write(
        makeSegment({ symbolId: 100 as SymbolId, startTsNs: 5_000_000_000n as Timestamp }),
        decision,
      );

      const segments = await repo.retrieveBySymbol(100 as SymbolId, 10);
      expect(segments).toHaveLength(2);
      expect(segments.every((s) => s.symbolId === 100)).toBe(true);
    });

    it('should return segments ordered by start_ts descending', async () => {
      const decision = makeCoherenceDecision();
      await repo.write(makeSegment({ startTsNs: 1_000n as Timestamp }), decision);
      await repo.write(makeSegment({ startTsNs: 3_000n as Timestamp }), decision);
      await repo.write(makeSegment({ startTsNs: 2_000n as Timestamp }), decision);

      const segments = await repo.retrieveBySymbol(100 as SymbolId, 10);
      expect(BigInt(segments[0].startTsNs)).toBe(3_000n);
      expect(BigInt(segments[1].startTsNs)).toBe(2_000n);
      expect(BigInt(segments[2].startTsNs)).toBe(1_000n);
    });

    it('should respect the limit parameter', async () => {
      const decision = makeCoherenceDecision();
      for (let i = 0; i < 5; i++) {
        await repo.write(
          makeSegment({ startTsNs: BigInt(i * 1000) as Timestamp }),
          decision,
        );
      }

      const segments = await repo.retrieveBySymbol(100 as SymbolId, 2);
      expect(segments).toHaveLength(2);
    });

    it('should return empty for unknown symbol', async () => {
      const decision = makeCoherenceDecision();
      await repo.write(makeSegment({ symbolId: 100 as SymbolId }), decision);

      const segments = await repo.retrieveBySymbol(999 as SymbolId, 10);
      expect(segments).toHaveLength(0);
    });
  });

  describe('retrieveByKind', () => {
    it('should return segments of the specified kind', async () => {
      const decision = makeCoherenceDecision();
      await repo.write(makeSegment({ segmentKind: 'replay' }), decision);
      await repo.write(makeSegment({ segmentKind: 'training' }), decision);
      await repo.write(
        makeSegment({ segmentKind: 'replay', startTsNs: 5_000n as Timestamp }),
        decision,
      );

      const segments = await repo.retrieveByKind('replay', 10);
      expect(segments).toHaveLength(2);
      expect(segments.every((s) => s.segmentKind === 'replay')).toBe(true);
    });

    it('should order by start_ts descending', async () => {
      const decision = makeCoherenceDecision();
      await repo.write(
        makeSegment({ segmentKind: 'training', startTsNs: 100n as Timestamp }),
        decision,
      );
      await repo.write(
        makeSegment({ segmentKind: 'training', startTsNs: 300n as Timestamp }),
        decision,
      );

      const segments = await repo.retrieveByKind('training', 10);
      expect(BigInt(segments[0].startTsNs)).toBe(300n);
      expect(BigInt(segments[1].startTsNs)).toBe(100n);
    });

    it('should respect the limit parameter', async () => {
      const decision = makeCoherenceDecision();
      for (let i = 0; i < 5; i++) {
        await repo.write(
          makeSegment({
            segmentKind: 'backtest',
            startTsNs: BigInt(i * 1000) as Timestamp,
          }),
          decision,
        );
      }

      const segments = await repo.retrieveByKind('backtest', 3);
      expect(segments).toHaveLength(3);
    });

    it('should return empty for unknown kind', async () => {
      const decision = makeCoherenceDecision();
      await repo.write(makeSegment({ segmentKind: 'replay' }), decision);

      const segments = await repo.retrieveByKind('unknown', 10);
      expect(segments).toHaveLength(0);
    });
  });

  describe('coherence gating integration', () => {
    it('should block writes when drift is too high', async () => {
      const highDrift = makeCoherenceDecision({
        allowWrite: false,
        driftScore: 0.95,
        reasons: ['drift exceeds threshold'],
      });

      const result = await repo.write(makeSegment(), highDrift);
      expect(result).toBe(false);
    });

    it('should allow writes when all gates pass', async () => {
      const allClear = makeCoherenceDecision({
        allowWrite: true,
        allowRetrieve: true,
        allowLearn: true,
        allowAct: true,
        driftScore: 0.01,
      });

      const result = await repo.write(makeSegment(), allClear);
      expect(result).toBe(true);
    });
  });
});
