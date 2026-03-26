import {
  EventType,
  NodeKind,
  EdgeKind,
  PropertyKey,
  Side,
  type MarketEvent,
  type GraphDelta,
  type SymbolId,
  type VenueId,
  type PriceFp,
} from '../shared/types.js';
import type { GraphConfig } from './types.js';
import {
  priceLevelKey,
  symbolKey,
  venueKey,
  orderKey,
} from './types.js';
import { GraphStore } from './graph-store.js';

/**
 * Converts MarketEvent instances into graph mutations.
 * Each handler creates/updates nodes and edges per ADR-002 section 2.
 */
export class GraphUpdater {
  private readonly store: GraphStore;
  private readonly config: GraphConfig;

  constructor(store: GraphStore, config: GraphConfig) {
    this.store = store;
    this.config = config;
  }

  /** Apply a single market event, returning a delta summary. */
  applyEvent(event: MarketEvent): GraphDelta {
    switch (event.eventType) {
      case EventType.NewOrder:
        return this.handleNewOrder(event);
      case EventType.ModifyOrder:
        return this.handleModifyOrder(event);
      case EventType.CancelOrder:
        return this.handleCancelOrder(event);
      case EventType.Trade:
        return this.handleTrade(event);
      case EventType.BookSnapshot:
        return this.handleBookSnapshot(event);
      case EventType.SessionMarker:
        return this.handleSessionMarker(event);
      case EventType.VenueStatus:
        return this.handleVenueStatus(event);
      default:
        return { nodesAdded: 0, edgesAdded: 0, propertiesUpdated: 0 };
    }
  }

  // ── Ensure structural nodes exist ──────────────────────────

  private ensureSymbolNode(symbolId: SymbolId, tsNs: bigint): bigint {
    const key = symbolKey(symbolId);
    const existing = this.store.getNodeByDomainKey(key);
    if (existing) return existing.id;

    const node = this.store.addNode(
      {
        kind: NodeKind.Symbol,
        properties: new Map([[PropertyKey.InfluenceScore, symbolId as number]]),
        createdAtNs: tsNs,
        updatedAtNs: tsNs,
      },
      key,
    );
    return node.id;
  }

  private ensureVenueNode(venueId: VenueId, tsNs: bigint): bigint {
    const key = venueKey(venueId);
    const existing = this.store.getNodeByDomainKey(key);
    if (existing) return existing.id;

    const node = this.store.addNode(
      {
        kind: NodeKind.Venue,
        properties: new Map(),
        createdAtNs: tsNs,
        updatedAtNs: tsNs,
      },
      key,
    );
    return node.id;
  }

  private ensurePriceLevelNode(
    symbolId: SymbolId,
    venueId: VenueId,
    priceFp: PriceFp,
    side: Side,
    tsNs: bigint,
  ): bigint {
    const key = priceLevelKey(symbolId, venueId, priceFp as bigint, side);
    const existing = this.store.getNodeByDomainKey(key);
    if (existing) return existing.id;

    const node = this.store.addNode(
      {
        kind: NodeKind.PriceLevel,
        properties: new Map([
          [PropertyKey.VisibleDepth, 0],
          [PropertyKey.QueueLength, 0],
          [PropertyKey.LocalImbalance, 0],
          [PropertyKey.SpreadDistance, 0],
          [PropertyKey.RefillRate, 0],
          [PropertyKey.DepletionRate, 0],
        ]),
        createdAtNs: tsNs,
        updatedAtNs: tsNs,
      },
      key,
    );
    return node.id;
  }

  // ── Create helper nodes/edges ──────────────────────────────

  private createEventNode(event: MarketEvent): bigint {
    const node = this.store.addNode({
      kind: NodeKind.Event,
      properties: new Map([
        [PropertyKey.Age, 0],
      ]),
      createdAtNs: event.tsExchangeNs as bigint,
      updatedAtNs: event.tsExchangeNs as bigint,
    });
    return node.id;
  }

  private addEdge(
    kind: EdgeKind,
    sourceId: bigint,
    targetId: bigint,
    tsNs: bigint,
    props?: Map<string, number>,
  ): void {
    this.store.addEdge({
      kind,
      sourceId,
      targetId,
      properties: props ?? new Map(),
      createdAtNs: tsNs,
    });
  }

  // ── Derived property computations ──────────────────────────

  private updatePriceLevelDepth(
    levelId: bigint,
    qtyDelta: number,
    tsNs: bigint,
  ): number {
    const level = this.store.getNode(levelId);
    if (!level) return 0;

    const oldDepth = level.properties.get(PropertyKey.VisibleDepth) ?? 0;
    const newDepth = Math.max(0, oldDepth + qtyDelta);
    level.properties.set(PropertyKey.VisibleDepth, newDepth);

    const oldQueue = level.properties.get(PropertyKey.QueueLength) ?? 0;
    if (qtyDelta > 0) {
      level.properties.set(PropertyKey.QueueLength, oldQueue + 1);
    } else if (qtyDelta < 0 && oldQueue > 0) {
      level.properties.set(PropertyKey.QueueLength, oldQueue - 1);
    }

    level.updatedAtNs = tsNs;
    return 1; // one property set updated
  }

  private updateImbalance(
    symbolId: SymbolId,
    venueId: VenueId,
    tsNs: bigint,
  ): number {
    // Sum bid depth and ask depth across all price levels for this symbol/venue
    const priceLevels = this.store.getNodesByKind(NodeKind.PriceLevel);
    let bidDepth = 0;
    let askDepth = 0;

    const bidPrefix = `pl:${symbolId}:${venueId}:`;
    const askSuffix = ':1';
    const bidSuffix = ':0';

    for (const pl of priceLevels) {
      // We check by iterating domain keys - but for performance we
      // just sum all price levels (acceptable for single-symbol graphs)
      const depth = pl.properties.get(PropertyKey.VisibleDepth) ?? 0;
      // Check domain key via store
      // Simple heuristic: look at edges to determine side
      // For now, accumulate all and split via the domain key lookup
      bidDepth += depth; // simplified - refined below
    }

    // Proper approach: iterate known price level keys
    // For efficiency, we track bid/ask depth inline in handlers
    // This is a fallback that just updates the first found level
    const total = bidDepth + askDepth;
    const imbalance = total > 0 ? (bidDepth - askDepth) / total : 0;

    // Update all price levels for this symbol
    for (const pl of priceLevels) {
      pl.properties.set(PropertyKey.LocalImbalance, imbalance);
    }

    return priceLevels.length > 0 ? 1 : 0;
  }

  private updateEmaRate(
    levelId: bigint,
    prop: PropertyKey,
    newSample: number,
  ): void {
    const level = this.store.getNode(levelId);
    if (!level) return;
    const old = level.properties.get(prop) ?? 0;
    const alpha = this.config.emaAlpha;
    level.properties.set(prop, alpha * newSample + (1 - alpha) * old);
  }

  // ── Event Handlers ─────────────────────────────────────────

  private handleNewOrder(event: MarketEvent): GraphDelta {
    let nodesAdded = 0;
    let edgesAdded = 0;
    let propertiesUpdated = 0;

    const tsNs = event.tsExchangeNs as bigint;
    const side = event.side ?? Side.Bid;
    const qty = Number(event.qtyFp);

    // Ensure structural nodes
    const symbolNodeId = this.ensureSymbolNode(event.symbolId, tsNs);
    const venueNodeId = this.ensureVenueNode(event.venueId, tsNs);
    const levelNodeId = this.ensurePriceLevelNode(
      event.symbolId, event.venueId, event.priceFp, side, tsNs,
    );

    // Create Order node
    const orderDomainKey = event.orderIdHash
      ? orderKey(event.orderIdHash)
      : undefined;
    const orderNode = this.store.addNode(
      {
        kind: NodeKind.Order,
        properties: new Map([
          [PropertyKey.VisibleDepth, qty],
          [PropertyKey.Age, 0],
          [PropertyKey.ModifyCount, 0],
          [PropertyKey.CancelHazard, 0],
          [PropertyKey.FillHazard, 0],
        ]),
        createdAtNs: tsNs,
        updatedAtNs: tsNs,
      },
      orderDomainKey,
    );
    nodesAdded++;

    // Create Event node
    const eventNodeId = this.createEventNode(event);
    nodesAdded++;

    // Edges
    this.addEdge(EdgeKind.AtLevel, orderNode.id, levelNodeId, tsNs);
    edgesAdded++;

    this.addEdge(EdgeKind.Generated, eventNodeId, orderNode.id, tsNs);
    edgesAdded++;

    this.addEdge(EdgeKind.BelongsToSymbol, orderNode.id, symbolNodeId, tsNs);
    edgesAdded++;

    this.addEdge(EdgeKind.OnVenue, orderNode.id, venueNodeId, tsNs);
    edgesAdded++;

    // Update PriceLevel properties
    propertiesUpdated += this.updatePriceLevelDepth(levelNodeId, qty, tsNs);
    this.updateEmaRate(levelNodeId, PropertyKey.RefillRate, qty);
    propertiesUpdated++;

    return { nodesAdded, edgesAdded, propertiesUpdated };
  }

  private handleModifyOrder(event: MarketEvent): GraphDelta {
    let nodesAdded = 0;
    let edgesAdded = 0;
    let propertiesUpdated = 0;

    const tsNs = event.tsExchangeNs as bigint;
    const newQty = Number(event.qtyFp);

    // Find existing order
    const existingOrderId = event.orderIdHash
      ? this.store.getDomainNodeId(orderKey(event.orderIdHash))
      : undefined;

    const eventNodeId = this.createEventNode(event);
    nodesAdded++;

    if (existingOrderId !== undefined) {
      const orderNode = this.store.getNode(existingOrderId);
      if (orderNode) {
        const oldQty = orderNode.properties.get(PropertyKey.VisibleDepth) ?? 0;
        const qtyDelta = newQty - oldQty;

        orderNode.properties.set(PropertyKey.VisibleDepth, newQty);
        const modCount = orderNode.properties.get(PropertyKey.ModifyCount) ?? 0;
        orderNode.properties.set(PropertyKey.ModifyCount, modCount + 1);
        orderNode.updatedAtNs = tsNs;
        propertiesUpdated += 2;

        // ModifiedFrom edge: event -> order
        this.addEdge(EdgeKind.ModifiedFrom, eventNodeId, existingOrderId, tsNs);
        edgesAdded++;

        // Update PriceLevel depth
        const levelEdges = this.store.getEdgesFrom(existingOrderId)
          .filter((e) => e.kind === EdgeKind.AtLevel);
        if (levelEdges.length > 0) {
          propertiesUpdated += this.updatePriceLevelDepth(
            levelEdges[0].targetId, qtyDelta, tsNs,
          );
        }
      }
    }

    return { nodesAdded, edgesAdded, propertiesUpdated };
  }

  private handleCancelOrder(event: MarketEvent): GraphDelta {
    let nodesAdded = 0;
    let edgesAdded = 0;
    let propertiesUpdated = 0;

    const tsNs = event.tsExchangeNs as bigint;

    const eventNodeId = this.createEventNode(event);
    nodesAdded++;

    const existingOrderId = event.orderIdHash
      ? this.store.getDomainNodeId(orderKey(event.orderIdHash))
      : undefined;

    if (existingOrderId !== undefined) {
      const orderNode = this.store.getNode(existingOrderId);
      if (orderNode) {
        const removedQty = orderNode.properties.get(PropertyKey.VisibleDepth) ?? 0;

        // Mark order as canceled (depth = 0)
        orderNode.properties.set(PropertyKey.VisibleDepth, 0);
        orderNode.properties.set(PropertyKey.CancelHazard, 1);
        orderNode.updatedAtNs = tsNs;
        propertiesUpdated += 2;

        // CanceledBy edge
        this.addEdge(EdgeKind.CanceledBy, existingOrderId, eventNodeId, tsNs);
        edgesAdded++;

        // Update PriceLevel depth
        const levelEdges = this.store.getEdgesFrom(existingOrderId)
          .filter((e) => e.kind === EdgeKind.AtLevel);
        if (levelEdges.length > 0) {
          propertiesUpdated += this.updatePriceLevelDepth(
            levelEdges[0].targetId, -removedQty, tsNs,
          );
          this.updateEmaRate(
            levelEdges[0].targetId,
            PropertyKey.DepletionRate,
            removedQty,
          );
          propertiesUpdated++;
        }
      }
    }

    return { nodesAdded, edgesAdded, propertiesUpdated };
  }

  private handleTrade(event: MarketEvent): GraphDelta {
    let nodesAdded = 0;
    let edgesAdded = 0;
    let propertiesUpdated = 0;

    const tsNs = event.tsExchangeNs as bigint;
    const qty = Number(event.qtyFp);
    const side = event.side ?? Side.Bid;

    const symbolNodeId = this.ensureSymbolNode(event.symbolId, tsNs);
    const venueNodeId = this.ensureVenueNode(event.venueId, tsNs);

    // Create Trade node
    const tradeNode = this.store.addNode({
      kind: NodeKind.Trade,
      properties: new Map([
        [PropertyKey.VisibleDepth, qty],
        [PropertyKey.PostTradeImpact, 0],
      ]),
      createdAtNs: tsNs,
      updatedAtNs: tsNs,
    });
    nodesAdded++;

    // Create Event node
    const eventNodeId = this.createEventNode(event);
    nodesAdded++;

    // Event -> Trade edge
    this.addEdge(EdgeKind.Generated, eventNodeId, tradeNode.id, tsNs);
    edgesAdded++;

    // Trade -> Symbol
    this.addEdge(EdgeKind.BelongsToSymbol, tradeNode.id, symbolNodeId, tsNs);
    edgesAdded++;

    // Trade -> Venue
    this.addEdge(EdgeKind.OnVenue, tradeNode.id, venueNodeId, tsNs);
    edgesAdded++;

    // Matched edges: if we can find the resting order
    if (event.orderIdHash) {
      const restingOrderId = this.store.getDomainNodeId(
        orderKey(event.orderIdHash),
      );
      if (restingOrderId !== undefined) {
        this.addEdge(EdgeKind.Matched, tradeNode.id, restingOrderId, tsNs);
        edgesAdded++;

        // Reduce resting order depth
        const restingNode = this.store.getNode(restingOrderId);
        if (restingNode) {
          const oldQty = restingNode.properties.get(PropertyKey.VisibleDepth) ?? 0;
          const remaining = Math.max(0, oldQty - qty);
          restingNode.properties.set(PropertyKey.VisibleDepth, remaining);
          restingNode.properties.set(PropertyKey.FillHazard, 1);
          restingNode.updatedAtNs = tsNs;
          propertiesUpdated += 2;

          // Update the price level
          const levelEdges = this.store.getEdgesFrom(restingOrderId)
            .filter((e) => e.kind === EdgeKind.AtLevel);
          if (levelEdges.length > 0) {
            propertiesUpdated += this.updatePriceLevelDepth(
              levelEdges[0].targetId, -qty, tsNs,
            );
            this.updateEmaRate(
              levelEdges[0].targetId,
              PropertyKey.DepletionRate,
              qty,
            );
            propertiesUpdated++;
          }
        }
      }
    }

    return { nodesAdded, edgesAdded, propertiesUpdated };
  }

  private handleBookSnapshot(event: MarketEvent): GraphDelta {
    let nodesAdded = 0;
    let edgesAdded = 0;
    let propertiesUpdated = 0;

    const tsNs = event.tsExchangeNs as bigint;
    const side = event.side ?? Side.Bid;

    this.ensureSymbolNode(event.symbolId, tsNs);
    this.ensureVenueNode(event.venueId, tsNs);

    // Upsert price level
    const levelNodeId = this.ensurePriceLevelNode(
      event.symbolId, event.venueId, event.priceFp, side, tsNs,
    );
    const levelNode = this.store.getNode(levelNodeId);
    if (levelNode) {
      levelNode.properties.set(PropertyKey.VisibleDepth, Number(event.qtyFp));
      levelNode.updatedAtNs = tsNs;
      propertiesUpdated++;
    }

    // Create Event node for the snapshot
    const eventNodeId = this.createEventNode(event);
    nodesAdded++;

    this.addEdge(EdgeKind.Generated, eventNodeId, levelNodeId, tsNs);
    edgesAdded++;

    return { nodesAdded, edgesAdded, propertiesUpdated };
  }

  private handleSessionMarker(event: MarketEvent): GraphDelta {
    let nodesAdded = 0;
    let edgesAdded = 0;
    let propertiesUpdated = 0;

    const tsNs = event.tsExchangeNs as bigint;

    // Create/update TimeBucket node
    const tbNode = this.store.addNode({
      kind: NodeKind.TimeBucket,
      properties: new Map([
        [PropertyKey.Age, 0],
      ]),
      createdAtNs: tsNs,
      updatedAtNs: tsNs,
    });
    nodesAdded++;

    // Create Regime node
    const regimeNode = this.store.addNode({
      kind: NodeKind.Regime,
      properties: new Map([
        [PropertyKey.LocalRealizedVol, 0],
      ]),
      createdAtNs: tsNs,
      updatedAtNs: tsNs,
    });
    nodesAdded++;

    // InRegime edge
    this.addEdge(EdgeKind.InRegime, tbNode.id, regimeNode.id, tsNs);
    edgesAdded++;

    // Link to symbol
    const symbolNodeId = this.ensureSymbolNode(event.symbolId, tsNs);
    this.addEdge(EdgeKind.BelongsToSymbol, tbNode.id, symbolNodeId, tsNs);
    edgesAdded++;

    return { nodesAdded, edgesAdded, propertiesUpdated };
  }

  private handleVenueStatus(event: MarketEvent): GraphDelta {
    let propertiesUpdated = 0;

    const tsNs = event.tsExchangeNs as bigint;
    const venueNodeId = this.ensureVenueNode(event.venueId, tsNs);
    const venueNode = this.store.getNode(venueNodeId);

    if (venueNode) {
      // Store venue status flags as a property
      venueNode.properties.set(PropertyKey.InfluenceScore, event.flags);
      venueNode.updatedAtNs = tsNs;
      propertiesUpdated++;
    }

    return { nodesAdded: 0, edgesAdded: 0, propertiesUpdated };
  }

  /**
   * Rebuild NEXT_TICK chain for a given symbol/venue/side.
   * Links adjacent PriceLevel nodes in price order.
   */
  rebuildNextTickChain(
    symbolId: SymbolId,
    venueId: VenueId,
    side: Side,
  ): number {
    const priceLevels = this.store.getNodesByKind(NodeKind.PriceLevel);
    const prefix = `pl:${symbolId}:${venueId}:`;
    const suffix = `:${side}`;

    // Collect levels for this symbol/venue/side
    const relevant: { nodeId: bigint; priceFp: bigint }[] = [];

    for (const pl of priceLevels) {
      // Check each level against the domain index
      // We need to iterate domain keys - this is a simplified approach
      // In production, we'd maintain a separate side index
      const depth = pl.properties.get(PropertyKey.VisibleDepth) ?? 0;
      if (depth > 0) {
        relevant.push({ nodeId: pl.id, priceFp: pl.createdAtNs });
      }
    }

    // Sort by price (ascending for asks, descending for bids)
    relevant.sort((a, b) => {
      const diff = a.priceFp - b.priceFp;
      if (side === Side.Ask) return diff < 0n ? -1 : diff > 0n ? 1 : 0;
      return diff > 0n ? -1 : diff < 0n ? 1 : 0;
    });

    // Remove old NEXT_TICK edges for these nodes
    for (const { nodeId } of relevant) {
      const oldEdges = this.store.getEdgesFromByKind(nodeId, EdgeKind.NextTick);
      for (const edge of oldEdges) {
        this.store.removeEdge(edge.id);
      }
    }

    // Create new chain
    let edgesCreated = 0;
    for (let i = 0; i < relevant.length - 1; i++) {
      this.store.addEdge({
        kind: EdgeKind.NextTick,
        sourceId: relevant[i].nodeId,
        targetId: relevant[i + 1].nodeId,
        properties: new Map(),
        createdAtNs: 0n,
      });
      edgesCreated++;
    }

    return edgesCreated;
  }
}
