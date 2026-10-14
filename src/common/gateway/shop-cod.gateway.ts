import type { Tx } from '../prisma/types';

export const SHOP_COD_GATEWAY = Symbol('SHOP_COD_GATEWAY');

/* Payment module gọi để cập nhật COD của shop khi ví thay đổi (balance <= 0 → tắt; balance > 0 → bật lại).
   Trả true khi trạng thái COD THỰC SỰ đổi (để chỉ phát sự kiện/thông báo khi có đổi). */
export interface ShopCodGateway {
  setCodEnabled(shopId: string, enabled: boolean, tx?: Tx): Promise<boolean>;
}
