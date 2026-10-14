import { Injectable } from '@nestjs/common';

/*
 * "Ai đang dùng dữ liệu catalog?" — module KHÁC (product) trả lời, catalog chỉ hỏi.
 * catalog không được đọc bảng product (ranh giới schema) và cũng không import product (product đã import catalog → vòng).
 * Nên đảo chiều đăng ký: module dùng catalog gọi `CatalogUsageRegistry.register()` lúc khởi động, catalog hỏi qua registry.
 * Không có provider nào đăng ký (vd tiến trình chỉ nạp catalog) → coi như chưa ai dùng.
 */
export interface CatalogUsageProvider {
  /* Số sản phẩm chưa xoá (MỌI trạng thái: nháp/ẩn/đang bán) thuộc ngành hàng. */
  countProductsInCategory(categoryId: string): Promise<number>;
  /* Giá trị thuộc tính động đang được tham chiếu (thuộc tính cấp sản phẩm hoặc trục biến thể)? */
  isAttributeValueInUse(valueId: string): Promise<boolean>;
}

@Injectable()
export class CatalogUsageRegistry {
  private readonly providers = new Set<CatalogUsageProvider>();

  register(provider: CatalogUsageProvider): void {
    this.providers.add(provider);
  }

  async countProductsInCategory(categoryId: string): Promise<number> {
    let total = 0;
    for (const p of this.providers) total += await p.countProductsInCategory(categoryId);
    return total;
  }

  async isAttributeValueInUse(valueId: string): Promise<boolean> {
    for (const p of this.providers) if (await p.isAttributeValueInUse(valueId)) return true;
    return false;
  }
}
