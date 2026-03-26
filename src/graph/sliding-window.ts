import { NodeKind } from '../shared/types.js';
import type { GraphConfig, CompactionStats } from './types.js';
import { GraphStore } from './graph-store.js';

/** Set of NodeKinds that are never compacted (structural / long-lived). */
const PROTECTED_KINDS = new Set<NodeKind>([
  NodeKind.Symbol,
  NodeKind.Venue,
  NodeKind.Regime,
  NodeKind.StrategyState,
]);

/**
 * Manages temporal windowing and compaction of the graph.
 * Removes stale Event nodes, terminal Orders, and old Trades
 * while preserving structural nodes.
 */
export class SlidingWindow {
  private readonly store: GraphStore;
  private readonly config: GraphConfig;

  constructor(store: GraphStore, config: GraphConfig) {
    this.store = store;
    this.config = config;
  }

  /**
   * Run compaction. Removes nodes older than the retention window
   * relative to the provided current time.
   *
   * Protected kinds (Symbol, Venue, Regime, StrategyState) are never removed.
   *
   * @param currentTimeNs The current exchange timestamp in nanoseconds.
   * @returns Statistics about the compaction pass.
   */
  compact(currentTimeNs: bigint): CompactionStats {
    const start = performance.now();
    let nodesRemoved = 0;
    let edgesRemoved = 0;

    const cutoffNs = currentTimeNs - this.config.retentionWindowNs;
    const toRemove: bigint[] = [];

    for (const node of this.store.allNodes()) {
      // Never compact protected kinds
      if (PROTECTED_KINDS.has(node.kind)) continue;

      // Remove stale Event nodes
      if (node.kind === NodeKind.Event && node.createdAtNs < cutoffNs) {
        toRemove.push(node.id);
        continue;
      }

      // Remove terminal Orders (canceled or fully filled, and old)
      if (node.kind === NodeKind.Order && node.updatedAtNs < cutoffNs) {
        const depth = node.properties.get(0) ?? 0; // PropertyKey.VisibleDepth = 0
        const cancelHazard = node.properties.get(8) ?? 0; // PropertyKey.CancelHazard = 8
        if (depth === 0 || cancelHazard >= 1) {
          toRemove.push(node.id);
          continue;
        }
      }

      // Remove old Trades
      if (node.kind === NodeKind.Trade && node.createdAtNs < cutoffNs) {
        toRemove.push(node.id);
        continue;
      }

      // Remove old TimeBucket nodes
      if (node.kind === NodeKind.TimeBucket && node.createdAtNs < cutoffNs) {
        toRemove.push(node.id);
        continue;
      }

      // Remove stale PriceLevels with zero depth
      if (node.kind === NodeKind.PriceLevel && node.updatedAtNs < cutoffNs) {
        const depth = node.properties.get(0) ?? 0; // PropertyKey.VisibleDepth
        if (depth === 0) {
          toRemove.push(node.id);
          continue;
        }
      }
    }

    // Remove nodes (edges are cleaned up by removeNode)
    for (const nodeId of toRemove) {
      // Count edges being removed
      const outEdges = this.store.getEdgesFrom(nodeId);
      const inEdges = this.store.getEdgesTo(nodeId);
      edgesRemoved += outEdges.length + inEdges.length;

      this.store.removeNode(nodeId);
      nodesRemoved++;
    }

    const durationMs = performance.now() - start;
    return { nodesRemoved, edgesRemoved, durationMs };
  }

  /**
   * Run emergency compaction if node count exceeds the hard cap.
   * Aggressively removes the oldest non-protected nodes until
   * count is below 80% of the cap.
   */
  emergencyCompact(currentTimeNs: bigint): CompactionStats {
    if (this.store.nodeCount() <= this.config.nodeHardCap) {
      return { nodesRemoved: 0, edgesRemoved: 0, durationMs: 0 };
    }

    const start = performance.now();
    let nodesRemoved = 0;
    let edgesRemoved = 0;

    const targetCount = Math.floor(this.config.nodeHardCap * 0.8);

    // Collect removable nodes sorted by creation time (oldest first)
    const candidates: { id: bigint; createdAtNs: bigint }[] = [];
    for (const node of this.store.allNodes()) {
      if (PROTECTED_KINDS.has(node.kind)) continue;
      candidates.push({ id: node.id, createdAtNs: node.createdAtNs });
    }

    candidates.sort((a, b) => {
      const diff = a.createdAtNs - b.createdAtNs;
      return diff < 0n ? -1 : diff > 0n ? 1 : 0;
    });

    for (const candidate of candidates) {
      if (this.store.nodeCount() <= targetCount) break;

      const outEdges = this.store.getEdgesFrom(candidate.id);
      const inEdges = this.store.getEdgesTo(candidate.id);
      edgesRemoved += outEdges.length + inEdges.length;

      this.store.removeNode(candidate.id);
      nodesRemoved++;
    }

    const durationMs = performance.now() - start;
    return { nodesRemoved, edgesRemoved, durationMs };
  }

  /** Check if emergency compaction is needed. */
  needsEmergencyCompaction(): boolean {
    return this.store.nodeCount() > this.config.nodeHardCap;
  }
}
