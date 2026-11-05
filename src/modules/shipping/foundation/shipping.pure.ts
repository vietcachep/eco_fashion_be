import { createHash } from 'node:crypto';
import { BusinessException } from '@common/exception/business.exception';
import type { ShippingAddress, ShippingParcel } from '@common/gateway/order-shipping.gateway';
import type { Prisma } from '@common/prisma/types';

export const hashShipping = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const shippingJson = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export const shippingText = (value: unknown): string => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
export function validateParcel(p: ShippingParcel): void {
  if (![p.weightGram, p.lengthCm, p.widthCm, p.heightCm].every((v) => Number.isInteger(v) && v > 0) || p.weightGram >= 20_000 || Math.max(p.lengthCm, p.widthCm, p.heightCm) > 200) throw new BusinessException('SHIPPING_PARCEL_INVALID', 'Kiện hàng phải nhẹ hơn 20kg, các chiều từ 1 đến 200cm');
}
export function validateShippingAddress(a: ShippingAddress): void {
  const text = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;
  if (!a || a.addressSystem !== 'legacy_3level' || !text(a.name) || typeof a.phone !== 'string' || !/^[+\d\s()-]{8,20}$/.test(a.phone) || !text(a.street) || !text(a.provinceName) || !text(a.districtName) || !text(a.wardName) || !Number.isInteger(a.provinceId) || a.provinceId <= 0 || !Number.isInteger(a.districtId) || a.districtId <= 0 || !text(a.wardCode)) throw new BusinessException('SHIPPING_ADDRESS_INVALID', 'Chọn đủ tỉnh, quận/huyện, phường/xã và thông tin người nhận');
}
export function mapCarrierStatus(raw: string): string | null {
  if (['ready_to_pick', 'picking', 'money_collect_picking'].includes(raw)) return 'awaiting_pickup';
  if (raw === 'picked') return 'picked';
  if (['storing', 'transporting', 'sorting', 'in_transit'].includes(raw)) return 'in_transit';
  if (['delivering', 'money_collect_delivering'].includes(raw)) return 'delivering';
  if (raw === 'delivery_fail') return 'delivery_failed';
  if (['waiting_to_return', 'return', 'return_transporting', 'return_sorting', 'returning'].includes(raw)) return 'returning';
  if (['returned', 'delivered', 'lost'].includes(raw)) return raw;
  if (raw === 'damage') return 'lost';
  if (raw === 'cancel') return 'cancelled';
  return null;
}
const FORWARD: Record<string, readonly string[]> = {
  awaiting_pickup: ['picked', 'in_transit', 'delivering', 'delivery_failed', 'returning', 'returned', 'delivered', 'cancelled', 'lost'],
  picked: ['in_transit', 'delivering', 'delivery_failed', 'returning', 'returned', 'delivered', 'lost'],
  in_transit: ['delivering', 'delivery_failed', 'returning', 'returned', 'delivered', 'lost'],
  delivering: ['delivery_failed', 'returning', 'returned', 'delivered', 'lost'],
  delivery_failed: ['delivering', 'returning', 'returned', 'delivered', 'lost'],
  returning: ['returned', 'lost'],
};
export const mayTransition = (from: string | null, to: string): boolean => from === null || from === to || (FORWARD[from] ?? []).includes(to);
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
