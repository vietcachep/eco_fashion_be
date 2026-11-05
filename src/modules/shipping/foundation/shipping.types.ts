import type { ShippingSnapshot, ShippingAddress, ShippingParcel } from '@common/gateway/order-shipping.gateway';

export interface QuoteInput { userId: string; shopId: string; pickup: ShippingAddress; destination: ShippingAddress; returnAddress?: ShippingAddress; parcel: ShippingParcel; codValue: string; fallbackFee: string; fingerprint?: string }
export interface ShippingQuoteSnapshot { id: string; userId: string; shopId: string; fingerprint: string; shippingFee: string; feeSource: string; provider: string; environment: string; expiresAt: string; snapshot: ShippingSnapshot }
export interface ShipmentEventSummary { id: string; status: string; rawStatus: string; source: string; eventTime: string; processedAt: string | null }
export interface ShipmentSummary {
  id: string; orderCode: string; shopId: string; provider: string; environment: string; createStatus: string; cancelStatus: string;
  status: string | null; active: boolean; carrierOrderCode: string | null; clientOrderCode: string; trackingUrl: string | null;
  pickedUpAt: string | null; deliveredAt: string | null; attemptNo: number; quotedFee: string; actualFee: string | null; codAmount: string;
  expectedDeliveryAt: string | null; error: string | null; simulated: boolean; deliveryAttempts: number; events: ShipmentEventSummary[];
  codCollectedAt: string | null; codRemittedAt: string | null;
}
export interface CarrierState { carrierOrderCode: string; clientOrderCode: string; rawStatus: string; eventTime: Date; fee: string; deliveryAttempts: number; expectedDeliveryAt?: Date }
export interface CarrierCreateInput { clientOrderCode: string; snapshot: ShippingSnapshot; codAmount: string }
export interface CarrierGateway {
  quote(input: QuoteInput): Promise<string>;
  create(input: CarrierCreateInput): Promise<CarrierState>;
  findByClientCode(code: string): Promise<CarrierState | null>;
  track(code: string): Promise<CarrierState>;
  cancel(code: string): Promise<CarrierState>;
  label(code: string): Promise<{ url?: string; html?: string; internal: boolean }>;
  locations(kind: 'provinces' | 'districts' | 'wards', parentId?: number): Promise<Array<{ id: number | string; name: string; code?: string; parentId?: number }>>;
}
