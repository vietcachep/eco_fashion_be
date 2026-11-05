import { TOPUP_STATUS } from '../foundation/payment.constants';
import { PayosService } from '../payos/payos.service';
import { nextStatusAfterMoney, parseMoney, receiptRef, targetCumulative } from './shop-wallet-topup-settle.service';
import { NOW, setClock, startClock, stopFixture } from './shop-wallet-topup.fixture';
import type { TopupStatus } from './shop-wallet-topup.types';

/*
 * Hàm thuần của nạp cọc PayOS (PLAN-0041 §6.3) + mã PayOS dải nạp (§2 D4). Không DB, không mạng.
 * Mục tiêu: mọi biên của tiền (0, âm, thập phân, trần cột numeric(14,0)) và mọi ô của bảng chuyển trạng thái §4.2 đều có test.
 */

describe('Hàm thuần nạp cọc PayOS', () => {
  afterEach(() => stopFixture());

  it('[WTX-01] parseMoney: số/chuỗi nguyên hợp lệ ⇒ bigint; 0 chỉ khi allowZero; âm, thập phân, NaN, Infinity, chuỗi chữ, > 99.999.999.999.999, null/undefined ⇒ null', () => {
    expect(parseMoney(600000)).toBe(600000n);
    expect(parseMoney('600000')).toBe(600000n);
    expect(parseMoney(99_999_999_999_999)).toBe(99_999_999_999_999n);
    expect(parseMoney('99999999999999')).toBe(99_999_999_999_999n);
    expect(parseMoney(0)).toBeNull();
    expect(parseMoney(0, true)).toBe(0n);
    expect(parseMoney(-5, true)).toBeNull();
    for (const bad of [-5, 1.5, '1.5', NaN, Infinity, 'abc', '12abc', '', 100_000_000_000_000, '100000000000000', null, undefined, true, {}]) {
      expect(parseMoney(bad)).toBeNull();
    }
  });

  it('[WTX-02] receiptRef: reference ưu tiên (trim, cắt 100); thiếu thì <mã>:<transactionDateTime>:<amount>; thiếu cả hai ⇒ null', () => {
    const code = '5000000000000001';
    expect(receiptRef(code, { reference: '  TF001  ' })).toBe('TF001');
    expect(receiptRef(code, { reference: 'R'.repeat(150) })).toHaveLength(100);
    expect(receiptRef(code, { transactionDateTime: '2026-11-03 10:05:00', amount: 600000 })).toBe(`${code}:2026-11-03 10:05:00:600000`);
    // reference rỗng (sau trim) được coi là thiếu → dùng khoá ghép theo giờ
    expect(receiptRef(code, { reference: '   ', transactionDateTime: '2026-11-03 10:05:00', amount: 600000 })).toBe(`${code}:2026-11-03 10:05:00:600000`);
    expect(receiptRef(code, { amount: 600000 })).toBeNull();
  });

  it('[WTX-03] targetCumulative: max ba đầu vào; không bao giờ thấp hơn đã ghi có', () => {
    expect(targetCumulative(300n, 200n, 100n)).toBe(300n);
    expect(targetCumulative(100n, 400n, 0n)).toBe(400n);
    expect(targetCumulative(0n, 0n, 500n)).toBe(500n);
    expect(targetCumulative(0n, 0n, 0n)).toBe(0n);
  });

  it('[WTX-04] nextStatusAfterMoney: đủ bảng 7 trạng thái × received 0 / < X / = X / > X (X = 600.000)', () => {
    const X = 600_000n;
    // Ô: [received=0, received<X (300.000), received=X, received>X (700.000)] → trạng thái kế tiếp theo §4.2
    const table: Record<TopupStatus, [TopupStatus, TopupStatus, TopupStatus, TopupStatus]> = {
      [TOPUP_STATUS.CREATING]: [TOPUP_STATUS.CREATING, TOPUP_STATUS.PARTIAL, TOPUP_STATUS.PAID, TOPUP_STATUS.PAID],
      [TOPUP_STATUS.PENDING]: [TOPUP_STATUS.PENDING, TOPUP_STATUS.PARTIAL, TOPUP_STATUS.PAID, TOPUP_STATUS.PAID],
      [TOPUP_STATUS.PARTIAL]: [TOPUP_STATUS.PARTIAL, TOPUP_STATUS.PARTIAL, TOPUP_STATUS.PAID, TOPUP_STATUS.PAID],
      [TOPUP_STATUS.PAID]: [TOPUP_STATUS.PAID, TOPUP_STATUS.PAID, TOPUP_STATUS.PAID, TOPUP_STATUS.PAID],
      [TOPUP_STATUS.EXPIRED]: [TOPUP_STATUS.EXPIRED, TOPUP_STATUS.EXPIRED, TOPUP_STATUS.PAID, TOPUP_STATUS.PAID],
      [TOPUP_STATUS.CANCELLED]: [TOPUP_STATUS.CANCELLED, TOPUP_STATUS.CANCELLED, TOPUP_STATUS.PAID, TOPUP_STATUS.PAID],
      [TOPUP_STATUS.FAILED]: [TOPUP_STATUS.FAILED, TOPUP_STATUS.FAILED, TOPUP_STATUS.PAID, TOPUP_STATUS.PAID],
    };
    const money: [bigint, bigint, bigint, bigint] = [0n, 300_000n, X, 700_000n];
    for (const [status, expected] of Object.entries(table) as Array<[TopupStatus, [TopupStatus, TopupStatus, TopupStatus, TopupStatus]]>) {
      money.forEach((received, i) => {
        expect({ status, received: received.toString(), next: nextStatusAfterMoney(status, received, X) }).toEqual({ status, received: received.toString(), next: expected[i] });
      });
    }
  });

  it('[WTX-05] PayosService.generateTopupOrderCode ∈ [5e15, 6e15), khớp ^5\\d{15}$, ≤ MAX_SAFE_INTEGER; generateOrderCode() < 5e15 (bảo vệ D4)', () => {
    startClock(NOW);
    // Thử ở hai mốc thời gian xa nhau: mã nạp vẫn trong dải riêng (phần mili-giây đã lấy mod 1e12).
    for (const at of [NOW, NOW + 40 * 365 * 86_400_000]) {
      setClock(at);
      for (let i = 0; i < 1000; i += 1) {
        const n = PayosService.generateTopupOrderCode();
        expect(Number.isSafeInteger(n)).toBe(true);
        expect(n).toBeGreaterThanOrEqual(5e15);
        expect(n).toBeLessThan(6e15);
        expect(String(n)).toMatch(/^5\d{15}$/);
      }
    }
    // Mã đơn hàng luôn nằm dưới dải nạp cọc ⇒ webhook phân biệt được hai loại bằng dải số.
    for (let i = 0; i < 1000; i += 1) expect(PayosService.generateOrderCode()).toBeLessThan(5e15);
  });
});
