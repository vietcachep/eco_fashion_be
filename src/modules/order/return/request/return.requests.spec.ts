import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { DeliveryFailedRequest } from '../../order/request/shop-order.requests';
import { ApproveReturnRequest, CreateReturnRequest, EscalateReturnRequest, ReceiveReturnRequest, RejectReturnRequest, ResolveReturnRequest, ReturnListQuery, ShipBackReturnRequest, ShopReturnListQuery } from './return.requests';

/* Thuộc tính lỗi validate (whitelist + forbidNonWhitelisted giống ValidationPipe toàn cục), gồm cả lỗi lồng nhau theo đường dẫn. */
function invalid<T extends object>(cls: new () => T, body: Record<string, unknown>): string[] {
  const walk = (errs: ReturnType<typeof validateSync>, prefix = ''): string[] => errs.flatMap((e) => (e.children && e.children.length > 0 ? walk(e.children, `${prefix}${e.property}.`) : [`${prefix}${e.property}`]));
  return walk(validateSync(plainToInstance(cls, body), { whitelist: true, forbidNonWhitelisted: true }));
}

const media = { type: 'image', url: '/static/uploads/user-media/ab/1.jpg', name: '1.jpg' };
const account = { bankBin: '970422', accountNumber: '0123456789', accountName: 'Nguyễn Văn A' };

describe('CreateReturnRequest', () => {
  const ok = { reasonCode: 'size_issue', reason: 'Không vừa size', items: [{ orderItemId: '3fa85f64-5717-4562-b3fc-2c963f66afa6', quantity: 1 }], evidence: [media] };

  it('hợp lệ: đủ trường; reason/items/evidence/refundAccount là tuỳ chọn ở DTO (service kiểm tiếp theo lý do)', () => {
    expect(invalid(CreateReturnRequest, ok)).toEqual([]);
    expect(invalid(CreateReturnRequest, { reasonCode: 'not_received' })).toEqual([]);
    expect(invalid(CreateReturnRequest, { ...ok, refundAccount: account })).toEqual([]);
  });

  it('reasonCode bắt buộc và chỉ nhận 8 mã chuẩn', () => {
    expect(invalid(CreateReturnRequest, { ...ok, reasonCode: undefined })).toContain('reasonCode');
    expect(invalid(CreateReturnRequest, { ...ok, reasonCode: 'khong-hop-le' })).toContain('reasonCode');
    for (const code of ['defective', 'wrong_item', 'not_as_described', 'damaged_shipping', 'size_issue', 'changed_mind', 'not_received', 'other']) expect(invalid(CreateReturnRequest, { ...ok, reasonCode: code })).toEqual([]);
  });

  it('minh chứng tối đa 8 tệp; loại chỉ image|video; url ≤ 500 ký tự', () => {
    expect(invalid(CreateReturnRequest, { ...ok, evidence: Array(8).fill(media) })).toEqual([]);
    expect(invalid(CreateReturnRequest, { ...ok, evidence: Array(9).fill(media) })).toContain('evidence');
    expect(invalid(CreateReturnRequest, { ...ok, evidence: [{ ...media, type: 'pdf' }] })).toContain('evidence.0.type');
    expect(invalid(CreateReturnRequest, { ...ok, evidence: [{ ...media, url: `/static/uploads/${'a'.repeat(500)}` }] })).toContain('evidence.0.url');
  });

  it('dòng hàng: orderItemId uuid, quantity ≥ 1 nguyên; tối đa 50 dòng', () => {
    expect(invalid(CreateReturnRequest, { ...ok, items: [{ orderItemId: 'x', quantity: 1 }] })).toContain('items.0.orderItemId');
    expect(invalid(CreateReturnRequest, { ...ok, items: [{ orderItemId: '3fa85f64-5717-4562-b3fc-2c963f66afa6', quantity: 0 }] })).toContain('items.0.quantity');
    expect(invalid(CreateReturnRequest, { ...ok, items: Array(51).fill(ok.items[0]) })).toContain('items');
  });

  it('tài khoản nhận hoàn: BIN đúng 6 số; số TK 6–30 ký tự; tên 2–80', () => {
    expect(invalid(CreateReturnRequest, { ...ok, refundAccount: { ...account, bankBin: '1234' } })).toContain('refundAccount.bankBin');
    expect(invalid(CreateReturnRequest, { ...ok, refundAccount: { ...account, accountNumber: '123' } })).toContain('refundAccount.accountNumber');
    expect(invalid(CreateReturnRequest, { ...ok, refundAccount: { ...account, accountName: 'A' } })).toContain('refundAccount.accountName');
    expect(invalid(CreateReturnRequest, { ...ok, refundAccount: { ...account, extra: 1 } })).toContain('refundAccount.extra');
  });

  it('trường lạ bị từ chối (forbidNonWhitelisted) — không nhận userId/shopId/status từ body', () => {
    expect(invalid(CreateReturnRequest, { ...ok, userId: 'x', shopId: 'y', status: 'approved' })).toEqual(expect.arrayContaining(['userId', 'shopId', 'status']));
  });
});

describe('ShipBackReturnRequest / EscalateReturnRequest', () => {
  it('ship-back: carrier + trackingCode bắt buộc', () => {
    expect(invalid(ShipBackReturnRequest, { carrier: 'GHN', trackingCode: 'GHN123' })).toEqual([]);
    expect(invalid(ShipBackReturnRequest, { carrier: 'GHN' })).toContain('trackingCode');
    expect(invalid(ShipBackReturnRequest, { trackingCode: 'GHN123' })).toContain('carrier');
  });

  it('escalate: lý do ≥ 10 ký tự', () => {
    expect(invalid(EscalateReturnRequest, { reason: 'Hàng thật sự bị lỗi như ảnh' })).toEqual([]);
    expect(invalid(EscalateReturnRequest, { reason: 'ngắn' })).toContain('reason');
  });
});

describe('Shop: ApproveReturnRequest / RejectReturnRequest / ReceiveReturnRequest', () => {
  it('approve: mọi trường tuỳ chọn; refundAmount là số nguyên VND; địa chỉ trả hàng hợp lệ', () => {
    expect(invalid(ApproveReturnRequest, {})).toEqual([]);
    expect(invalid(ApproveReturnRequest, { refundAmount: '80000', adjustReason: 'Trừ 20%', returnAddress: { name: 'Kho A', phone: '0901234567', address: '12 Nguyễn Huệ, Q1' } })).toEqual([]);
    expect(invalid(ApproveReturnRequest, { refundAmount: '-1' })).toContain('refundAmount');
    expect(invalid(ApproveReturnRequest, { refundAmount: '80.5' })).toContain('refundAmount');
    expect(invalid(ApproveReturnRequest, { returnAddress: { name: 'Kho A', phone: '123', address: '12 Nguyễn Huệ' } })).toContain('returnAddress.phone');
    expect(invalid(ApproveReturnRequest, { shopId: 'x' })).toContain('shopId'); // shopId không bao giờ từ body
  });

  it('reject: lý do ≥ 10 ký tự, minh chứng ≤ 8', () => {
    expect(invalid(RejectReturnRequest, { reason: 'Hàng đã qua sử dụng' })).toEqual([]);
    expect(invalid(RejectReturnRequest, { reason: 'ngắn' })).toContain('reason');
    expect(invalid(RejectReturnRequest, { reason: 'Hàng đã qua sử dụng', evidence: Array(9).fill(media) })).toContain('evidence');
  });

  it('receive: condition ok|not_matching', () => {
    expect(invalid(ReceiveReturnRequest, { condition: 'ok' })).toEqual([]);
    expect(invalid(ReceiveReturnRequest, { condition: 'not_matching', note: 'Hàng nhận về là áo khác' })).toEqual([]);
    expect(invalid(ReceiveReturnRequest, { condition: 'damaged' })).toContain('condition');
    expect(invalid(ReceiveReturnRequest, {})).toContain('condition');
  });
});

describe('Sàn: ResolveReturnRequest / ReturnListQuery', () => {
  it('resolve: decision refund|reject, note bắt buộc ≥ 5 ký tự, refundAmount số nguyên', () => {
    expect(invalid(ResolveReturnRequest, { decision: 'refund', note: 'Hàng lỗi sản xuất', refundAmount: '90000' })).toEqual([]);
    expect(invalid(ResolveReturnRequest, { decision: 'reject', note: 'Không đủ căn cứ' })).toEqual([]);
    expect(invalid(ResolveReturnRequest, { decision: 'approved', note: 'Hàng lỗi sản xuất' })).toContain('decision'); // giá trị của endpoint process cũ
    expect(invalid(ResolveReturnRequest, { decision: 'refund' })).toContain('note');
    expect(invalid(ResolveReturnRequest, { decision: 'refund', note: 'ok' })).toContain('note');
    expect(invalid(ResolveReturnRequest, { decision: 'refund', note: 'Hàng lỗi sản xuất', refundAmount: 'abc' })).toContain('refundAmount');
  });

  it('danh sách sàn: lọc status (8 trạng thái mới) + shopId; danh sách shop KHÔNG nhận shopId', () => {
    for (const status of ['requested', 'approved', 'received', 'refunded', 'rejected', 'escalated', 'cancelled', 'expired']) expect(invalid(ReturnListQuery, { status })).toEqual([]);
    expect(invalid(ReturnListQuery, { status: 'processing' })).toContain('status');
    expect(invalid(ReturnListQuery, { shopId: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })).toEqual([]);
    expect(invalid(ShopReturnListQuery, { status: 'escalated' })).toEqual([]);
    expect(invalid(ShopReturnListQuery, { shopId: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })).toContain('shopId');
  });
});

describe('DeliveryFailedRequest', () => {
  it('reasonCode refused|unreachable|wrong_address|lost|damaged|other (PLAN-0031 §2.4); note 5–500; goodsReturned boolean bắt buộc', () => {
    for (const reasonCode of ['refused', 'unreachable', 'wrong_address', 'lost', 'damaged', 'other']) expect(invalid(DeliveryFailedRequest, { reasonCode, note: 'Khách từ chối nhận', goodsReturned: false })).toEqual([]);
    expect(invalid(DeliveryFailedRequest, { reasonCode: 'stolen', note: 'Khách từ chối nhận', goodsReturned: false })).toContain('reasonCode');
    expect(invalid(DeliveryFailedRequest, { reasonCode: 'lost', note: 'abc', goodsReturned: true })).toContain('note');
    expect(invalid(DeliveryFailedRequest, { reasonCode: 'lost', note: 'Hàng thất lạc' })).toContain('goodsReturned');
    expect(invalid(DeliveryFailedRequest, { reasonCode: 'lost', note: 'Hàng thất lạc', goodsReturned: 'yes' })).toContain('goodsReturned');
  });
});
