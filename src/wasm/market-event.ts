import { nanoid } from 'nanoid';
import type {
  MarketEvent,
  EventId,
  Timestamp,
  VenueId,
  SymbolId,
  PriceFp,
  QtyFp,
  OrderIdHash,
  EventType,
  Side,
} from '../shared/types.js';
import { getWasmLoader } from './loader.js';

export interface CreateMarketEventParams {
  venueId: number;
  symbolId: number;
  eventType: EventType;
  side?: Side;
  priceFp: bigint;
  qtyFp: bigint;
  orderIdHash?: string;
  participantIdHash?: string;
  flags?: number;
  seq?: bigint;
  tsExchangeNs?: bigint;
}

export function createMarketEvent(params: CreateMarketEventParams): MarketEvent {
  const now = BigInt(Date.now()) * 1_000_000n;
  return {
    eventId: nanoid() as EventId,
    tsExchangeNs: (params.tsExchangeNs ?? now) as Timestamp,
    tsIngestNs: now as Timestamp,
    venueId: params.venueId as VenueId,
    symbolId: params.symbolId as SymbolId,
    eventType: params.eventType,
    side: params.side,
    priceFp: params.priceFp as PriceFp,
    qtyFp: params.qtyFp as QtyFp,
    orderIdHash: params.orderIdHash as OrderIdHash | undefined,
    participantIdHash: params.participantIdHash,
    flags: params.flags ?? 0,
    seq: params.seq ?? 0n,
  };
}

export async function serializeMarketEvent(event: MarketEvent): Promise<Uint8Array> {
  const loader = getWasmLoader();
  const mod = await loader.getModule();
  return mod.marketEvent.create(event);
}

export async function deserializeMarketEvent(data: Uint8Array): Promise<MarketEvent> {
  const loader = getWasmLoader();
  const mod = await loader.getModule();
  return mod.marketEvent.deserialize(data);
}
