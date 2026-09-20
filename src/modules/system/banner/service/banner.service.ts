import { Injectable } from '@nestjs/common';
import { CacheService } from '@common/cache/cache.service';
import { NotFoundException } from '@common/exception/business.exception';
import { PrismaService } from '@common/prisma/prisma.service';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { StorageService } from '@common/storage/storage.service';
import { SystemAuditLogService } from '../../audit/system-audit-log.service';
import { SYSTEM_AUDIT, SYSTEM_CACHE, SYSTEM_ERR } from '../../foundation/system.constants';

export interface BannerResponse {
  id: string;
  title: string;
  subtitle: string | null;
  imageUrl: string;
  linkUrl: string | null;
  position: string;
  sortOrder: number;
  isActive: boolean;
  startsAt: string | null;
  endsAt: string | null;
}

export interface BannerInput {
  title?: string;
  subtitle?: string | null;
  linkUrl?: string | null;
  position?: string;
  sortOrder?: number;
  isActive?: boolean;
  startsAt?: string | null;
  endsAt?: string | null;
}

type Row = { id: string; title: string; subtitle: string | null; imageUrl: string; imagePublicId: string | null; linkUrl: string | null; position: string; sortOrder: number; isActive: boolean; startsAt: Date | null; endsAt: Date | null };

/* Banner trang chủ (hero/promo): công khai chỉ banner đang hiệu lực (active + trong khoảng ngày), cache 5'; ảnh Cloudinary. */
@Injectable()
export class BannerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly storage: StorageService,
    private readonly audit: SystemAuditLogService,
  ) {}

  private static toResponse(b: Row): BannerResponse {
    return { id: b.id, title: b.title, subtitle: b.subtitle, imageUrl: b.imageUrl, linkUrl: b.linkUrl, position: b.position, sortOrder: b.sortOrder, isActive: b.isActive, startsAt: b.startsAt?.toISOString() ?? null, endsAt: b.endsAt?.toISOString() ?? null };
  }

  async listPublic(position?: string): Promise<BannerResponse[]> {
    const all = await this.cache.getOrSet<BannerResponse[]>(SYSTEM_CACHE.banners, 'active', async () => {
      const now = new Date();
      const rows = await this.prisma.banner.findMany({
        where: { isDeleted: false, isActive: true, OR: [{ startsAt: null }, { startsAt: { lte: now } }], AND: [{ OR: [{ endsAt: null }, { endsAt: { gte: now } }] }] },
        orderBy: [{ position: 'asc' }, { sortOrder: 'asc' }],
      });
      return rows.map((b) => BannerService.toResponse(b));
    });
    return position ? all.filter((b) => b.position === position) : all;
  }

  async listAdmin(): Promise<BannerResponse[]> {
    return (await this.prisma.banner.findMany({ where: { isDeleted: false }, orderBy: [{ position: 'asc' }, { sortOrder: 'asc' }] })).map((b) => BannerService.toResponse(b));
  }

  async create(actor: AuthenticatedActor, input: BannerInput & { title: string }, file: { buffer: Buffer; mimetype: string; size: number }): Promise<BannerResponse> {
    const uploaded = await this.storage.uploadImage(file, 'banners');
    const created = await this.prisma.$transaction(async (tx) => {
      const b = await tx.banner.create({
        data: {
          title: input.title.trim(),
          subtitle: input.subtitle ?? null,
          imageUrl: uploaded.url,
          imagePublicId: uploaded.publicId,
          linkUrl: input.linkUrl ?? null,
          position: input.position ?? 'hero',
          sortOrder: input.sortOrder ?? 0,
          isActive: input.isActive ?? true,
          startsAt: input.startsAt ? new Date(input.startsAt) : null,
          endsAt: input.endsAt ? new Date(input.endsAt) : null,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        },
      });
      await this.audit.write(tx, actor, { action: SYSTEM_AUDIT.BANNER_CREATED, entityType: 'banner', entityId: b.id, after: { title: b.title, position: b.position } });
      return b;
    });
    await this.cache.delByPrefix(SYSTEM_CACHE.banners);
    return BannerService.toResponse(created);
  }

  async update(actor: AuthenticatedActor, id: string, patch: BannerInput, file?: { buffer: Buffer; mimetype: string; size: number }): Promise<BannerResponse> {
    const before = await this.prisma.banner.findFirst({ where: { id, isDeleted: false } });
    if (!before) throw new NotFoundException(SYSTEM_ERR.BANNER_NOT_FOUND, 'Không tìm thấy banner');
    const uploaded = file ? await this.storage.uploadImage(file, 'banners') : null;
    const after = await this.prisma.$transaction(async (tx) => {
      const b = await tx.banner.update({
        where: { id },
        data: {
          ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
          ...(patch.subtitle !== undefined ? { subtitle: patch.subtitle } : {}),
          ...(patch.linkUrl !== undefined ? { linkUrl: patch.linkUrl } : {}),
          ...(patch.position !== undefined ? { position: patch.position } : {}),
          ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
          ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
          ...(patch.startsAt !== undefined ? { startsAt: patch.startsAt ? new Date(patch.startsAt) : null } : {}),
          ...(patch.endsAt !== undefined ? { endsAt: patch.endsAt ? new Date(patch.endsAt) : null } : {}),
          ...(uploaded ? { imageUrl: uploaded.url, imagePublicId: uploaded.publicId } : {}),
          updatedBy: actor.userId,
          version: { increment: 1 },
        },
      });
      await this.audit.write(tx, actor, { action: SYSTEM_AUDIT.BANNER_UPDATED, entityType: 'banner', entityId: id, before: { title: before.title, isActive: before.isActive }, after: { title: b.title, isActive: b.isActive, image: Boolean(uploaded) } });
      return b;
    });
    if (uploaded && before.imagePublicId && before.imagePublicId !== uploaded.publicId) await this.storage.deleteImage(before.imagePublicId);
    await this.cache.delByPrefix(SYSTEM_CACHE.banners);
    return BannerService.toResponse(after);
  }

  async remove(actor: AuthenticatedActor, id: string): Promise<void> {
    const before = await this.prisma.banner.findFirst({ where: { id, isDeleted: false } });
    if (!before) throw new NotFoundException(SYSTEM_ERR.BANNER_NOT_FOUND, 'Không tìm thấy banner');
    await this.prisma.$transaction(async (tx) => {
      await tx.banner.update({ where: { id }, data: { isDeleted: true, isActive: false, updatedBy: actor.userId } });
      await this.audit.write(tx, actor, { action: SYSTEM_AUDIT.BANNER_DELETED, entityType: 'banner', entityId: id, before: { title: before.title } });
    });
    await this.cache.delByPrefix(SYSTEM_CACHE.banners);
  }
}
