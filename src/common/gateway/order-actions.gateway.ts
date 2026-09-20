import type { AuthenticatedActor } from '../security/authenticated-actor';

export const ORDER_ACTIONS_GATEWAY = Symbol('ORDER_ACTIONS_GATEWAY');

/*
 * Cổng THAO TÁC đơn thay khách cho module khác (ai: khách bấm "Xác nhận" trên thẻ đề xuất của chatbot) — order cài,
 * đi đúng luật của OrderService (chỉ huỷ khi pending, nhả kho/mã/hoàn tiền). Không phải queryapi vì đây là GHI.
 */
export interface OrderActionsGateway {
  cancelByCustomer(actor: Pick<AuthenticatedActor, 'userId' | 'email'>, orderCode: string, reason: string): Promise<{ code: string; status: string }>;
}
