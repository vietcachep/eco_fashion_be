import { Logger } from '@nestjs/common';
import type { Env } from '@config/env';
import type { MailMessage, MailService } from '@common/mail/mail.service';
import type { OutboxEventMessage } from '@common/outbox/outbox';
import type { PrismaService } from '@common/prisma/prisma.service';
import { IdentityEventListeners } from './identity-worker.module';
import type { IdentityOutboxService } from './outbox/identity-outbox.service';

/* AUD-11c / NTF-04 — mail chào mừng + mail khoá tài khoản chứa tên/lý do do người dùng/nhân viên nhập ⇒ phải escape. */

function event(eventType: string, payload: Record<string, unknown>): OutboxEventMessage {
  return { id: 'evt-1', module: 'identity', eventType, eventVersion: 'v1', aggregateType: 'user', aggregateId: 'u1', payload, requestId: null, createdAt: new Date().toISOString() };
}

function build() {
  const sent: MailMessage[] = [];
  const mail = { enqueue: jest.fn((m: MailMessage) => { sent.push(m); return Promise.resolve(); }) };
  const prisma = { $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn({})) };
  const outbox = { markProcessed: jest.fn(() => Promise.resolve(true)) };
  const env = { EF_APP_NAME: 'FITLY & Co' } as unknown as Env;
  const listeners = new IdentityEventListeners(prisma as unknown as PrismaService, outbox as unknown as IdentityOutboxService, mail as unknown as MailService, env);
  return { listeners, sent };
}

describe('IdentityEventListeners — escape HTML (AUD-11c)', () => {
  beforeEach(() => { jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined); });
  afterEach(() => jest.restoreAllMocks());

  it('[NTF-04] mail chào mừng: họ tên chứa <script> không lọt HTML thô; tên ứng dụng cũng được escape', async () => {
    const { listeners, sent } = build();
    await listeners.onUserRegistered(event('USER_REGISTERED', { email: 'a@x.vn', fullName: '<script>alert(1)</script>"onerror=' }));
    const html = sent[0].html;
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&quot;onerror=');
    expect(html).toContain('FITLY &amp; Co');
  });

  it('[NTF-04] mail khoá tài khoản: lý do của nhân viên được escape', async () => {
    const { listeners, sent } = build();
    await listeners.onUserLocked(event('USER_LOCKED', { email: 'a@x.vn', reason: '<img src=x onerror=alert(1)> vi phạm & spam' }));
    const html = sent[0].html;
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; vi phạm &amp; spam');
  });

  it('khoá không kèm lý do ⇒ không có đoạn "với lý do"', async () => {
    const { listeners, sent } = build();
    await listeners.onUserLocked(event('USER_LOCKED', { email: 'a@x.vn', reason: null }));
    expect(sent[0].html).not.toContain('lý do');
  });
});
