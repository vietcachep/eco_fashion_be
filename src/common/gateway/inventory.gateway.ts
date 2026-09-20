import type { Tx } from '../prisma/types';

export const INVENTORY_GATEWAY = Symbol('INVENTORY_GATEWAY');

export interface StockLine {
  variantId: string;
  quantity: number;
}

export interface StockShortage {
  variantId: string;
  requested: number;
  available: number;
}

/*
 * Cổng tồn kho — product cài đặt; cart/order gọi TRONG transaction của mình (nhận `tx`).
 * Vòng đời: reserve (đặt đơn, giữ hàng) → commit (đơn thanh toán/xác nhận: trừ tồn thật) | release (huỷ/quá hạn).
 * Mọi hàm khoá dòng biến thể (FOR UPDATE) và ghi sổ kho; thiếu hàng → ném lỗi có danh sách thiếu để order trả 409.
 */
export interface InventoryGateway {
  /* Tồn có thể bán (stock − reserved) theo biến thể — cart/checkout kiểm trước khi đặt. */
  availableOf(variantIds: string[]): Promise<Map<string, number>>;
  reserve(lines: StockLine[], ref: { type: string; id: string }, tx: Tx): Promise<void>;
  release(lines: StockLine[], ref: { type: string; id: string }, tx: Tx): Promise<void>;
  commit(lines: StockLine[], ref: { type: string; id: string }, tx: Tx): Promise<void>;
  /* Hàng trả về kho (đổi trả chấp nhận). */
  restock(lines: StockLine[], ref: { type: string; id: string }, tx: Tx): Promise<void>;
}

export class InsufficientStockError extends Error {
  constructor(public readonly shortages: StockShortage[]) {
    super('Không đủ tồn kho');
    this.name = 'InsufficientStockError';
  }
}
