import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { ENV } from '@config/config.module';
import type { Env } from '@config/env';

/*
 * Cổng VNPay (sandbox.vnpayment.vn — tiền thật khi lên production với TmnCode/secret thật): thẻ ATM nội địa,
 * Visa/Mastercard/JCB, VNPay QR. Đặc tả v2.1.0: tham số sắp theo tên, giá trị URL-encode (khoảng trắng → '+'),
 * HMAC-SHA512 với vnp_HashSecret. KHÔNG bao giờ nhận/lưu số thẻ — khách nhập trên trang của VNPay.
 */
@Injectable()
export class VnpayService {
  private readonly logger = new Logger(VnpayService.name);

  constructor(@Inject(ENV) private readonly env: Env) {}

  get isConfigured(): boolean {
    return Boolean(this.env.EF_VNPAY_TMN_CODE && this.env.EF_VNPAY_HASH_SECRET);
  }

  /* yyyyMMddHHmmss theo giờ Việt Nam (VNPay yêu cầu GMT+7). */
  static formatDate(d: Date): string {
    const vn = new Date(d.getTime() + 7 * 3_600_000);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${vn.getUTCFullYear()}${p(vn.getUTCMonth() + 1)}${p(vn.getUTCDate())}${p(vn.getUTCHours())}${p(vn.getUTCMinutes())}${p(vn.getUTCSeconds())}`;
  }

  private static encode(v: string): string {
    return encodeURIComponent(v).replace(/%20/g, '+');
  }

  /* Chuỗi ký = các cặp key=value (đã encode) sắp theo key, nối '&'. */
  static signingString(params: Record<string, string>): string {
    return Object.keys(params)
      .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '' && k !== 'vnp_SecureHash' && k !== 'vnp_SecureHashType')
      .sort()
      .map((k) => `${VnpayService.encode(k)}=${VnpayService.encode(params[k])}`)
      .join('&');
  }

  sign(data: string): string {
    return createHmac('sha512', this.env.EF_VNPAY_HASH_SECRET).update(Buffer.from(data, 'utf8')).digest('hex');
  }

  /* URL chuyển hướng khách sang VNPay. `txnRef` phải duy nhất theo ngày → dùng mã đơn + hậu tố lần tạo. */
  buildPayUrl(input: { txnRef: string; amount: bigint; orderInfo: string; ipAddr: string; bankCode?: string | null; expiresAt: Date; createdAt?: Date }): string {
    const now = input.createdAt ?? new Date();
    const params: Record<string, string> = {
      vnp_Version: '2.1.0',
      vnp_Command: 'pay',
      vnp_TmnCode: this.env.EF_VNPAY_TMN_CODE,
      vnp_Amount: (input.amount * 100n).toString(),
      vnp_CreateDate: VnpayService.formatDate(now),
      vnp_CurrCode: 'VND',
      vnp_IpAddr: input.ipAddr || '127.0.0.1',
      vnp_Locale: 'vn',
      vnp_OrderInfo: input.orderInfo,
      vnp_OrderType: 'other',
      vnp_ReturnUrl: `${this.env.EF_WEB_URL.replace(/\/$/, '')}/checkout/vnpay-return`,
      vnp_TxnRef: input.txnRef,
      vnp_ExpireDate: VnpayService.formatDate(input.expiresAt),
      ...(input.bankCode ? { vnp_BankCode: input.bankCode } : {}),
    };
    const data = VnpayService.signingString(params);
    return `${this.env.EF_VNPAY_PAY_URL}?${data}&vnp_SecureHash=${this.sign(data)}`;
  }

  /* Xác minh chữ ký của return/IPN (mọi tham số vnp_* trừ hash). */
  verify(query: Record<string, string>): boolean {
    const hash = query.vnp_SecureHash;
    if (!hash || !this.isConfigured) return false;
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(query)) if (k.startsWith('vnp_')) params[k] = v;
    const expected = this.sign(VnpayService.signingString(params));
    const a = Buffer.from(expected.toLowerCase(), 'utf8');
    const b = Buffer.from(hash.toLowerCase(), 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /*
   * Hoàn tiền qua API merchant (vnp_Command=refund). Chuỗi ký theo đặc tả:
   * RequestId|Version|Command|TmnCode|TransactionType|TxnRef|Amount|TransactionNo|TransactionDate|CreateBy|CreateDate|IpAddr|OrderInfo
   */
  async refund(input: { txnRef: string; amount: bigint; transactionNo: string; transactionDate: string; fullRefund: boolean; createBy: string; ipAddr: string; orderInfo: string }): Promise<{ ok: boolean; code: string; message: string; raw: unknown }> {
    const requestId = randomUUID().replace(/-/g, '').slice(0, 32);
    const createDate = VnpayService.formatDate(new Date());
    const body = {
      vnp_RequestId: requestId,
      vnp_Version: '2.1.0',
      vnp_Command: 'refund',
      vnp_TmnCode: this.env.EF_VNPAY_TMN_CODE,
      vnp_TransactionType: input.fullRefund ? '02' : '03',
      vnp_TxnRef: input.txnRef,
      vnp_Amount: (input.amount * 100n).toString(),
      vnp_OrderInfo: input.orderInfo,
      vnp_TransactionNo: input.transactionNo,
      vnp_TransactionDate: input.transactionDate,
      vnp_CreateBy: input.createBy,
      vnp_CreateDate: createDate,
      vnp_IpAddr: input.ipAddr || '127.0.0.1',
      vnp_SecureHash: '',
    };
    const data = [body.vnp_RequestId, body.vnp_Version, body.vnp_Command, body.vnp_TmnCode, body.vnp_TransactionType, body.vnp_TxnRef, body.vnp_Amount, body.vnp_TransactionNo, body.vnp_TransactionDate, body.vnp_CreateBy, body.vnp_CreateDate, body.vnp_IpAddr, body.vnp_OrderInfo].join('|');
    body.vnp_SecureHash = this.sign(data);
    try {
      const res = await fetch(this.env.EF_VNPAY_API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
      const json = (await res.json()) as { vnp_ResponseCode?: string; vnp_Message?: string };
      const code = json.vnp_ResponseCode ?? '99';
      return { ok: code === '00', code, message: json.vnp_Message ?? '', raw: json };
    } catch (err) {
      this.logger.warn({ err: err instanceof Error ? err.message : err }, 'Gọi API hoàn tiền VNPay lỗi');
      return { ok: false, code: '99', message: 'Không gọi được cổng VNPay', raw: null };
    }
  }
}
