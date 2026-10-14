import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AdjustStockRequest, CreateReceiptRequest } from './inventory.requests';

/* Chạy ValidationPipe thật: whitelist + forbidNonWhitelisted như main.ts; lỗi lồng (items[0].unitCost) vẫn đếm là có lỗi. */
function hasErrors(cls: new () => object, plain: object): boolean {
  return validateSync(plainToInstance(cls, plain), { whitelist: true, forbidNonWhitelisted: true }).length > 0;
}

const VARIANT = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const receipt = (item: object) => ({ items: [{ variantId: VARIANT, quantity: 5, ...item }] });

describe('CreateReceiptRequest — unitCost + số lượng (M4)', () => {
  it('unitCost hợp lệ: số nguyên đồng không dấu, tối đa 12 chữ số, hoặc bỏ trống', () => {
    expect(hasErrors(CreateReceiptRequest, receipt({ unitCost: '0' }))).toBe(false);
    expect(hasErrors(CreateReceiptRequest, receipt({ unitCost: '80000' }))).toBe(false);
    expect(hasErrors(CreateReceiptRequest, receipt({ unitCost: '999999999999' }))).toBe(false);
    expect(hasErrors(CreateReceiptRequest, receipt({}))).toBe(false);
  });

  it.each(['-5', '+5', '.5', '5.5', '1e3', '0x10', ' 5', '5 ', '', 'abc', '1000000000000'])('unitCost %p bị từ chối (trước đây IsNumberString nhận hoặc tràn Decimal(14,0) → 500)', (unitCost) => {
    expect(hasErrors(CreateReceiptRequest, receipt({ unitCost }))).toBe(true);
  });

  it('unitCost dạng số (không phải chuỗi) bị từ chối', () => {
    expect(hasErrors(CreateReceiptRequest, receipt({ unitCost: 80000 }))).toBe(true);
  });

  it('quantity phải là số nguyên 1–100.000', () => {
    expect(hasErrors(CreateReceiptRequest, receipt({ quantity: 1 }))).toBe(false);
    expect(hasErrors(CreateReceiptRequest, receipt({ quantity: 100000 }))).toBe(false);
    for (const quantity of [0, -1, 1.5, 100001, 'abc']) expect(hasErrors(CreateReceiptRequest, receipt({ quantity }))).toBe(true);
  });
});

describe('AdjustStockRequest — delta + lý do (M4)', () => {
  const adjust = (over: object) => ({ variantId: VARIANT, delta: -2, reason: 'Kiểm kê cuối tháng', ...over });

  it('delta nguyên trong ±100.000; hợp lệ khi có lý do', () => {
    expect(hasErrors(AdjustStockRequest, adjust({}))).toBe(false);
    expect(hasErrors(AdjustStockRequest, adjust({ delta: 100000 }))).toBe(false);
    expect(hasErrors(AdjustStockRequest, adjust({ delta: -100000 }))).toBe(false);
  });

  it('delta thập phân / ngoài khoảng bị từ chối', () => {
    for (const delta of [1.5, 100001, -100001, 'x']) expect(hasErrors(AdjustStockRequest, adjust({ delta }))).toBe(true);
  });

  it('lý do quá ngắn (< 3 ký tự) hoặc thiếu bị từ chối', () => {
    expect(hasErrors(AdjustStockRequest, adjust({ reason: 'ab' }))).toBe(true);
    expect(hasErrors(AdjustStockRequest, adjust({ reason: undefined }))).toBe(true);
  });
});
