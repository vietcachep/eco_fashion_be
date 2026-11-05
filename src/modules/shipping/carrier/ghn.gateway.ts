import { Injectable } from '@nestjs/common';
import { BusinessException } from '@common/exception/business.exception';
import type { CarrierGateway, CarrierCreateInput, CarrierState, QuoteInput } from '../foundation/shipping.types';
import { escapeHtml, shippingText } from '../foundation/shipping.pure';

type RecordValue = Record<string, unknown>;
export class GhnHttpError extends Error { constructor(readonly status: number) { super('GHN không chấp nhận yêu cầu'); } }
/* Một adapter gọi GHN duy nhất. Timeout hữu hạn, không log secret, không retry mù create/huỷ. */
@Injectable()
export class GhnGateway implements CarrierGateway {
  private readonly baseURL: string;
  private readonly cache = new Map<string, { until: number; value: Array<{ id: number | string; name: string; code?: string; parentId?: number }> }>();
  constructor() {
    const baseURL = process.env.GHN_BASE_URL ?? 'https://dev-online-gateway.ghn.vn';
    if (!['https://dev-online-gateway.ghn.vn', 'https://online-gateway.ghn.vn'].includes(baseURL)) throw new Error('GHN_BASE_URL không thuộc host GHN được phép');
    this.baseURL = baseURL;
  }
  private async request(method: 'GET' | 'POST', path: string, body: RecordValue = {}): Promise<unknown> {
    if (!process.env.GHN_TOKEN || !process.env.GHN_SHOP_ID) throw new BusinessException('SHIPPING_UNAVAILABLE', 'Chưa cấu hình kết nối GHN', 503);
    const query = method === 'GET' ? `?${new URLSearchParams(Object.entries(body).filter(([, value]) => value !== undefined).map(([key, value]) => [key, shippingText(value)])).toString()}` : '';
    const r = await fetch(`${this.baseURL}/shiip/public-api/${path}${query}`, { method, headers: { Token: process.env.GHN_TOKEN ?? '', ShopId: process.env.GHN_SHOP_ID ?? '', 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(8_000) });
    if (!r.ok) throw new GhnHttpError(r.status);
    const data = await r.json() as { code: number; data: unknown };
    if (data.code !== 200) throw new BusinessException('SHIPPING_GATEWAY_REJECTED', 'GHN chưa chấp nhận yêu cầu vận chuyển', 503);
    return data.data;
  }
  private state(data: unknown): CarrierState {
    const d = data as RecordValue;
    const eventTime = d.updated_date ?? d.updated_at;
    const t = eventTime ? new Date(shippingText(eventTime)) : new Date();
    return { carrierOrderCode: shippingText(d.order_code), clientOrderCode: shippingText(d.client_order_code), rawStatus: shippingText(d.status) || 'ready_to_pick', eventTime: Number.isNaN(t.getTime()) ? new Date() : t, fee: shippingText(d.total_fee ?? (d.total_fee_data as RecordValue | undefined)?.total ?? 0), deliveryAttempts: Number(d.delivery_attempt ?? 0), ...(d.expected_delivery_time ? { expectedDeliveryAt: new Date(shippingText(d.expected_delivery_time)) } : {}) };
  }
  async quote(i: QuoteInput): Promise<string> {
    const d = await this.request('POST', 'v2/shipping-order/fee', { from_district_id: i.pickup.districtId, from_ward_code: i.pickup.wardCode, to_district_id: i.destination.districtId, to_ward_code: i.destination.wardCode, weight: i.parcel.weightGram, length: i.parcel.lengthCm, width: i.parcel.widthCm, height: i.parcel.heightCm, service_type_id: 2, insurance_value: 0, cod_value: Number(i.codValue) }) as RecordValue;
    if (!Number.isSafeInteger(Number(d.total)) || Number(d.total) < 0) throw new BusinessException('SHIPPING_QUOTE_INVALID', 'GHN trả phí vận chuyển không hợp lệ', 503);
    return String(d.total);
  }
  async create(i: CarrierCreateInput): Promise<CarrierState> {
    const s = i.snapshot;
    const address = (prefix: string, a: typeof s.pickup) => ({ [`${prefix}_name`]: a.name, [`${prefix}_phone`]: a.phone, [`${prefix}_address`]: a.street, [`${prefix}_province_name`]: a.provinceName, [`${prefix}_district_name`]: a.districtName, [`${prefix}_ward_name`]: a.wardName, [`${prefix}_district_id`]: a.districtId, [`${prefix}_ward_code`]: a.wardCode });
    const d = await this.request('POST', 'v2/shipping-order/create', { ...address('from', s.pickup), ...address('to', s.destination), ...address('return', s.returnAddress ?? s.pickup), client_order_code: i.clientOrderCode, weight: s.parcel.weightGram, length: s.parcel.lengthCm, width: s.parcel.widthCm, height: s.parcel.heightCm, service_type_id: 2, payment_type_id: 1, required_note: 'KHONGCHOXEMHANG', cod_amount: Number(i.codAmount), content: 'Đơn hàng FITLY', is_new_to_address: false, is_new_from_address: false, is_new_return_address: false }) as RecordValue;
    return this.track(String(d.order_code));
  }
  async findByClientCode(code: string): Promise<CarrierState | null> {
    try { return this.state(await this.request('GET', 'v2/shipping-order/detail-by-client-code', { client_order_code: code })); }
    catch (e) {
      // Chỉ mã lỗi không-tồn-tại rõ ràng mới cho retry cùng mã. Lỗi mạng/5xx không được coi là chưa tạo.
      if (e instanceof GhnHttpError && e.status === 404) return null;
      throw e;
    }
  }
  async track(code: string): Promise<CarrierState> { return this.state(await this.request('GET', 'v2/shipping-order/detail', { order_code: code })); }
  async cancel(code: string): Promise<CarrierState> {
    const d = await this.request('POST', 'v2/switch-status/cancel', { order_codes: [code] });
    if (Array.isArray(d) && d.some((v: RecordValue) => v.result === false || v.result === 'false')) throw new BusinessException('SHIPMENT_CANCEL_REJECTED', 'GHN từ chối huỷ vận đơn', 409);
    const state = await this.track(code);
    if (state.rawStatus !== 'cancel') throw new BusinessException('SHIPMENT_OPERATION_PENDING', 'Đang chờ GHN xác nhận huỷ vận đơn', 409);
    return state;
  }
  async label(code: string): Promise<{ url?: string; html?: string; internal: boolean }> {
    try {
      const d = await this.request('POST', 'v2/a5/gen-token', { order_codes: [code] }) as RecordValue;
      if (typeof d.token === 'string' && d.token) return { url: `${this.baseURL}/a5/public-api/printA5?token=${encodeURIComponent(d.token)}`, internal: false };
    } catch { /* Nhãn hãng lỗi không làm mất vận đơn đã tạo. */ }
    return { html: `<!doctype html><html lang="vi"><meta charset="utf-8"><title>Phiếu nội bộ</title><body><h1>Phiếu nội bộ FITLY</h1><p>Mã GHN: ${escapeHtml(code)}</p><p>Tra cứu mã với GHN trước khi bàn giao.</p></body></html>`, internal: true };
  }
  async locations(kind: 'provinces' | 'districts' | 'wards', parentId?: number) {
    const key = `${kind}:${parentId ?? ''}`;
    const hit = this.cache.get(key); if (hit && hit.until > Date.now()) return hit.value;
    const path = kind === 'provinces' ? 'master-data/province' : kind === 'districts' ? 'master-data/district' : 'master-data/ward';
    const d = await this.request('GET', path, kind === 'districts' ? { province_id: parentId } : kind === 'wards' ? { district_id: parentId } : {});
    if (!Array.isArray(d)) throw new BusinessException('SHIPPING_LOCATIONS_INVALID', 'Danh mục địa chỉ GHN không hợp lệ', 503);
    const value = d.map((v: RecordValue) => kind === 'provinces' ? { id: Number(v.ProvinceID), name: String(v.ProvinceName) } : kind === 'districts' ? { id: Number(v.DistrictID), name: String(v.DistrictName), parentId } : { id: String(v.WardCode), code: String(v.WardCode), name: String(v.WardName), parentId });
    this.cache.set(key, { until: Date.now() + 86_400_000, value }); return value;
  }
}
