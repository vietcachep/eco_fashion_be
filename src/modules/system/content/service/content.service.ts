import { Injectable } from '@nestjs/common';
import { CacheService } from '@common/cache/cache.service';
import { BusinessException, ForbiddenException, NotFoundException } from '@common/exception/business.exception';
import { MailService } from '@common/mail/mail.service';
import { PrismaService } from '@common/prisma/prisma.service';
import { RequestTraceContext } from '@common/request/request-trace.context';
import { PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { ShopQueryApi } from '../../../shop/queryapi/shop.queryapi';
import { SystemAuditLogService } from '../../audit/system-audit-log.service';
import { CONTACT_SHOP_OVERDUE_HOURS, SETTING_KEY, SYSTEM_AUDIT, SYSTEM_CACHE, SYSTEM_ERR } from '../../foundation/system.constants';
import { SettingService } from '../../setting/service/setting.service';

export interface FaqResponse {
  id: string;
  question: string;
  answer: string;
  groupCode: string;
  sortOrder: number;
  isActive: boolean;
}

export interface PageResponseDto {
  slug: string;
  title: string;
  content: string;
  updatedAt: string;
}

export interface ContactResponse {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  message: string;
  /** Gửi cho gian hàng nào (null = gửi sàn) */
  shopId: string | null;
  shopName: string | null;
  orderCode: string | null;
  productName: string | null;
  status: string;
  reply: string | null;
  handledAt: string | null;
  createdAt: string;
  /** Phía sàn: có được trả lời không (tin gửi sàn, hoặc tin shop quá hạn chưa xử lý) */
  platformCanReply: boolean;
}

/* Nội dung tĩnh (FAQ, trang chính sách — cache 10') + hộp thư liên hệ (khách gửi công khai, nhân viên trả lời qua email). */
@Injectable()
export class ContentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly audit: SystemAuditLogService,
    private readonly mail: MailService,
    private readonly settings: SettingService,
    private readonly shops: ShopQueryApi,
  ) {}

  // ------------------------------------------------------------ FAQ

  async faqsPublic(): Promise<FaqResponse[]> {
    return this.cache.getOrSet(SYSTEM_CACHE.faqs, 'active', async () =>
      (await this.prisma.faq.findMany({ where: { isDeleted: false, isActive: true }, orderBy: [{ groupCode: 'asc' }, { sortOrder: 'asc' }] })).map((f) => ({ id: f.id, question: f.question, answer: f.answer, groupCode: f.groupCode, sortOrder: f.sortOrder, isActive: f.isActive })),
    );
  }

  async faqsAdmin(): Promise<FaqResponse[]> {
    return (await this.prisma.faq.findMany({ where: { isDeleted: false }, orderBy: [{ groupCode: 'asc' }, { sortOrder: 'asc' }] })).map((f) => ({ id: f.id, question: f.question, answer: f.answer, groupCode: f.groupCode, sortOrder: f.sortOrder, isActive: f.isActive }));
  }

  async saveFaq(actor: AuthenticatedActor, id: string | null, input: { question: string; answer: string; groupCode?: string; sortOrder?: number; isActive?: boolean }): Promise<FaqResponse> {
    const saved = await this.prisma.$transaction(async (tx) => {
      const data = { question: input.question.trim(), answer: input.answer.trim(), groupCode: input.groupCode ?? 'general', sortOrder: input.sortOrder ?? 0, isActive: input.isActive ?? true, updatedBy: actor.userId };
      const f = id
        ? await tx.faq.update({ where: { id }, data: { ...data, version: { increment: 1 } } })
        : await tx.faq.create({ data: { ...data, createdBy: actor.userId } });
      await this.audit.write(tx, actor, { action: SYSTEM_AUDIT.FAQ_SAVED, entityType: 'faq', entityId: f.id, after: { question: f.question } });
      return f;
    });
    await this.cache.delByPrefix(SYSTEM_CACHE.faqs);
    return { id: saved.id, question: saved.question, answer: saved.answer, groupCode: saved.groupCode, sortOrder: saved.sortOrder, isActive: saved.isActive };
  }

  async deleteFaq(actor: AuthenticatedActor, id: string): Promise<void> {
    const r = await this.prisma.faq.updateMany({ where: { id, isDeleted: false }, data: { isDeleted: true, isActive: false, updatedBy: actor.userId } });
    if (r.count === 0) throw new NotFoundException(SYSTEM_ERR.FAQ_NOT_FOUND, 'Không tìm thấy câu hỏi');
    await this.audit.write(null, actor, { action: SYSTEM_AUDIT.FAQ_DELETED, entityType: 'faq', entityId: id });
    await this.cache.delByPrefix(SYSTEM_CACHE.faqs);
  }

  // ------------------------------------------------------------ pages

  async page(slug: string): Promise<PageResponseDto> {
    const p = await this.cache.getOrSet<PageResponseDto | { missing: true }>(SYSTEM_CACHE.pages, slug, async () => {
      const row = await this.prisma.page.findFirst({ where: { slug, isActive: true } });
      return row ? { slug: row.slug, title: row.title, content: row.content, updatedAt: row.updatedAt.toISOString() } : { missing: true };
    });
    if ('missing' in p) throw new NotFoundException(SYSTEM_ERR.PAGE_NOT_FOUND, 'Không tìm thấy trang');
    return p;
  }

  async pagesAdmin(): Promise<PageResponseDto[]> {
    return (await this.prisma.page.findMany({ orderBy: { slug: 'asc' } })).map((r) => ({ slug: r.slug, title: r.title, content: r.content, updatedAt: r.updatedAt.toISOString() }));
  }

  async savePage(actor: AuthenticatedActor, slug: string, input: { title: string; content: string; isActive?: boolean }): Promise<PageResponseDto> {
    const saved = await this.prisma.$transaction(async (tx) => {
      const p = await tx.page.upsert({
        where: { slug },
        create: { slug, title: input.title.trim(), content: input.content, isActive: input.isActive ?? true, updatedBy: actor.userId },
        update: { title: input.title.trim(), content: input.content, ...(input.isActive !== undefined ? { isActive: input.isActive } : {}), updatedBy: actor.userId, version: { increment: 1 } },
      });
      await this.audit.write(tx, actor, { action: SYSTEM_AUDIT.PAGE_SAVED, entityType: 'page', entityCode: slug, after: { title: p.title, length: p.content.length } });
      return p;
    });
    await this.cache.del(SYSTEM_CACHE.pages, slug);
    return { slug: saved.slug, title: saved.title, content: saved.content, updatedAt: saved.updatedAt.toISOString() };
  }

  // ------------------------------------------------------------ contact

  async submitContact(input: { name: string; email: string; phone: string | null; message: string; shopId?: string | null; shopSlug?: string | null; orderCode?: string | null; productName?: string | null }): Promise<{ id: string }> {
    if (input.shopSlug && !input.shopId) {
      input.shopId = (await this.shops.findPublicBySlug(input.shopSlug))?.id ?? null;
      if (!input.shopId) throw new BusinessException(SYSTEM_ERR.CONTACT_SHOP_INVALID, 'Gian hàng không tồn tại hoặc hiện không nhận liên hệ');
    }
    // Gửi cho shop: shop phải đang bán (đã duyệt) — không nhận tin cho shop không tồn tại / bị khoá.
    if (input.shopId && !(await this.shops.existsApproved(input.shopId))) throw new BusinessException(SYSTEM_ERR.CONTACT_SHOP_INVALID, 'Gian hàng không tồn tại hoặc hiện không nhận liên hệ');
    const trace = RequestTraceContext.current();
    const c = await this.prisma.contactMessage.create({
      data: { name: input.name, email: input.email, phone: input.phone, message: input.message, shopId: input.shopId ?? null, orderCode: input.orderCode?.trim() || null, productName: input.productName?.trim() || null, ipAddress: trace?.ip || null },
      select: { id: true },
    });
    return c;
  }

  /*
   * SÀN: mặc định chỉ tin gửi SÀN; scope=shops = tin gửi các gian hàng (giám sát, không trả lời thay — trừ tin shop để quá CONTACT_SHOP_OVERDUE_HOURS giờ chưa xử lý).
   * VENDOR: truyền `shopId` của ngữ cảnh ⇒ chỉ tin của CHÍNH shop mình.
   */
  async listContacts(page: number, size: number, f: { status?: string; scope?: string; shopId?: string } = {}, vendorShopId?: string): Promise<PageResponse<ContactResponse>> {
    const shopFilter = vendorShopId ? { shopId: vendorShopId } : f.shopId ? { shopId: f.shopId } : f.scope === 'shops' ? { shopId: { not: null } } : { shopId: null };
    const where = { ...(f.status ? { status: f.status } : {}), ...shopFilter };
    const [items, total] = await Promise.all([
      this.prisma.contactMessage.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * size, take: size }),
      this.prisma.contactMessage.count({ where }),
    ]);
    const names = await this.shops.findManyBrief(items.flatMap((c) => (c.shopId ? [c.shopId] : [])));
    return PageResponse.of(items.map((c) => ContentService.toContact(c, c.shopId ? names.get(c.shopId)?.name : undefined)), page, size, total);
  }

  /*
   * Trả lời: gửi email cho khách (hàng đợi), đánh dấu handled + audit.
   * `vendorShopId` có giá trị = shop trả lời tin của CHÍNH mình (tin shop khác / tin gửi sàn → 404, không lộ sự tồn tại).
   * Không có = SÀN: chỉ trả lời tin gửi sàn, hoặc tin gửi shop mà shop để quá hạn chưa xử lý; còn lại 403 SYSTEM_CONTACT_SHOP_OWNED.
   */
  async replyContact(actor: AuthenticatedActor, id: string, reply: string, vendorShopId?: string): Promise<ContactResponse> {
    const c = await this.prisma.contactMessage.findUnique({ where: { id } });
    if (!c || (vendorShopId && c.shopId !== vendorShopId)) throw new NotFoundException(SYSTEM_ERR.CONTACT_NOT_FOUND, 'Không tìm thấy liên hệ');
    if (!vendorShopId && !ContentService.platformMayReply(c)) throw new ForbiddenException(SYSTEM_ERR.CONTACT_SHOP_OWNED, 'Tin này gửi cho gian hàng — gian hàng tự trả lời (sàn chỉ vào cuộc khi shop để quá 48 giờ)');
    const brand = c.shopId ? ((await this.shops.findBrief(c.shopId))?.name ?? 'Gian hàng') : await this.settings.get<string>(SETTING_KEY.SHOP_NAME);
    const after = await this.prisma.$transaction(async (tx) => {
      const r = await tx.contactMessage.update({ where: { id }, data: { status: 'handled', reply, handledBy: actor.userId, handledAt: new Date() } });
      await this.audit.write(tx, actor, { action: SYSTEM_AUDIT.CONTACT_HANDLED, entityType: 'contact_message', entityId: id, entityCode: c.email, after: { replyLength: reply.length, shopId: c.shopId } });
      return r;
    });
    await this.mail.enqueue({ to: c.email, subject: `${brand} — Phản hồi liên hệ của bạn`, html: `<p>Xin chào ${c.name},</p><p>${reply.replace(/\n/g, '<br>')}</p><p>— ${brand}</p>` });
    return ContentService.toContact(after, c.shopId ? brand : undefined);
  }

  /* Sàn được trả lời: tin gửi sàn, hoặc tin gửi shop chưa xử lý quá hạn. */
  private static platformMayReply(c: { shopId: string | null; status: string; createdAt: Date }): boolean {
    if (!c.shopId) return true;
    return c.status === 'new' && Date.now() - c.createdAt.getTime() > CONTACT_SHOP_OVERDUE_HOURS * 3_600_000;
  }

  private static toContact(c: { id: string; name: string; email: string; phone: string | null; message: string; shopId: string | null; orderCode: string | null; productName: string | null; status: string; reply: string | null; handledAt: Date | null; createdAt: Date }, shopName?: string): ContactResponse {
    return { id: c.id, name: c.name, email: c.email, phone: c.phone, message: c.message, shopId: c.shopId, shopName: shopName ?? null, orderCode: c.orderCode, productName: c.productName, status: c.status, reply: c.reply, handledAt: c.handledAt?.toISOString() ?? null, createdAt: c.createdAt.toISOString(), platformCanReply: ContentService.platformMayReply(c) };
  }
}
