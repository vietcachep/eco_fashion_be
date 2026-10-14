import { Injectable, Logger } from '@nestjs/common';
import { ConflictException, NotFoundException } from '@common/exception/business.exception';
import { PrismaService } from '@common/prisma/prisma.service';
import { Prisma } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CatalogAuditLogService } from '../../audit/catalog-audit-log.service';
import { CATALOG_AUDIT, CATALOG_ERR } from '../../foundation/catalog.constants';
import { CatalogUsageRegistry } from '../../queryapi/catalog-usage.registry';
import { DynamicAttributeResponse } from '../dto/dynamic-attribute.responses';
import { toDynamicAttributeResponse } from '../mapper/dynamic-attribute.mapper';
import { DynamicAttributeRepository } from '../repository/dynamic-attribute.repository';
import type { CreateDynamicAttributeRequest, CreateDynamicAttributeValueRequest, UpdateDynamicAttributeValueRequest } from '../request/dynamic-attribute.requests';

/*
 * Thuộc tính động cho ngành hàng ngoài thời trang (PLAN-0016): tạo, sửa, xoá thuộc tính và giá trị.
 * Transaction + audit cho mỗi thao tác ghi. Kiểm code unique DB trước khi tạo.
 * Xoá giá trị: chặn 409 CATALOG_ATTRIBUTE_VALUE_IN_USE khi sản phẩm (thuộc tính cấp sản phẩm) hoặc biến thể (trục) còn dùng —
 * product không có FK sang catalog nên xoá lúc đó sẽ để lại attributeValueId mồ côi. Việc "còn dùng không" do product trả lời
 * qua CatalogUsageRegistry (catalog không được đọc bảng product).
 */
@Injectable()
export class DynamicAttributeService {
  private readonly logger = new Logger(DynamicAttributeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: DynamicAttributeRepository,
    private readonly audit: CatalogAuditLogService,
    private readonly usage: CatalogUsageRegistry,
  ) {}

  async list(): Promise<DynamicAttributeResponse[]> {
    const attrs = await this.repo.list();
    return attrs.map(toDynamicAttributeResponse);
  }

  async getById(id: string): Promise<DynamicAttributeResponse> {
    const attr = await this.repo.findById(id);
    if (!attr) throw new NotFoundException(CATALOG_ERR.DYNAMIC_ATTRIBUTE_NOT_FOUND, 'Không tìm thấy thuộc tính');
    return toDynamicAttributeResponse(attr);
  }

  async create(actor: AuthenticatedActor, input: CreateDynamicAttributeRequest): Promise<DynamicAttributeResponse> {
    const code = input.code.trim(); // kiểm trùng trên chính giá trị sẽ lưu (code unique ở DB)
    const existing = await this.repo.findByCode(code);
    if (existing) throw new ConflictException(CATALOG_ERR.CODE_EXISTS, `Mã '${code}' đã tồn tại`);

    const created = await this.prisma.$transaction(async (tx) => {
      const attr = await this.repo.create(
        {
          code,
          name: input.name.trim(),
          inputType: input.inputType ?? 'select',
        },
        tx,
      );

      await this.audit.write(tx, actor, {
        action: CATALOG_AUDIT.DYNAMIC_ATTRIBUTE_CREATED,
        entityType: 'dynamicAttribute',
        entityId: attr.id,
        entityCode: attr.code,
        after: { code: attr.code, name: attr.name, inputType: attr.inputType },
      });

      return attr;
    });

    return toDynamicAttributeResponse(created);
  }

  async addValue(actor: AuthenticatedActor, attributeId: string, input: CreateDynamicAttributeValueRequest): Promise<DynamicAttributeResponse> {
    const attr = await this.repo.findById(attributeId);
    if (!attr) throw new NotFoundException(CATALOG_ERR.DYNAMIC_ATTRIBUTE_NOT_FOUND, 'Không tìm thấy thuộc tính');

    // Check if value already exists for this attribute
    const existing = attr.values.find((v) => v.value === input.value);
    if (existing) throw new ConflictException(CATALOG_ERR.VALUE_EXISTS, `Giá trị '${input.value}' đã tồn tại cho thuộc tính này`);

    const updated = await this.prisma.$transaction(async (tx) => {
      const createDataObj = {
        attributeId,
        value: input.value.trim(),
        sortOrder: input.sortOrder ?? 0,
      } as Record<string, unknown>;
      if (input.extra !== undefined) {
        // null = không có dữ liệu phụ: cột Json của Prisma không nhận `null` trần (lỗi runtime) — phải dùng DbNull.
        createDataObj.extra = input.extra === null ? Prisma.DbNull : input.extra;
      }
      await this.repo.createValue(createDataObj as Prisma.DynamicAttributeValueUncheckedCreateInput, tx);

      await this.audit.write(tx, actor, {
        action: CATALOG_AUDIT.DYNAMIC_ATTRIBUTE_VALUE_CREATED,
        entityType: 'dynamicAttribute',
        entityId: attributeId,
        entityCode: attr.code,
        after: { value: input.value, sortOrder: input.sortOrder ?? 0 },
      });

      return this.repo.findById(attributeId, tx);
    });

    return toDynamicAttributeResponse(updated!);
  }

  async updateValue(actor: AuthenticatedActor, attributeId: string, valueId: string, input: UpdateDynamicAttributeValueRequest): Promise<DynamicAttributeResponse> {
    const attr = await this.repo.findById(attributeId);
    if (!attr) throw new NotFoundException(CATALOG_ERR.DYNAMIC_ATTRIBUTE_NOT_FOUND, 'Không tìm thấy thuộc tính');

    const value = attr.values.find((v) => v.id === valueId);
    if (!value) throw new NotFoundException(CATALOG_ERR.VALUE_NOT_FOUND, 'Không tìm thấy giá trị');

    // Check if new value already exists (if changing value)
    if (input.value && input.value !== value.value) {
      const existing = attr.values.find((v) => v.value === input.value && v.id !== valueId);
      if (existing) throw new ConflictException(CATALOG_ERR.VALUE_EXISTS, `Giá trị '${input.value}' đã tồn tại cho thuộc tính này`);
    }

    const data: Record<string, unknown> = {};
    if (input.value !== undefined) data.value = input.value.trim();
    if (input.extra !== undefined) data.extra = input.extra === null ? Prisma.DbNull : input.extra;
    if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;

    if (Object.keys(data).length === 0) return toDynamicAttributeResponse(attr);

    const updated = await this.prisma.$transaction(async (tx) => {
      await this.repo.updateValue(valueId, data, tx);

      await this.audit.write(tx, actor, {
        action: CATALOG_AUDIT.DYNAMIC_ATTRIBUTE_VALUE_UPDATED,
        entityType: 'dynamicAttribute',
        entityId: attributeId,
        entityCode: attr.code,
        before: { value: value.value, sortOrder: value.sortOrder },
        // Nhật ký lưu giá trị THẬT (null), không lưu sentinel Prisma.DbNull.
        after: { ...data, ...(input.extra !== undefined ? { extra: input.extra } : {}) },
      });

      return this.repo.findById(attributeId, tx);
    });

    return toDynamicAttributeResponse(updated!);
  }

  async deleteValue(actor: AuthenticatedActor, attributeId: string, valueId: string): Promise<void> {
    const attr = await this.repo.findById(attributeId);
    if (!attr) throw new NotFoundException(CATALOG_ERR.DYNAMIC_ATTRIBUTE_NOT_FOUND, 'Không tìm thấy thuộc tính');

    const value = attr.values.find((v) => v.id === valueId);
    if (!value) throw new NotFoundException(CATALOG_ERR.VALUE_NOT_FOUND, 'Không tìm thấy giá trị');

    if (await this.usage.isAttributeValueInUse(valueId)) {
      throw new ConflictException(CATALOG_ERR.ATTRIBUTE_VALUE_IN_USE, `Giá trị '${value.value}' đang được sản phẩm/biến thể sử dụng — gỡ khỏi sản phẩm trước khi xoá`);
    }
    await this.prisma.$transaction(async (tx) => {
      await this.repo.deleteValue(valueId, tx);

      await this.audit.write(tx, actor, {
        action: CATALOG_AUDIT.DYNAMIC_ATTRIBUTE_VALUE_DELETED,
        entityType: 'dynamicAttribute',
        entityId: attributeId,
        entityCode: attr.code,
        before: { value: value.value, sortOrder: value.sortOrder },
      });
    });
  }
}
