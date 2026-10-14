import type { DepositRow } from '../repository/shop-wallet.repository';
import type { DepositRequestResponse, ShopWalletTransactionResponse } from '../dto/shop-wallet.responses';

/* Mapper dùng chung cho controller vendor + sàn (tiền luôn ra chuỗi số nguyên VND). */
export function toTransactionResponse(t: { id: string; type: string; amount: { toFixed(n: number): string }; balanceAfter: { toFixed(n: number): string }; orderCode: string | null; note: string | null; createdAt: Date }): ShopWalletTransactionResponse {
  return { id: t.id, type: t.type, amount: t.amount.toFixed(0), balanceAfter: t.balanceAfter.toFixed(0), orderCode: t.orderCode, note: t.note, createdAt: t.createdAt.toISOString() };
}

export function toDepositResponse(d: DepositRow, shopName: string | null): DepositRequestResponse {
  return { id: d.id, shopId: d.shopId, shopName, amount: d.amount.toFixed(0), status: d.status, proofUrl: d.proofUrl, note: d.note, createdAt: d.createdAt.toISOString() };
}
