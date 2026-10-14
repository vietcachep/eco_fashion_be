import { BusinessException, NotFoundException } from '@common/exception/business.exception';
import { PAYMENT_ERR } from '../foundation/payment.constants';
import { PaymentPublicController } from './payment.controllers';
import type { PaymentService, VnpayResult } from './payment.service';

/*
 * GET /payments/vnpay/return — FE trang kết quả gọi với toàn bộ query VNPay. Chữ ký sai / không có giao dịch PHẢI là lỗi HTTP thật:
 * trước đây trả 200 `success:true, data:null` nên một client chỉ kiểm `success` có thể coi như đã thanh toán.
 */
describe('PaymentPublicController.vnpayReturn', () => {
  const result: VnpayResult = { orderCode: 'DH2610040001', success: true, message: 'Giao dịch thành công', responseCode: '00', amount: { amount: '100000', display: '100.000 ₫', currency: 'VND', symbol: '₫' }, transactionCode: '14000001' };

  const build = (r: { rspCode: string; message: string; result: VnpayResult | null }) => {
    const handleVnpay = jest.fn().mockResolvedValue(r);
    return { controller: new PaymentPublicController({ handleVnpay } as unknown as PaymentService), handleVnpay };
  };

  it('có kết quả ⇒ 200 kèm kết quả, truyền nguyên query + nguồn "return"', async () => {
    const { controller, handleVnpay } = build({ rspCode: '00', message: 'Confirm Success', result });
    const query = { vnp_TxnRef: 'DH2610040001-1', vnp_SecureHash: 'abc' };

    const res = await controller.vnpayReturn(query);

    expect(res.success).toBe(true);
    expect(res.data).toEqual(result);
    expect(handleVnpay).toHaveBeenCalledWith(query, 'return');
  });

  it('chữ ký sai (rspCode 97) ⇒ lỗi 400 PAYMENT_INVALID_SIGNATURE, KHÔNG trả success', async () => {
    const { controller } = build({ rspCode: '97', message: 'Invalid signature', result: null });

    const err = await controller.vnpayReturn({}).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BusinessException);
    expect((err as BusinessException).errorCode).toBe(PAYMENT_ERR.INVALID_SIGNATURE);
    expect((err as BusinessException).httpStatus).toBe(400);
  });

  it('không có giao dịch (rspCode 01) ⇒ 404 PAYMENT_NOT_FOUND', async () => {
    const { controller } = build({ rspCode: '01', message: 'Order not found', result: null });

    const err = await controller.vnpayReturn({ vnp_TxnRef: 'DH0000000000-1' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as NotFoundException).errorCode).toBe(PAYMENT_ERR.NOT_FOUND);
  });

  it('thanh toán thất bại do khách huỷ (có result, success=false) vẫn là 200 — đó là KẾT QUẢ hợp lệ để FE hiện', async () => {
    const failed: VnpayResult = { ...result, success: false, responseCode: '24', message: 'Khách hàng huỷ giao dịch' };
    const { controller } = build({ rspCode: '00', message: 'Confirm Success', result: failed });

    const res = await controller.vnpayReturn({});

    expect(res.data?.success).toBe(false);
  });
});
