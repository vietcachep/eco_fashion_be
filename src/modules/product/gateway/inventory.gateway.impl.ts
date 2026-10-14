import { Injectable } from '@nestjs/common';
import { ConflictException } from '@common/exception/business.exception';
import { InsufficientStockError } from '@common/gateway/inventory.gateway';
import type { InventoryGateway, StockLine } from '@common/gateway/inventory.gateway';
import type { Tx } from '@common/prisma/types';
import { PRODUCT_ERR } from '../foundation/product.constants';
import { InventoryService } from '../inventory/service/inventory.service';

/*
 * Cài InventoryGateway — uỷ quyền sang InventoryService (khoá dòng + sổ kho).
 *
 * Lỗi thiếu hàng có HAI cách xử lý, tuỳ thao tác:
 *  - reserve: giữ nguyên `InsufficientStockError` — OrderService.placeOrder bắt đúng lớp lỗi này để trả ORDER_OUT_OF_STOCK 409
 *    kèm tên sản phẩm; đổi lớp là phá hợp đồng đó.
 *  - commit / release / restock (xác nhận, huỷ, hoàn đơn đã có): chỗ gọi (updateStatus, doCancel, return…) KHÔNG bắt
 *    InsufficientStockError → lỗi thường sẽ lọt xuống filter toàn cục thành 500. Ở đây đổi thành BusinessException 409
 *    PRODUCT_INSUFFICIENT_STOCK (kèm số cần/còn theo biến thể trong `details`) để client thấy lỗi nghiệp vụ rõ ràng.
 */
@Injectable()
export class InventoryGatewayImpl implements InventoryGateway {
  constructor(private readonly inventory: InventoryService) {}

  availableOf(variantIds: string[]): Promise<Map<string, number>> {
    return this.inventory.availableOf(variantIds);
  }

  reserve(lines: StockLine[], ref: { type: string; id: string }, tx: Tx): Promise<void> {
    return this.inventory.reserve(lines, ref, tx);
  }

  release(lines: StockLine[], ref: { type: string; id: string }, tx: Tx): Promise<void> {
    return this.asBusinessError(this.inventory.release(lines, ref, tx));
  }

  commit(lines: StockLine[], ref: { type: string; id: string }, tx: Tx): Promise<void> {
    return this.asBusinessError(this.inventory.commit(lines, ref, tx));
  }

  restock(lines: StockLine[], ref: { type: string; id: string }, tx: Tx): Promise<void> {
    return this.asBusinessError(this.inventory.restock(lines, ref, tx));
  }

  /* InsufficientStockError → ConflictException 409 PRODUCT_INSUFFICIENT_STOCK; lỗi khác (DB, bug) đi tiếp nguyên vẹn. */
  private async asBusinessError(op: Promise<void>): Promise<void> {
    try {
      await op;
    } catch (err) {
      if (err instanceof InsufficientStockError) {
        const details = Object.fromEntries(err.shortages.map((s) => [s.variantId, `cần ${s.requested}, còn ${s.available}`]));
        throw new ConflictException(PRODUCT_ERR.INSUFFICIENT_STOCK, 'Không đủ tồn kho để hoàn tất thao tác trên đơn hàng', details);
      }
      throw err;
    }
  }
}
