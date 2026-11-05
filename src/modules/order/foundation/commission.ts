/*
 * Gốc tính hoa hồng của một đơn (PLAN-0030 / docs/10 §10): TIỀN HÀNG sau voucher của SHOP — KHÔNG tính phí ship. Voucher SÀN do sàn chịu nên shop vẫn nhận đủ phần đó (không trừ vào gốc).
 * = subtotal − (shopDiscount − shopShippingDiscount). Một nguồn duy nhất cho đối soát PayOS (OrderQueryApi.settlementOrders) và ví cọc COD (OrderService → markCodCollected).
 */
type Amount = { toString(): string };

export function commissionBase(o: { subtotal: Amount; shopDiscount: Amount; shopShippingDiscount: Amount }): bigint {
  const base = BigInt(o.subtotal.toString()) - (BigInt(o.shopDiscount.toString()) - BigInt(o.shopShippingDiscount.toString()));
  return base > 0n ? base : 0n;
}
