import type { Tx } from '../prisma/types';

export const CART_GATEWAY = Symbol('CART_GATEWAY');

/*
 * Cổng ghi giỏ cho module khác: order xoá các dòng đã mua TRONG transaction tạo đơn; ai thêm dòng khi khách bấm
 * "Xác nhận" đề xuất của chatbot (đi đúng luật giỏ: tồn, tối đa/dòng).
 */
export interface CartGateway {
  removeLines(userId: string, variantIds: string[], tx?: Tx): Promise<void>;
  addItem(userId: string, variantId: string, quantity: number): Promise<{ itemCount: number }>;
}
