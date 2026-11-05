import { Injectable } from '@nestjs/common';
import { PrismaService } from '@common/prisma/prisma.service';
import { Prisma, type Tx } from '@common/prisma/types';

/* Chỉ repository này truy cập các delegate shipping. Khoá shipment luôn sau khi caller đã khoá đơn. */
@Injectable()
export class ShippingRepository {
  constructor(readonly prisma: PrismaService) {}
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> { return this.prisma.$transaction(fn, { timeout: 15_000 }); }
  quoteCreate(data: Prisma.ShippingQuoteUncheckedCreateInput) { return this.prisma.shippingQuote.create({ data }); }
  quote(id: string, userId: string) { return this.prisma.shippingQuote.findFirst({ where: { id, userId, isDeleted: false } }); }
  history(code: string, tx?: Tx) { return (tx ?? this.prisma).shipment.findMany({ where: { orderCode: code, isDeleted: false }, orderBy: { attemptNo: 'desc' }, include: { events: { orderBy: { eventTime: 'desc' }, take: 30 } } }); }
  histories(codes: string[]) { return this.prisma.shipment.findMany({ where: { orderCode: { in: codes }, isDeleted: false }, orderBy: { attemptNo: 'desc' }, include: { events: { orderBy: { eventTime: 'desc' }, take: 10 } } }); }
  shipment(id: string, tx?: Tx) { return (tx ?? this.prisma).shipment.findFirst({ where: { id, isDeleted: false }, include: { events: { orderBy: { eventTime: 'desc' }, take: 30 } } }); }
  async active(code: string, tx: Tx) {
    await tx.$queryRaw`SELECT id FROM shipping.shipments WHERE order_code=${code} AND active=true AND is_deleted=false FOR UPDATE`;
    return tx.shipment.findFirst({ where: { orderCode: code, active: true, isDeleted: false } });
  }
  create(data: Prisma.ShipmentUncheckedCreateInput, tx: Tx) { return tx.shipment.create({ data }); }
  update(id: string, data: Prisma.ShipmentUncheckedUpdateInput, tx?: Tx) { return (tx ?? this.prisma).shipment.update({ where: { id }, data }); }
  maxAttempt(code: string, tx: Tx) { return tx.shipment.aggregate({ where: { orderCode: code }, _max: { attemptNo: true } }); }
  list(where: Prisma.ShipmentWhereInput, skip: number, take: number) { return Promise.all([this.prisma.shipment.findMany({ where: { ...where, isDeleted: false }, orderBy: { createdAt: 'desc' }, skip, take, include: { events: { orderBy: { eventTime: 'desc' }, take: 10 } } }), this.prisma.shipment.count({ where: { ...where, isDeleted: false } })]); }
  dueShipments() { return this.prisma.shipment.findMany({ where: { active: true, isDeleted: false, OR: [{ retryAt: null }, { retryAt: { lte: new Date() } }] }, orderBy: { updatedAt: 'asc' }, take: 50 }); }
  findShipment(carrierCode: string | null, clientCode: string | null, provider: string, environment: string) { return this.prisma.shipment.findFirst({ where: { provider, environment, OR: [...(carrierCode ? [{ carrierOrderCode: carrierCode }] : []), ...(clientCode ? [{ clientOrderCode: clientCode }] : [])] } }); }
  eventUpsert(data: Prisma.ShipmentEventUncheckedCreateInput, tx?: Tx) { return (tx ?? this.prisma).shipmentEvent.upsert({ where: { dedupKey: data.dedupKey }, create: data, update: {} }); }
  eventByDedup(key: string, tx: Tx) { return tx.shipmentEvent.findUnique({ where: { dedupKey: key } }); }
  pendingEvents() { return this.prisma.shipmentEvent.findMany({ where: { status: { in: ['pending', 'failed', 'pending_verify', 'processing'] }, OR: [{ retryAt: null }, { retryAt: { lte: new Date() } }], AND: [{ OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] }] }, orderBy: { createdAt: 'asc' }, take: 50 }); }
  claimEvent(id: string, token: string) { return this.prisma.shipmentEvent.updateMany({ where: { id, status: { not: 'processed' }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] }, data: { status: 'processing', leaseToken: token, leaseUntil: new Date(Date.now() + 60_000) } }); }
  eventUpdate(id: string, data: Prisma.ShipmentEventUncheckedUpdateInput, tx?: Tx) { return (tx ?? this.prisma).shipmentEvent.update({ where: { id }, data }); }
  async eventForUpdate(id: string, tx: Tx) { await tx.$queryRaw`SELECT id FROM shipping.shipment_events WHERE id=${id}::uuid FOR UPDATE`; return tx.shipmentEvent.findUnique({ where: { id } }); }
  fakeCreate(data: Prisma.FakeCarrierStateUncheckedCreateInput) { return this.prisma.fakeCarrierState.upsert({ where: { clientOrderCode: data.clientOrderCode }, create: data, update: {} }); }
  fakeByClient(code: string) { return this.prisma.fakeCarrierState.findUnique({ where: { clientOrderCode: code } }); }
  fakeByCarrier(code: string) { return this.prisma.fakeCarrierState.findUnique({ where: { carrierOrderCode: code } }); }
  fakeUpdate(id: string, data: Prisma.FakeCarrierStateUncheckedUpdateInput) { return this.prisma.fakeCarrierState.update({ where: { id }, data }); }
}
