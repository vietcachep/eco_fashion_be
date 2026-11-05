import { Injectable } from '@nestjs/common';
import { BusinessException } from '@common/exception/business.exception';
import type { FakeCarrierState } from '../../../generated/prisma/client';
import type { CarrierGateway, CarrierCreateInput, CarrierState, QuoteInput } from '../foundation/shipping.types';
import { escapeHtml, mapCarrierStatus, mayTransition, shippingJson } from '../foundation/shipping.pure';
import { ShippingRepository } from '../repository/shipping.repository';

export const FAKE_PROVINCES = [{ id: 202, name: 'Hồ Chí Minh' }, { id: 201, name: 'Hà Nội' }];
export const FAKE_DISTRICTS = [{ id: 1442, name: 'Quận 1', parentId: 202 }, { id: 1443, name: 'Quận 3', parentId: 202 }, { id: 1485, name: 'Quận Ba Đình', parentId: 201 }];
export const FAKE_WARDS = [{ id: '20101', code: '20101', name: 'Phường Bến Nghé', parentId: 1442 }, { id: '20301', code: '20301', name: 'Phường Võ Thị Sáu', parentId: 1443 }, { id: '10301', code: '10301', name: 'Phường Phúc Xá', parentId: 1485 }];

/* Hãng giả có nguồn trạng thái DB riêng, không đọc Shipment để tránh simulator tự bỏ qua đường xác minh. */
@Injectable()
export class FakeCarrierGateway implements CarrierGateway {
  constructor(private readonly repo: ShippingRepository) {}
  private state(row: FakeCarrierState): CarrierState { return { carrierOrderCode: row.carrierOrderCode, clientOrderCode: row.clientOrderCode, rawStatus: row.rawStatus, eventTime: row.eventTime, fee: row.fee.toString(), deliveryAttempts: row.deliveryAttempts }; }
  quote(i: QuoteInput): Promise<string> { return Promise.resolve(String((i.pickup.provinceId === i.destination.provinceId ? 25_000 : 35_000) + Math.max(0, Math.ceil((i.parcel.weightGram - 500) / 500)) * 2500)); }
  async create(i: CarrierCreateInput): Promise<CarrierState> {
    const row = await this.repo.fakeCreate({ clientOrderCode: i.clientOrderCode, carrierOrderCode: `FAKE-${i.clientOrderCode}`, fee: i.snapshot.quotedFee, codAmount: i.codAmount, snapshot: shippingJson(i.snapshot) });
    return this.state(row);
  }
  async findByClientCode(code: string): Promise<CarrierState | null> { const r = await this.repo.fakeByClient(code); return r ? this.state(r) : null; }
  async track(code: string): Promise<CarrierState> { const r = await this.repo.fakeByCarrier(code); if (!r) throw new BusinessException('SHIPMENT_NOT_FOUND', 'Không tìm thấy vận đơn giả lập', 404); return this.state(r); }
  async cancel(code: string): Promise<CarrierState> {
    const r = await this.repo.fakeByCarrier(code);
    if (!r) throw new BusinessException('SHIPMENT_NOT_FOUND', 'Không tìm thấy vận đơn', 404);
    if (r.rawStatus === 'cancel') return this.state(r);
    if (!['ready_to_pick', 'picking'].includes(r.rawStatus)) throw new BusinessException('SHIPMENT_ALREADY_PICKED', 'Hãng đã lấy hàng, không huỷ trực tiếp được', 409);
    return this.state(await this.repo.fakeUpdate(r.id, { rawStatus: 'cancel', revision: { increment: 1 }, eventTime: new Date() }));
  }
  async simulate(code: string, rawStatus: string): Promise<CarrierState> {
    const r = await this.repo.fakeByCarrier(code);
    if (!r) throw new BusinessException('SHIPMENT_NOT_FOUND', 'Không tìm thấy vận đơn', 404);
    const next = mapCarrierStatus(rawStatus);
    if (!next || !mayTransition(mapCarrierStatus(r.rawStatus), next)) throw new BusinessException('SHIPMENT_INVALID_TRANSITION', 'Hãng giả không được chuyển lùi hoặc đổi trạng thái đã kết thúc', 409);
    if (r.rawStatus === rawStatus) return this.state(r);
    return this.state(await this.repo.fakeUpdate(r.id, { rawStatus, revision: { increment: 1 }, deliveryAttempts: rawStatus === 'delivery_fail' ? { increment: 1 } : undefined, eventTime: new Date() }));
  }
  async label(code: string): Promise<{ html: string; internal: boolean }> {
    const s = await this.track(code);
    return { internal: true, html: `<!doctype html><html lang="vi"><meta charset="utf-8"><title>Phiếu vận chuyển</title><body><h1>Phiếu nội bộ — Hãng giả lập</h1><p>Mã vận đơn: <strong>${escapeHtml(s.carrierOrderCode)}</strong></p><p>Mã đơn: ${escapeHtml(s.clientOrderCode)}</p><p>Không sử dụng để giao hàng thực tế.</p></body></html>` };
  }
  locations(kind: 'provinces' | 'districts' | 'wards', parentId?: number) { return Promise.resolve(kind === 'provinces' ? FAKE_PROVINCES : kind === 'districts' ? FAKE_DISTRICTS.filter((v) => v.parentId === parentId) : FAKE_WARDS.filter((v) => v.parentId === parentId)); }
}
