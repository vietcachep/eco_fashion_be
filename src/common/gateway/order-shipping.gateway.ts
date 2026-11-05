import type { Tx } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';

export const ORDER_SHIPPING_GATEWAY = Symbol('ORDER_SHIPPING_GATEWAY');

export interface ShippingAddress {
  name: string;
  phone: string;
  street: string;
  provinceName: string;
  districtName: string;
  wardName: string;
  provinceId: number;
  districtId: number;
  wardCode: string;
  addressSystem: 'legacy_3level';
}

export interface ShippingParcel { weightGram: number; lengthCm: number; widthCm: number; heightCm: number }
export interface ShippingSnapshot {
  pickup: ShippingAddress;
  destination: ShippingAddress;
  returnAddress?: ShippingAddress;
  parcel: ShippingParcel;
  quotedFee: string;
  quoteId: string;
  provider: string;
  environment: string;
}
export interface ShippingOrderSnapshot {
  id: string;
  code: string;
  userId: string;
  shopId: string;
  status: string;
  paymentStatus: string;
  paymentMethodCode: string;
  fulfilmentMode: string;
  collectionMode: string;
  total: string;
  cancelRequestPending: boolean;
  shippingSnapshot: ShippingSnapshot | null;
}
export interface CarrierOrderUpdate {
  status: string;
  carrierOrderCode: string;
  trackingUrl: string;
  eventTime: Date;
  pickedUpAt?: Date;
  shipmentId: string;
  cancelRequested?: boolean;
}
export interface ShippingCodReceipt { collectedAt: string | null; remittedAt: string | null; reference: string | null }

/* Cổng ngược: shipping khoá ĐƠN trước SHIPMENT và nhờ order áp dụng side-effect trong cùng tx; không import OrderModule. */
export interface OrderShippingGateway {
  lockOrder(code: string, tx: Tx): Promise<ShippingOrderSnapshot | null>;
  applyCarrierUpdate(order: ShippingOrderSnapshot, input: CarrierOrderUpdate, tx: Tx): Promise<void>;
  confirmCodReceived(order: ShippingOrderSnapshot, actor: AuthenticatedActor, input: { amount: string; reference: string; note?: string }, tx: Tx): Promise<void>;
  codReceipts(codes: string[]): Promise<Map<string, ShippingCodReceipt>>;
  recordShippingAction(order: ShippingOrderSnapshot, input: { kind: string; shipmentId: string; message: string }, tx: Tx): Promise<void>;
}
