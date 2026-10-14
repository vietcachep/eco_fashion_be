import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '@common/prisma/prisma.service';
import { CatalogUsageRegistry, type CatalogUsageProvider } from '../../catalog/queryapi/catalog-usage.registry';

/*
 * product trả lời câu hỏi "ngành hàng / giá trị thuộc tính này đang được dùng không?" cho catalog (xem CatalogUsageRegistry).
 * Chỉ đọc bảng của chính product; catalog dùng kết quả để chặn đổi chế độ ngành (CATALOG_CATEGORY_MODE_LOCKED) và chặn xoá
 * giá trị thuộc tính còn được dùng (CATALOG_ATTRIBUTE_VALUE_IN_USE). Truy vấn nhẹ: count/findFirst chỉ lấy id, tập dữ liệu nhỏ.
 */
@Injectable()
export class CatalogUsageProviderImpl implements CatalogUsageProvider, OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: CatalogUsageRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  countProductsInCategory(categoryId: string): Promise<number> {
    return this.prisma.product.count({ where: { categoryId, isDeleted: false } });
  }

  /* Tính cả biến thể đã xoá mềm: dòng option của chúng vẫn trỏ tới id giá trị (snapshot lịch sử) nên xoá giá trị vẫn để lại id mồ côi. */
  async isAttributeValueInUse(valueId: string): Promise<boolean> {
    const [asAttribute, asOption] = await Promise.all([
      this.prisma.productAttributeValue.findFirst({ where: { attributeValueId: valueId }, select: { id: true } }),
      this.prisma.productVariantOption.findFirst({ where: { attributeValueId: valueId }, select: { id: true } }),
    ]);
    return asAttribute !== null || asOption !== null;
  }
}
