import { Injectable } from '@nestjs/common';
import { CacheService } from '@common/cache/cache.service';
import { NotFoundException } from '@common/exception/business.exception';
import { PrismaService } from '@common/prisma/prisma.service';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CatalogAuditLogService } from '../../audit/catalog-audit-log.service';
import { CATALOG_AUDIT, CATALOG_CACHE, CATALOG_ERR } from '../../foundation/catalog.constants';
import { AttributeResponse } from '../dto/attribute.responses';
import { AttributeRepository, AttributeRow } from '../repository/attribute.repository';

/*
 * Thuộc tính màu/size/chất liệu: 3 thuộc tính hệ thống do seed tạo (không tạo/xoá thuộc tính qua API — chỉ thêm/sửa/ẩn giá trị).
 * Đọc: cache 10' (bộ lọc, form quản trị sản phẩm). Giá trị xoá mềm; biến thể đang dùng mã đó vẫn giữ tên/hex snapshot của mình.
 */
@Injectable()
export class AttributeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: AttributeRepository,
    private readonly cache: CacheService,
    private readonly audit: CatalogAuditLogService,
  ) {}

  static toResponse(a: AttributeRow): AttributeResponse {
    return { code: a.code, name: a.name, kind: a.kind, isFilterable: a.isFilterable, values: a.values.map((v) => ({ code: v.code, name: v.name, hex: v.hex, groupCode: v.groupCode, sortOrder: v.sortOrder, isActive: v.isActive })) };
  }

  async listAll(): Promise<AttributeResponse[]> {
    return this.cache.getOrSet(CATALOG_CACHE.attributes, 'all', async () => (await this.repo.listAll()).map((a) => AttributeService.toResponse(a)));
  }

  async get(code: string): Promise<AttributeResponse> {
    const a = await this.repo.findByCode(code);
    if (!a) throw new NotFoundException(CATALOG_ERR.ATTRIBUTE_NOT_FOUND, `Không có thuộc tính '${code}'`);
    return AttributeService.toResponse(a);
  }

  async saveValue(actor: AuthenticatedActor, attributeCode: string, v: { code: string; name: string; hex?: string | null; groupCode?: string | null; sortOrder?: number; isActive?: boolean }): Promise<AttributeResponse> {
    const a = await this.repo.findByCode(attributeCode);
    if (!a) throw new NotFoundException(CATALOG_ERR.ATTRIBUTE_NOT_FOUND, `Không có thuộc tính '${attributeCode}'`);
    await this.prisma.$transaction(async (tx) => {
      const before = a.values.find((x) => x.code === v.code) ?? null;
      const saved = await this.repo.upsertValue(a.id, { ...v, name: v.name.trim() }, actor.userId, tx);
      await this.audit.write(tx, actor, { action: CATALOG_AUDIT.ATTRIBUTE_VALUE_SAVED, entityType: 'attribute_value', entityId: saved.id, entityCode: `${attributeCode}.${v.code}`, before: before ? { name: before.name, hex: before.hex, isActive: before.isActive } : null, after: { name: saved.name, hex: saved.hex, isActive: saved.isActive } });
    });
    await this.cache.delByPrefix(CATALOG_CACHE.attributes);
    return this.get(attributeCode);
  }

  async deleteValue(actor: AuthenticatedActor, attributeCode: string, code: string): Promise<void> {
    const a = await this.repo.findByCode(attributeCode);
    if (!a) throw new NotFoundException(CATALOG_ERR.ATTRIBUTE_NOT_FOUND, `Không có thuộc tính '${attributeCode}'`);
    await this.prisma.$transaction(async (tx) => {
      const n = await this.repo.softDeleteValue(a.id, code, actor.userId, tx);
      if (n === 0) throw new NotFoundException(CATALOG_ERR.ATTRIBUTE_VALUE_NOT_FOUND, `Không có giá trị '${code}'`);
      await this.audit.write(tx, actor, { action: CATALOG_AUDIT.ATTRIBUTE_VALUE_DELETED, entityType: 'attribute_value', entityCode: `${attributeCode}.${code}` });
    });
    await this.cache.delByPrefix(CATALOG_CACHE.attributes);
  }
}
