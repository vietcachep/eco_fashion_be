import type { Tx } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import type { ShippingOrderSnapshot, CarrierOrderUpdate } from '@common/gateway/order-shipping.gateway';
import { OrderService } from '../order/service/order.service';
import type { OrderRow } from '../order/repository/order.repository';

const actor: AuthenticatedActor = { userId: 'staff', email: 'staff@example.test', roleCode: 'admin', permissionVersion: 1, tokenId: 'test' };
function fixture() {
  const row = { id: 'order', code: 'DH-TEST', shopId: 'shop', userId: 'customer', fulfilmentMode: 'carrier', status: 'shipping', paymentStatus: 'unpaid', paymentMethodCode: 'cod', collectionMode: 'carrier_cod' } as OrderRow;
  const repo = { findByCode: jest.fn(() => Promise.resolve(row)), findByCodeForUpdate: jest.fn(() => Promise.resolve(row)), hasOpenReturn: jest.fn(() => Promise.resolve(false)), update: jest.fn(() => Promise.resolve()), addHistory: jest.fn(() => Promise.resolve()) };
  const tx = {} as Tx;
  const prisma = { $transaction: <T>(fn: (transaction: Tx) => Promise<T>) => fn(tx) };
  const audit = { write: jest.fn(() => Promise.resolve()) };
  const notify = { notify: jest.fn(() => Promise.resolve()), notifyMany: jest.fn(() => Promise.resolve()) };
  const commands = { cancel: jest.fn(() => Promise.resolve()), barrier: jest.fn(() => Promise.resolve(null)) };
  const queries = { latest: jest.fn(() => Promise.resolve({ active: true, status: 'awaiting_pickup' })) };
  const users = { staffUserIdsWithPermission: jest.fn(() => Promise.resolve(['cskh'])) };
  const args = [prisma, repo, audit, {}, {}, {}, { settingNumber: () => Promise.resolve(48) }, {}, {}, {}, {}, {}, {}, notify, {}, users, undefined, commands, queries] as unknown as ConstructorParameters<typeof OrderService>;
  const service = new OrderService(...args);
  const cancel = jest.spyOn(service, 'doCancel').mockResolvedValue();
  return { row, repo, tx, notify, commands, service, cancel };
}
const update: CarrierOrderUpdate = { status: 'cancelled', cancelRequested: true, shipmentId: 'shipment', carrierOrderCode: 'GHN-TEST', trackingUrl: '', eventTime: new Date() };

describe('PLAN-0043 order ↔ carrier safety', () => {
  it('shop nhập lý do quá ngắn không được phát lệnh huỷ hãng trước khi báo lỗi', async () => {
    const f = fixture();
    await expect(f.service.cancelByShop(actor, 'shop', 'DH-TEST', { reason: 'a' })).rejects.toMatchObject({ errorCode: 'COMMON_VALIDATION_ERROR' });
    expect(f.commands.cancel).not.toHaveBeenCalled();
  });
  it('sàn không phát lệnh huỷ hãng khi đơn đã có tranh chấp mở', async () => {
    const f = fixture(); f.repo.hasOpenReturn.mockResolvedValue(true);
    await expect(f.service.cancelByStaff(actor, 'DH-TEST', 'Huỷ do tranh chấp đang mở')).rejects.toMatchObject({ errorCode: 'ORDER_HAS_OPEN_RETURN' });
    expect(f.commands.cancel).not.toHaveBeenCalled();
  });
  it('return mở giữa preflight và hãng xác nhận huỷ giữ event để xử lý, không hoàn/nhập kho', async () => {
    const f = fixture(); f.repo.hasOpenReturn.mockResolvedValue(true);
    await expect(f.service.applyCarrierUpdate(f.row as unknown as ShippingOrderSnapshot, update, f.tx)).rejects.toMatchObject({ errorCode: 'ORDER_HAS_OPEN_RETURN' });
    expect(f.cancel).not.toHaveBeenCalled();
  });
  it('huỷ đã xác minh và không tranh chấp mới được gọi luồng huỷ kho/tiền', async () => {
    const f = fixture();
    await f.service.applyCarrierUpdate(f.row as unknown as ShippingOrderSnapshot, update, f.tx);
    expect(f.cancel).toHaveBeenCalledTimes(1);
  });
  it('trạng thái hãng lost không tạo thông báo lần hai ngoài recordShippingAction', async () => {
    const f = fixture();
    await f.service.applyCarrierUpdate(f.row as unknown as ShippingOrderSnapshot, { ...update, status: 'lost', cancelRequested: false }, f.tx);
    expect(f.notify.notifyMany).not.toHaveBeenCalled();
  });
});
