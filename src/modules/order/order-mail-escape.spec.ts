import { Logger } from '@nestjs/common';
import type { Env } from '@config/env';
import type { UserDirectoryGateway } from '@common/gateway/user-directory.gateway';
import type { MailMessage, MailService } from '@common/mail/mail.service';
import type { OutboxEventMessage } from '@common/outbox/outbox';
import type { PrismaService } from '@common/prisma/prisma.service';
import { OrderMailListeners } from './order-worker.module';
import type { OrderOutboxService } from './outbox/order-outbox.service';
import type { OrderQueryApi } from './queryapi/order.queryapi';

/*
 * AUD-11c / NTF-04 — email đơn của khách KHÔNG được để lọt HTML thô do người dùng nhập (lý do huỷ, tên, tên sản phẩm, màu/size).
 * Dùng chuỗi tấn công kinh điển và khẳng định: thân thư không chứa thẻ <script>/<img> thô, dấu nháy kép bị thoát (không thoát được thuộc tính).
 */

const XSS_TAG = '<script>alert(1)</script>';
const XSS_ATTR = '"onerror=alert(1) x="';
const AMP = 'A&B';

function event(eventType: string, payload: Record<string, unknown>): OutboxEventMessage {
  return { id: 'evt-1', module: 'order', eventType, eventVersion: 'v1', aggregateType: 'order', aggregateId: 'o1', payload: { orderCode: 'DH261001', userId: 'u1', ...payload }, requestId: null, createdAt: new Date().toISOString() };
}

function build(overrides: { fullName?: string; items?: Array<{ name: string; color: string; size: string; quantity: number }> } = {}) {
  const sent: MailMessage[] = [];
  const mail = { enqueue: jest.fn((m: MailMessage) => { sent.push(m); return Promise.resolve(); }) };
  const prisma = { $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn({})) };
  const outbox = { markProcessed: jest.fn(() => Promise.resolve(true)) };
  const orders = { findByCodeForUser: jest.fn(() => Promise.resolve({ code: 'DH261001', status: 'pending', paymentStatus: 'unpaid', total: '430000', items: overrides.items ?? [{ name: 'Áo thun', color: 'Đen', size: 'M', quantity: 1 }] })) };
  const users = { findSnapshot: jest.fn(() => Promise.resolve({ id: 'u1', email: 'khach@x.vn', fullName: overrides.fullName ?? 'Khách An' })) };
  const env = { EF_WEB_URL: 'https://fitly.vn/', EF_APP_NAME: 'FITLY' } as unknown as Env;
  const listeners = new OrderMailListeners(prisma as unknown as PrismaService, outbox as unknown as OrderOutboxService, mail as unknown as MailService, orders as unknown as OrderQueryApi, users as unknown as UserDirectoryGateway, env);
  return { listeners, sent };
}

/* Thân thư không còn thẻ nào ngoài tập thẻ do template sinh ra (p, b, ul, li, a) và không có `<script`/`onerror=` đi kèm dấu nháy thô. */
function expectNoRawHtml(html: string): void {
  expect(html).not.toContain('<script');
  expect(html).not.toContain('<img');
  const tags = [...html.matchAll(/<\/?([a-z0-9]+)/gi)].map((m) => m[1].toLowerCase());
  expect(tags.filter((t) => !['p', 'b', 'ul', 'li', 'a', 'br'].includes(t))).toEqual([]);
}

describe('OrderMailListeners — escape HTML (AUD-11c)', () => {
  beforeEach(() => { jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined); });
  afterEach(() => jest.restoreAllMocks());

  it('[NTF-04] email huỷ: lý do chứa <script> / "onerror= / & không lọt HTML thô', async () => {
    const { listeners, sent } = build();
    await listeners.onCancelled(event('ORDER_CANCELLED', { reason: `${XSS_TAG} ${XSS_ATTR} ${AMP}` }));
    expect(sent).toHaveLength(1);
    const html = sent[0].html;
    expectNoRawHtml(html);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;onerror=alert(1) x=&quot;');
    expect(html).toContain('A&amp;B');
  });

  it('[NTF-04] tên khách trong lời chào được escape', async () => {
    const { listeners, sent } = build({ fullName: `<img src=x onerror=alert(1)>${AMP}` });
    await listeners.onPaid(event('ORDER_PAID', {}));
    const html = sent[0].html;
    expectNoRawHtml(html);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;A&amp;B');
  });

  it('[NTF-04] tên sản phẩm / màu / size trong danh sách hàng được escape (đơn mới + đã giao)', async () => {
    const items = [{ name: XSS_TAG, color: XSS_ATTR, size: '<b>XL</b>', quantity: 2 }];
    for (const handler of ['onCreated', 'onDelivered'] as const) {
      const { listeners, sent } = build({ items });
      await listeners[handler](event(handler === 'onCreated' ? 'ORDER_CREATED' : 'ORDER_DELIVERED', {}));
      const html = sent[0].html;
      expectNoRawHtml(html);
      expect(html).toContain('&lt;script&gt;');
      expect(html).toContain('&lt;b&gt;XL&lt;/b&gt;');
    }
  });

  it('email chuyển trạng thái: mã trạng thái lạ (ngoài STATUS_LABEL) cũng được escape', async () => {
    const { listeners, sent } = build();
    await listeners.onStatus(event('ORDER_STATUS_CHANGED', { to: '<i>x</i>' }));
    expectNoRawHtml(sent[0].html);
    expect(sent[0].html).toContain('&lt;i&gt;x&lt;/i&gt;');
  });

  it('nội dung bình thường (tiếng Việt, dấu chấm) giữ nguyên, không bị escape thừa', async () => {
    const { listeners, sent } = build();
    await listeners.onCancelled(event('ORDER_CANCELLED', { reason: 'Khách đổi ý, không cần nữa.' }));
    expect(sent[0].html).toContain('Lý do: Khách đổi ý, không cần nữa.');
    expect(sent[0].html).toContain('<a href="https://fitly.vn/account/orders/DH261001">Xem đơn hàng</a>');
  });
});
