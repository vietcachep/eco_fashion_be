import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { BusinessException } from '@common/exception/business.exception';
import { ORDER_SHIPPING_GATEWAY, type OrderShippingGateway, type ShippingSnapshot } from '@common/gateway/order-shipping.gateway';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { Prisma, type Tx } from '@common/prisma/types';
import { isPrismaError } from '@common/prisma/errors';
import type { Shipment, ShipmentEvent } from '../../../generated/prisma/client';
import { ShippingRepository } from '../repository/shipping.repository';
import { FakeCarrierGateway } from '../carrier/fake-carrier.gateway';
import { GhnGateway, GhnHttpError } from '../carrier/ghn.gateway';
import type { CarrierGateway, CarrierState, QuoteInput, ShipmentSummary, ShippingQuoteSnapshot } from '../foundation/shipping.types';
import { hashShipping, mapCarrierStatus, mayTransition, validateParcel, validateShippingAddress, shippingJson, shippingText } from '../foundation/shipping.pure';

type WithEvents = Shipment & { events?: ShipmentEvent[] };
const RETRY_MS = 30_000;

/* Điều phối vận đơn: T1 claim dưới khoá đơn, HTTP ngoài tx, T2 finalize cùng kho/tiền/order gateway. Inbox giữ bền khi worker chết. */
@Injectable()
export class ShippingService {
  private readonly logger = new Logger(ShippingService.name);
  constructor(private readonly repo: ShippingRepository, private readonly fake: FakeCarrierGateway, private readonly ghn: GhnGateway, private readonly modules: ModuleRef) {}
  private get orders(): OrderShippingGateway { return this.modules.get<OrderShippingGateway>(ORDER_SHIPPING_GATEWAY, { strict: false }); }
  provider(): string {
    const p = process.env.SHIPPING_CARRIER ?? 'fake';
    if (!['fake', 'ghn'].includes(p)) throw new BusinessException('SHIPPING_PROVIDER_INVALID', 'Cấu hình hãng vận chuyển không hợp lệ', 503);
    if (p === 'fake' && process.env.NODE_ENV === 'production') throw new BusinessException('SHIPPING_SIMULATOR_DISABLED', 'Không dùng hãng giả lập ở môi trường thật', 503);
    return p;
  }
  environment(): string { return this.provider() === 'fake' ? 'demo' : process.env.GHN_BASE_URL === 'https://online-gateway.ghn.vn' ? 'production' : 'staging'; }
  private carrier(provider: string, environment?: string): CarrierGateway {
    if (provider === 'fake') { if (process.env.NODE_ENV === 'production') throw new BusinessException('SHIPPING_SIMULATOR_DISABLED', 'Hãng giả lập không hoạt động ở môi trường thật', 503); return this.fake; }
    const configured = process.env.GHN_BASE_URL === 'https://online-gateway.ghn.vn' ? 'production' : 'staging';
    if (environment && environment !== configured) throw new BusinessException('SHIPPING_ACCOUNT_CHANGED', 'Cần khôi phục cấu hình GHN của vận đơn này để tiếp tục xử lý', 503);
    return this.ghn;
  }
  summary(s: WithEvents): ShipmentSummary {
    return { id: s.id, orderCode: s.orderCode, shopId: s.shopId, provider: s.provider, environment: s.environment, createStatus: s.createStatus, cancelStatus: s.cancelStatus, status: s.status, active: s.active, carrierOrderCode: s.carrierOrderCode, clientOrderCode: s.clientOrderCode, trackingUrl: s.trackingUrl, pickedUpAt: s.pickedUpAt?.toISOString() ?? null, deliveredAt: s.deliveredAt?.toISOString() ?? null, attemptNo: s.attemptNo, quotedFee: s.quotedFee.toString(), actualFee: s.actualFee?.toString() ?? null, codAmount: s.codAmount.toString(), expectedDeliveryAt: s.expectedDeliveryAt?.toISOString() ?? null, error: s.lastError, simulated: s.provider === 'fake', deliveryAttempts: s.deliveryAttempts, codCollectedAt: null, codRemittedAt: null, events: (s.events ?? []).map((e) => ({ id: e.id, status: e.status, rawStatus: e.rawStatus, source: e.source, eventTime: e.eventTime.toISOString(), processedAt: e.processedAt?.toISOString() ?? null })) };
  }
  async quote(i: QuoteInput): Promise<ShippingQuoteSnapshot> {
    validateShippingAddress(i.pickup); validateShippingAddress(i.destination); validateParcel(i.parcel);
    if (!/^\d{1,14}$/.test(i.codValue)) throw new BusinessException('SHIPPING_COD_INVALID', 'Giá trị thu hộ không hợp lệ');
    const provider = this.provider(); const environment = this.environment(); const gateway = this.carrier(provider);
    for (const a of [i.pickup, i.destination, ...(i.returnAddress ? [i.returnAddress] : [])]) {
      validateShippingAddress(a);
      const [provinces, districts, wards] = await Promise.all([gateway.locations('provinces'), gateway.locations('districts', a.provinceId), gateway.locations('wards', a.districtId)]);
      if (!provinces.some((p) => p.id === a.provinceId) || !districts.some((d) => d.id === a.districtId) || !wards.some((w) => String(w.id) === a.wardCode)) throw new BusinessException('SHIPPING_ADDRESS_INVALID', 'Mã tỉnh/quận/phường không cùng danh mục vận chuyển');
    }
    let fee: string; let feeSource = provider;
    try { fee = await gateway.quote(i); }
    catch (e) {
      if (e instanceof BusinessException && ['SHIPPING_ADDRESS_INVALID', 'SHIPPING_PARCEL_INVALID'].includes(e.errorCode)) throw e;
      if (e instanceof GhnHttpError && e.status >= 400 && e.status < 500) throw new BusinessException('SHIPPING_ROUTE_UNAVAILABLE', 'GHN không nhận tuyến hoặc kiện hàng này; kiểm tra lại địa chỉ và kiện', 409);
      if (!/^\d+$/.test(i.fallbackFee)) throw e;
      fee = i.fallbackFee; feeSource = 'fallback';
    }
    // Cổng nội bộ order đã hash giỏ/giá/địa chỉ: giữ nguyên để kiểm lại trong tx không bị băm hai lần.
    const fingerprint = i.fingerprint ?? hashShipping({ userId: i.userId, shopId: i.shopId, pickup: i.pickup, destination: i.destination, returnAddress: i.returnAddress ?? i.pickup, parcel: i.parcel, codValue: i.codValue, provider, environment });
    const r = await this.repo.quoteCreate({ userId: i.userId, shopId: i.shopId, provider, environment, fingerprint, snapshot: shippingJson({ pickup: i.pickup, destination: i.destination, returnAddress: i.returnAddress ?? i.pickup, parcel: i.parcel, quotedFee: fee, provider, environment }), shippingFee: fee, feeSource, expiresAt: new Date(Date.now() + 300_000) });
    return this.quoteSummary(r);
  }
  private quoteSummary(r: { id: string; userId: string; shopId: string; fingerprint: string; shippingFee: Prisma.Decimal; feeSource: string; provider: string; environment: string; expiresAt: Date; snapshot: Prisma.JsonValue }): ShippingQuoteSnapshot {
    return { id: r.id, userId: r.userId, shopId: r.shopId, fingerprint: r.fingerprint, shippingFee: r.shippingFee.toString(), feeSource: r.feeSource, provider: r.provider, environment: r.environment, expiresAt: r.expiresAt.toISOString(), snapshot: { ...(r.snapshot as unknown as ShippingSnapshot), quoteId: r.id } };
  }
  async getQuote(id: string, userId: string) { const r = await this.repo.quote(id, userId); return r ? this.quoteSummary(r) : null; }
  private async withReceipts(rows: ShipmentSummary[]): Promise<ShipmentSummary[]> {
    if (rows.length === 0) return rows;
    const receipts = await this.orders.codReceipts([...new Set(rows.map((r) => r.orderCode))]);
    return rows.map((r) => ({ ...r, codCollectedAt: receipts.get(r.orderCode)?.collectedAt ?? null, codRemittedAt: receipts.get(r.orderCode)?.remittedAt ?? null }));
  }
  async history(code: string): Promise<ShipmentSummary[]> { return this.withReceipts((await this.repo.history(code.toUpperCase())).map((r) => this.summary(r))); }
  async summaries(codes: string[]): Promise<Map<string, ShipmentSummary>> { const values = await this.repo.histories(codes); const result = new Map<string, ShipmentSummary>(); for (const s of await this.withReceipts(values.map((s) => this.summary(s)))) if (!result.has(s.orderCode)) result.set(s.orderCode, s); return result; }
  async historyOwned(shopId: string, code: string): Promise<ShipmentSummary[]> { await this.repo.transaction(async (tx) => { await this.owned(code.toUpperCase(), shopId, tx); }); return this.history(code); }
  async latest(code: string): Promise<ShipmentSummary | null> { return (await this.history(code))[0] ?? null; }
  async barrier(code: string, tx: Tx): Promise<ShipmentSummary | null> { const r = await this.repo.active(code, tx); return r ? this.summary(r) : null; }
  private async owned(code: string, shopId: string, tx: Tx) {
    const o = await this.orders.lockOrder(code.toUpperCase(), tx);
    if (!o || o.shopId !== shopId) throw new BusinessException('ORDER_NOT_FOUND', 'Không tìm thấy đơn hàng', 404);
    return o;
  }
  async ship(actor: AuthenticatedActor | null, shopId: string, code: string): Promise<ShipmentSummary | null> {
    code = code.toUpperCase(); const token = randomUUID();
    const claim = await this.repo.transaction(async (tx) => {
      const o = await this.owned(code, shopId, tx);
      let s = await this.repo.active(code, tx);
      if (s?.createStatus === 'created') return { s, owned: false };
      if (s?.leaseUntil && s.leaseUntil > new Date()) return { s, owned: false };
      if (!s) {
        if (o.fulfilmentMode !== 'carrier' || o.status !== 'packing' || !o.shippingSnapshot || o.cancelRequestPending || (o.paymentMethodCode === 'payos' && o.paymentStatus !== 'paid')) throw new BusinessException('SHIPMENT_CANNOT_CREATE', 'Chỉ yêu cầu lấy hàng khi đơn đang đóng gói, đã đủ thanh toán và không chờ huỷ', 409);
        const a = o.shippingSnapshot;
        validateShippingAddress(a.pickup); validateShippingAddress(a.destination); validateParcel(a.parcel);
        const n = ((await this.repo.maxAttempt(code, tx))._max.attemptNo ?? 0) + 1;
        const suffix = n.toString(36).toUpperCase();
        s = await this.repo.create({ orderId: o.id, orderCode: code, shopId, attemptNo: n, provider: a.provider, environment: a.environment, accountScope: a.provider === 'fake' ? 'demo' : process.env.GHN_SHOP_ID ?? '', clientOrderCode: `${code}-S${suffix}`, quotedFee: a.quotedFee, codAmount: o.collectionMode === 'carrier_cod' ? o.total : '0', snapshot: shippingJson(a), createdBy: actor?.userId }, tx);
        await this.orders.recordShippingAction(o, { kind: 'create_claimed', shipmentId: s.id, message: 'Đã ghi yêu cầu tạo vận đơn, đang chờ hãng tiếp nhận' }, tx);
      }
      s = await this.repo.update(s.id, { leaseToken: token, leaseUntil: new Date(Date.now() + 60_000), retryAt: new Date(Date.now() + RETRY_MS), updatedBy: actor?.userId }, tx);
      return { s, owned: true };
    });
    if (!claim.owned) return (await this.withReceipts([this.summary(claim.s)]))[0];
    return this.createClaimed(claim.s, token);
  }
  private async createClaimed(s: Shipment, token: string): Promise<ShipmentSummary | null> {
    try {
      const carrier = this.carrier(s.provider, s.environment);
      let state = await carrier.findByClientCode(s.clientOrderCode);
      if (!state) state = await carrier.create({ clientOrderCode: s.clientOrderCode, snapshot: s.snapshot as unknown as ShippingSnapshot, codAmount: s.codAmount.toString() });
      await this.repo.transaction(async (tx) => {
        const o = await this.orders.lockOrder(s.orderCode, tx); const locked = await this.repo.active(s.orderCode, tx);
        if (!o || !locked || locked.id !== s.id || locked.leaseToken !== token) return;
        const trackingUrl = s.provider === 'ghn' ? `https://donhang.ghn.vn/?order_code=${encodeURIComponent(state.carrierOrderCode)}` : null;
        await this.repo.update(s.id, { createStatus: 'created', carrierOrderCode: state.carrierOrderCode, status: 'awaiting_pickup', rawStatus: 'ready_to_pick', actualFee: state.fee, expectedDeliveryAt: state.expectedDeliveryAt, trackingUrl, leaseToken: null, leaseUntil: null, lastError: null, version: { increment: 1 } }, tx);
        await this.orders.applyCarrierUpdate(o, { status: 'awaiting_pickup', carrierOrderCode: state.carrierOrderCode, trackingUrl: trackingUrl ?? '', eventTime: new Date(), shipmentId: s.id }, tx);
      });
      if (state.rawStatus !== 'ready_to_pick') await this.enqueueState(s, state, 'poll');
    } catch (e) {
      await this.repo.transaction(async (tx) => {
        const o = await this.orders.lockOrder(s.orderCode, tx); const current = await this.repo.active(s.orderCode, tx);
        if (!o || !current || current.id !== s.id || current.leaseToken !== token) return;
        await this.repo.update(s.id, { createStatus: 'unknown', leaseToken: null, leaseUntil: null, retryAt: new Date(Date.now() + RETRY_MS), lastError: e instanceof BusinessException ? e.message.slice(0, 1000) : 'Chưa rõ kết quả tạo vận đơn, hệ thống sẽ đối soát', version: { increment: 1 } }, tx);
        if (current.createStatus !== 'unknown') await this.orders.recordShippingAction(o, { kind: 'create_unknown', shipmentId: s.id, message: 'Chưa rõ kết quả tạo vận đơn; hệ thống đang đối soát trước khi thử lại' }, tx);
      });
      this.logger.warn({ shipmentId: s.id }, 'Tạo vận đơn chưa rõ kết quả; giữ attempt để đối soát');
    }
    const r = await this.repo.shipment(s.id); return r ? (await this.withReceipts([this.summary(r)]))[0] : null;
  }
  async reconcile(actor: AuthenticatedActor | null, shopId: string, code: string): Promise<ShipmentSummary | null> {
    const s = await this.repo.transaction(async (tx) => { await this.owned(code.toUpperCase(), shopId, tx); return this.repo.active(code.toUpperCase(), tx); });
    if (!s) return null;
    if (!s.carrierOrderCode || s.createStatus !== 'created') return this.ship(actor, shopId, code);
    const state = await this.carrier(s.provider, s.environment).track(s.carrierOrderCode);
    await this.enqueueState(s, state, 'poll'); await this.processEvents();
    return this.latest(code);
  }
  async cancel(actor: AuthenticatedActor | null, shopId: string, code: string): Promise<ShipmentSummary | null> {
    const token = randomUUID();
    const s = await this.repo.transaction(async (tx) => {
      await this.owned(code.toUpperCase(), shopId, tx); const r = await this.repo.active(code.toUpperCase(), tx);
      if (!r) return null;
      if (r.createStatus !== 'created' || !r.carrierOrderCode || (r.leaseUntil && r.leaseUntil > new Date())) throw new BusinessException('SHIPMENT_OPERATION_PENDING', 'Cần đối soát vận đơn trước khi huỷ', 409);
      if (r.pickedUpAt) throw new BusinessException('SHIPMENT_ALREADY_PICKED', 'Hãng đã lấy hàng, không huỷ trực tiếp được', 409);
      return this.repo.update(r.id, { cancelStatus: 'requested', leaseToken: token, leaseUntil: new Date(Date.now() + 60_000), updatedBy: actor?.userId }, tx);
    });
    if (!s?.carrierOrderCode) return null;
    try { const state = await this.carrier(s.provider, s.environment).cancel(s.carrierOrderCode); await this.enqueueState(s, state, 'poll'); await this.processEvents(); }
    catch { await this.repo.update(s.id, { cancelStatus: 'unknown', lastError: 'Chưa rõ kết quả huỷ, đang chờ đối soát', retryAt: new Date(Date.now() + RETRY_MS) }); }
    finally { await this.repo.update(s.id, { leaseToken: null, leaseUntil: null }); }
    return this.latest(code);
  }
  private async enqueueState(s: Shipment, state: CarrierState, source: string, eventId?: string) {
    return this.repo.eventUpsert({ dedupKey: hashShipping([s.provider, s.environment, state.carrierOrderCode, state.rawStatus, eventId ?? state.eventTime.toISOString(), state.deliveryAttempts]), shipmentId: s.id, provider: s.provider, environment: s.environment, carrierOrderCode: state.carrierOrderCode, clientOrderCode: s.clientOrderCode, rawStatus: state.rawStatus, eventTime: state.eventTime, source, payload: shippingJson(state) });
  }
  async webhook(secret: string, payload: Record<string, unknown>): Promise<void> {
    const expected = process.env.GHN_WEBHOOK_SECRET ?? ''; const a = Buffer.from(secret ?? ''); const b = Buffer.from(expected);
    if (!expected || a.length !== b.length || !timingSafeEqual(a, b)) throw new BusinessException('SHIPMENT_WEBHOOK_NOT_FOUND', 'Không tìm thấy đường dẫn', 404);
    const raw = JSON.stringify(payload);
    if (raw.length > 32_000) throw new BusinessException('SHIPPING_PAYLOAD_TOO_LARGE', 'Nội dung callback quá lớn', 413);
    const carrierOrderCode = typeof payload.OrderCode === 'string' ? payload.OrderCode.slice(0, 60) : null;
    const clientOrderCode = typeof payload.ClientOrderCode === 'string' ? payload.ClientOrderCode.slice(0, 50) : null;
    const rawStatus = shippingText(payload.Status).slice(0, 50);
    if (!carrierOrderCode && !clientOrderCode) return;
    const environment = process.env.GHN_BASE_URL === 'https://online-gateway.ghn.vn' ? 'production' : 'staging';
    const s = await this.repo.findShipment(carrierOrderCode, clientOrderCode, 'ghn', environment);
    const t = typeof payload.Time === 'number' ? new Date(payload.Time < 1e12 ? payload.Time * 1000 : payload.Time) : new Date(shippingText(payload.Time));
    const validTime = !Number.isNaN(t.getTime()) && Math.abs(Date.now() - t.getTime()) < 365 * 86_400_000;
    await this.repo.eventUpsert({ dedupKey: hashShipping(['ghn', environment, carrierOrderCode, clientOrderCode, payload.Type, rawStatus, validTime ? t.toISOString() : hashShipping(payload)]), shipmentId: s?.id, provider: 'ghn', environment, carrierOrderCode, clientOrderCode, rawStatus, eventTime: validTime ? t : new Date(), payload: shippingJson(payload), source: 'webhook', status: validTime ? 'pending' : 'pending_verify' });
  }
  async processEvents(): Promise<number> {
    let done = 0;
    for (const e of await this.repo.pendingEvents()) {
      const token = randomUUID(); if (!(await this.repo.claimEvent(e.id, token)).count) continue;
      try {
        const s = e.shipmentId ? await this.repo.shipment(e.shipmentId) : await this.repo.findShipment(e.carrierOrderCode, e.clientOrderCode, e.provider, e.environment);
        if (!s?.carrierOrderCode) throw new Error('Chờ liên kết vận đơn');
        const state = await this.carrier(s.provider, s.environment).track(s.carrierOrderCode); const status = mapCarrierStatus(state.rawStatus);
        if (!status) {
          await this.repo.transaction(async (tx) => {
            const o = await this.orders.lockOrder(s.orderCode, tx); const current = await this.repo.active(s.orderCode, tx);
            if (!o || !current || current.id !== s.id) return;
            const dedupKey = hashShipping(['carrier-exception', s.id, state.rawStatus]);
            if (!(await this.repo.eventByDedup(dedupKey, tx))) {
              await this.repo.eventUpsert({ dedupKey, shipmentId: s.id, provider: s.provider, environment: s.environment, carrierOrderCode: s.carrierOrderCode, clientOrderCode: s.clientOrderCode, rawStatus: state.rawStatus, eventTime: new Date(), source: 'system', payload: {}, status: 'processed', processedAt: new Date() }, tx);
              await this.orders.recordShippingAction(o, { kind: 'carrier_exception', shipmentId: s.id, message: 'Hãng báo ngoại lệ vận chuyển; CSKH cần kiểm tra với hãng trước khi thay đổi đơn/kho/tiền' }, tx);
            }
            await this.repo.update(s.id, { lastError: 'Hãng báo ngoại lệ cần CSKH xử lý', rawStatus: state.rawStatus }, tx);
          });
          throw new Error('Trạng thái hãng cần xác minh');
        }
        await this.repo.transaction(async (tx) => {
          const o = await this.orders.lockOrder(s.orderCode, tx); const current = await this.repo.active(s.orderCode, tx); const event = await this.repo.eventForUpdate(e.id, tx);
          if (!event || event.status === 'processed' || event.leaseToken !== token) return;
          if (!o || !current || current.id !== s.id) { await this.repo.eventUpdate(e.id, { status: 'processed', processedAt: new Date(), leaseToken: null, leaseUntil: null }, tx); return; }
          if (!mayTransition(current.status, status)) { await this.repo.eventUpdate(e.id, { status: 'processed', processedAt: new Date(), lastError: 'Bỏ qua trạng thái cũ hoặc chuyển ngược', leaseToken: null, leaseUntil: null }, tx); return; }
          const picked = !['awaiting_pickup', 'cancelled'].includes(status) ? current.pickedUpAt ?? state.eventTime : current.pickedUpAt;
          await this.repo.update(s.id, { status, rawStatus: state.rawStatus, lastEventAt: state.eventTime, actualFee: state.fee, deliveryAttempts: state.deliveryAttempts, pickedUpAt: picked, deliveredAt: status === 'delivered' ? current.deliveredAt ?? state.eventTime : current.deliveredAt, active: !['delivered', 'returned', 'cancelled', 'lost'].includes(status), cancelStatus: status === 'cancelled' ? 'confirmed' : current.cancelStatus, retryAt: new Date(Date.now() + 300_000), lastError: null }, tx);
          if (current.status !== status || (status === 'returned' && current.active)) await this.orders.applyCarrierUpdate(o, { status, carrierOrderCode: state.carrierOrderCode, trackingUrl: current.trackingUrl ?? '', eventTime: state.eventTime, pickedUpAt: picked ?? undefined, shipmentId: s.id, cancelRequested: current.cancelStatus === 'requested' || current.cancelStatus === 'unknown' }, tx);
          if (status === 'returned') {
            const after = await this.orders.lockOrder(s.orderCode, tx);
            if (after?.status === 'shipping') {
              // Hàng đã về nhưng tranh chấp chưa khép: giữ attempt/event để tiếp tục khi CSKH giải quyết, không bỏ rơi đơn.
              await this.repo.update(s.id, { active: true, retryAt: new Date(Date.now() + RETRY_MS), lastError: 'Hàng đã trả về, đang chờ giải quyết yêu cầu chưa nhận hàng' }, tx);
              await this.repo.eventUpdate(e.id, { shipmentId: s.id, status: 'failed', retryAt: new Date(Date.now() + RETRY_MS), lastError: 'Chờ kết thúc tranh chấp trước khi đóng đơn', leaseToken: null, leaseUntil: null }, tx);
              return;
            }
          }
          if ((status === 'lost' && current.status !== 'lost') || (state.deliveryAttempts >= 3 && current.deliveryAttempts < 3)) await this.orders.recordShippingAction(o, { kind: 'carrier_exception', shipmentId: s.id, message: status === 'lost' ? 'Hãng báo thất lạc/hư hỏng; cần CSKH xác minh, chưa tự bồi thường' : 'Đã giao thất bại ít nhất ba lần; cần theo dõi hoàn hàng, chưa được nhập kho khi hãng chưa xác nhận hàng về' }, tx);
          await this.repo.eventUpdate(e.id, { shipmentId: s.id, status: 'processed', processedAt: new Date(), leaseToken: null, leaseUntil: null, lastError: null }, tx);
        }); done++;
      } catch {
        await this.repo.eventUpdate(e.id, { status: 'failed', retryCount: { increment: 1 }, retryAt: new Date(Date.now() + Math.min(1800_000, RETRY_MS * 2 ** Math.min(e.retryCount, 6))), leaseToken: null, leaseUntil: null, lastError: 'Đang chờ xác minh hoặc xử lý đơn, sẽ tự thử lại' });
      }
    }
    return done;
  }
  async runJobs(): Promise<void> {
    for (const s of await this.repo.dueShipments()) {
      try { await this.reconcile(null, s.shopId, s.orderCode); await this.pickupAlert(s.id); } catch { this.logger.warn({ shipmentId: s.id }, 'Chưa đối soát được vận đơn'); }
    }
    await this.processEvents();
  }
  private async pickupAlert(id: string): Promise<void> {
    const s = await this.repo.shipment(id);
    if (!s || s.status !== 'awaiting_pickup' || Date.now() - s.createdAt.getTime() < 86_400_000) return;
    await this.repo.transaction(async (tx) => {
      const o = await this.orders.lockOrder(s.orderCode, tx); const current = await this.repo.active(s.orderCode, tx);
      if (!o || !current || current.id !== id || current.status !== 'awaiting_pickup') return;
      const dedupKey = hashShipping(['pickup-overdue', id]);
      if (await this.repo.eventByDedup(dedupKey, tx)) return;
      await this.repo.eventUpsert({ dedupKey, shipmentId: id, provider: s.provider, environment: s.environment, carrierOrderCode: s.carrierOrderCode, clientOrderCode: s.clientOrderCode, rawStatus: 'pickup_overdue', eventTime: new Date(), source: 'system', payload: {}, status: 'processed', processedAt: new Date() }, tx);
      await this.orders.recordShippingAction(o, { kind: 'pickup_overdue', shipmentId: id, message: 'Hãng chưa lấy hàng sau 24 giờ; cần shop và sàn kiểm tra, không tính vi phạm shop' }, tx);
    });
  }
  async simulate(id: string, event: string, eventId?: string): Promise<ShipmentSummary> {
    if (process.env.NODE_ENV === 'production') throw new BusinessException('SHIPPING_SIMULATOR_DISABLED', 'Không có giả lập ở môi trường thật', 404);
    const s = await this.repo.shipment(id);
    if (!s || s.provider !== 'fake' || !s.carrierOrderCode) throw new BusinessException('SHIPMENT_NOT_FOUND', 'Chỉ mô phỏng vận đơn của hãng giả lập', 404);
    const raw = event === 'in_transit' ? 'transporting' : event;
    const state = await this.fake.simulate(s.carrierOrderCode, raw); await this.enqueueState(s, state, 'simulator', eventId); await this.processEvents();
    return this.detail(id);
  }
  async label(shopId: string, code: string) {
    const s = await this.repo.transaction(async (tx) => { await this.owned(code.toUpperCase(), shopId, tx); return this.repo.active(code.toUpperCase(), tx); });
    const latest = s ?? (await this.repo.history(code.toUpperCase()))[0];
    if (!latest?.carrierOrderCode || latest.createStatus !== 'created') throw new BusinessException('SHIPMENT_LABEL_NOT_READY', 'Chưa có mã vận đơn để in', 409);
    return this.carrier(latest.provider, latest.environment).label(latest.carrierOrderCode);
  }
  async list(filter: { status?: string; q?: string; shopId?: string }, page: number, size: number) {
    const q = filter.q?.trim();
    const clauses: Prisma.ShipmentWhereInput[] = [];
    if (filter.status) clauses.push({ OR: [{ status: filter.status }, { createStatus: filter.status }, { cancelStatus: filter.status }] });
    if (q) clauses.push({ OR: [{ orderCode: { contains: q, mode: 'insensitive' } }, { carrierOrderCode: { contains: q, mode: 'insensitive' } }, { clientOrderCode: { contains: q, mode: 'insensitive' } }] });
    const [items, total] = await this.repo.list({ ...(filter.shopId ? { shopId: filter.shopId } : {}), ...(clauses.length ? { AND: clauses } : {}) }, (page - 1) * size, size);
    return { items: await this.withReceipts(items.map((s) => this.summary(s))), total };
  }
  async detail(id: string) { const s = await this.repo.shipment(id); if (!s) throw new BusinessException('SHIPMENT_NOT_FOUND', 'Không tìm thấy vận đơn', 404); return (await this.withReceipts([this.summary(s)]))[0]; }
  async confirmCod(actor: AuthenticatedActor, id: string, input: { amount: string; reference: string; note?: string }) {
    const s = await this.repo.shipment(id); if (!s) throw new BusinessException('SHIPMENT_NOT_FOUND', 'Không tìm thấy vận đơn', 404);
    try {
      await this.repo.transaction(async (tx) => { const o = await this.orders.lockOrder(s.orderCode, tx); if (!o) throw new BusinessException('ORDER_NOT_FOUND', 'Không tìm thấy đơn', 404); await this.repo.active(s.orderCode, tx); if (s.status !== 'delivered') throw new BusinessException('SHIPMENT_COD_NOT_COLLECTED', 'Chưa có bằng chứng hãng giao thành công', 409); await this.orders.confirmCodReceived(o, actor, input, tx); });
    } catch (e) {
      if (isPrismaError(e, 'P2002')) throw new BusinessException('PAYMENT_COD_REFERENCE_USED', 'Mã chứng từ COD đã được sử dụng; kiểm tra trước khi xác nhận lại', 409);
      throw e;
    }
    return this.detail(id);
  }
  locations(kind: 'provinces' | 'districts' | 'wards', parentId?: number) { return this.carrier(this.provider()).locations(kind, parentId); }
}
