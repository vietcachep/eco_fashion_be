import type { CacheService } from '@common/cache/cache.service';
import type { MailService } from '@common/mail/mail.service';
import type { PrismaService } from '@common/prisma/prisma.service';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import type { ShopQueryApi } from '../../../shop/queryapi/shop.queryapi';
import type { SystemAuditLogService } from '../../audit/system-audit-log.service';
import { SYSTEM_ERR } from '../../foundation/system.constants';
import type { SettingService } from '../../setting/service/setting.service';
import { ContentService } from './content.service';

/* Liên hệ khách → SÀN hay SHOP (PLAN-0021): shop trả lời tin của mình, sàn chỉ trả lời tin gửi sàn hoặc tin shop để quá hạn. */

const SHOP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const actor: AuthenticatedActor = { userId: 'u1', email: 'u@x.vn', roleCode: 'sales', permissionVersion: 1, tokenId: 'j' };
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

function build(row: Partial<{ shopId: string | null; status: string; createdAt: Date }>) {
  const contact = { id: 'c1', name: 'An', email: 'an@x.vn', phone: null, message: 'hỏi size', shopId: null, orderCode: null, productName: null, status: 'new', reply: null, handledAt: null, createdAt: hoursAgo(1), ...row };
  const tx = { contactMessage: { update: jest.fn(({ data }: { data: object }) => Promise.resolve({ ...contact, ...data })) } };
  const prisma = {
    contactMessage: { findUnique: jest.fn(() => Promise.resolve(contact)), create: jest.fn((a: { data: object }) => Promise.resolve({ id: 'new', ...a.data })) },
    $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const shops = { existsApproved: jest.fn((id: string) => Promise.resolve(id === SHOP)), findBrief: jest.fn(() => Promise.resolve({ name: 'Shop A' })), findManyBrief: jest.fn(() => Promise.resolve(new Map())) };
  const mail = { enqueue: jest.fn(() => Promise.resolve()) };
  const service = new ContentService(prisma as unknown as PrismaService, {} as CacheService, { write: jest.fn(() => Promise.resolve()) } as unknown as SystemAuditLogService, mail as unknown as MailService, { get: jest.fn(() => Promise.resolve('FITLY')) } as unknown as SettingService, shops as unknown as ShopQueryApi);
  return { service, prisma, mail };
}

describe('liên hệ khách: gửi sàn / gửi shop', () => {
  it('gửi cho shop không tồn tại hoặc không bán ⇒ từ chối', async () => {
    const { service } = build({});
    await expect(service.submitContact({ name: 'An', email: 'an@x.vn', phone: null, message: 'xin chào shop', shopId: OTHER })).rejects.toMatchObject({ errorCode: SYSTEM_ERR.CONTACT_SHOP_INVALID });
  });

  it('gửi cho shop hợp lệ ⇒ lưu shopId; không có shopId ⇒ gửi sàn (null)', async () => {
    const a = build({});
    await a.service.submitContact({ name: 'An', email: 'an@x.vn', phone: null, message: 'còn size XXL không', shopId: SHOP, productName: 'Áo thun' });
    expect((a.prisma.contactMessage.create.mock.calls as unknown as Array<[{ data: { shopId: string | null } }]>)[0][0].data.shopId).toBe(SHOP);
    const b = build({});
    await b.service.submitContact({ name: 'An', email: 'an@x.vn', phone: null, message: 'chính sách đổi trả' });
    expect((b.prisma.contactMessage.create.mock.calls as unknown as Array<[{ data: { shopId: string | null } }]>)[0][0].data.shopId).toBeNull();
  });

  it('sàn trả lời được tin gửi sàn', async () => {
    const { service, mail } = build({ shopId: null });
    const r = await service.replyContact(actor, 'c1', 'Chào anh, chính sách như sau');
    expect(r.status).toBe('handled');
    expect(mail.enqueue).toHaveBeenCalledTimes(1);
  });

  it('sàn KHÔNG trả lời thay shop khi tin còn mới', async () => {
    const { service } = build({ shopId: SHOP, createdAt: hoursAgo(5) });
    await expect(service.replyContact(actor, 'c1', 'Em trả lời thay shop nhé')).rejects.toMatchObject({ errorCode: SYSTEM_ERR.CONTACT_SHOP_OWNED });
  });

  it('shop để quá 48 giờ chưa xử lý ⇒ sàn được vào cuộc; đã xử lý rồi thì không', async () => {
    const overdue = build({ shopId: SHOP, createdAt: hoursAgo(50) });
    await expect(overdue.service.replyContact(actor, 'c1', 'Sàn hỗ trợ anh nhé')).resolves.toMatchObject({ status: 'handled' });
    const handled = build({ shopId: SHOP, createdAt: hoursAgo(50), status: 'handled' });
    await expect(handled.service.replyContact(actor, 'c1', 'Sàn hỗ trợ anh nhé')).rejects.toMatchObject({ errorCode: SYSTEM_ERR.CONTACT_SHOP_OWNED });
  });

  it('shop trả lời tin của mình; tin của shop khác hoặc tin gửi sàn ⇒ 404', async () => {
    const mine = build({ shopId: SHOP });
    await expect(mine.service.replyContact(actor, 'c1', 'Shop còn XXL anh nhé', SHOP)).resolves.toMatchObject({ status: 'handled' });
    const other = build({ shopId: OTHER });
    await expect(other.service.replyContact(actor, 'c1', 'Thử trả lời tin shop khác', SHOP)).rejects.toMatchObject({ errorCode: SYSTEM_ERR.CONTACT_NOT_FOUND });
    const platform = build({ shopId: null });
    await expect(platform.service.replyContact(actor, 'c1', 'Thử trả lời tin gửi sàn', SHOP)).rejects.toMatchObject({ errorCode: SYSTEM_ERR.CONTACT_NOT_FOUND });
  });
});
