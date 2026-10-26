import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { ENV } from '@config/config.module';
import type { Env } from '@config/env';

/*
 * Cổng PayOS (api-merchant.payos.vn — thanh toán QR/chuyển khoản tự động): tạo payment link, xác minh webhook,
 * chi trả shop + hoàn tiền (Lệnh chi qua /v1/payouts API — xác nhận tài liệu 2026-09-28).
 * Thu tiền (payment link) + chi tiền (payout) dùng 2 cặp khoá khác nhau trong dashboard PayOS.
 * orderCode phải là số nguyên ≤ 9007199254740991 (Number.MAX_SAFE_INTEGER) — sinh từ mili-giây hiện tại + 3 ký số ngẫu nhiên (không trùng).
 * Mọi khoá để TRỐNG ⇒ `isConfigured` = false ⇒ method `payos` bị tắt khỏi danh sách thanh toán, không gọi mạng.
 */
@Injectable()
export class PayosService {
  private readonly logger = new Logger(PayosService.name);

  constructor(@Inject(ENV) private readonly env: Env) {}

  /* Payment link creation (thu tiền): kiểm cấu hình CLIENT_ID + API_KEY + CHECKSUM_KEY. */
  get isConfigured(): boolean {
    return Boolean(this.env.EF_PAYOS_CLIENT_ID && this.env.EF_PAYOS_API_KEY && this.env.EF_PAYOS_CHECKSUM_KEY);
  }

  /* Payout (chi trả): riêng cặp khoá PAYOUT_*. */
  get isPayoutConfigured(): boolean {
    return Boolean(this.env.EF_PAYOS_PAYOUT_CLIENT_ID && this.env.EF_PAYOS_PAYOUT_API_KEY && this.env.EF_PAYOS_PAYOUT_CHECKSUM_KEY);
  }

  /*
   * Sinh orderCode cho PayOS: số nguyên dương ≤ Number.MAX_SAFE_INTEGER (9007199254740991).
   * = Date.now() (mili-giây, 13 chữ số) × 1000 + 3 ký số ngẫu nhiên ⇒ ~1.8e15, trùng chỉ khi cùng mili-giây VÀ cùng 3 số.
   * (Cách cũ yymmdd + 6 số ngẫu nhiên có xác suất trùng ~50% khi chỉ 1.000 đơn/ngày — tính theo nghịch lý sinh nhật.)
   */
  static generateOrderCode(): number {
    return Date.now() * 1000 + randomInt(1000);
  }

  /*
   * Tạo payment link: POST /v2/payment-requests.
   * signature = HMAC-SHA256 trên chuỗi `amount=...&cancelUrl=...&description=...&orderCode=...&returnUrl=...` (key sắp xếp alphabet).
   * Chỉ code "00" là thành công. Lỗi/thiếu cấu hình ⇒ checkoutUrl = null — caller PHẢI coi là thất bại (không tạo đơn treo không có link).
   * `description` ≤ 25 ký tự (≤ 9 nếu tài khoản chưa liên kết ngân hàng) — caller truyền mã đơn.
   */
  async createPaymentLink(input: {
    orderCode: number;
    amount: bigint;
    description: string;
    returnUrl: string;
    cancelUrl: string;
    expiresAt: Date;
    items?: Array<{ name: string; quantity: number; price: bigint }>;
  }): Promise<{ checkoutUrl: string | null; qrCode: string | null; paymentLinkId: string | null }> {
    const failed = { checkoutUrl: null, qrCode: null, paymentLinkId: null };
    if (!this.isConfigured) {
      this.logger.warn('PayOS chưa cấu hình khoá — không tạo payment link');
      return failed;
    }

    const description = input.description.slice(0, 25);
    const signingData = `amount=${input.amount}&cancelUrl=${input.cancelUrl}&description=${description}&orderCode=${input.orderCode}&returnUrl=${input.returnUrl}`;
    const body = {
      orderCode: input.orderCode,
      amount: Number(input.amount),
      description,
      cancelUrl: input.cancelUrl,
      returnUrl: input.returnUrl,
      expiredAt: Math.floor(input.expiresAt.getTime() / 1000), // Unix giây
      signature: this.sign(signingData, this.env.EF_PAYOS_CHECKSUM_KEY),
      ...(input.items ? { items: input.items.map((i) => ({ name: i.name, quantity: i.quantity, price: Number(i.price) })) } : {}),
    };

    try {
      const res = await fetch(`${this.env.EF_PAYOS_API_URL}/v2/payment-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-client-id': this.env.EF_PAYOS_CLIENT_ID, 'x-api-key': this.env.EF_PAYOS_API_KEY },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8_000), // gọi trong transaction đặt hàng — không giữ khoá DB lâu
      });
      const json = (await res.json()) as { code?: string; desc?: string; data?: { checkoutUrl?: string; qrCode?: string; paymentLinkId?: string } };
      if (json.code !== '00' || !json.data?.checkoutUrl) {
        this.logger.warn({ code: json.code, desc: json.desc, orderCode: input.orderCode }, 'Tạo payment link PayOS thất bại');
        return failed;
      }
      return { checkoutUrl: json.data.checkoutUrl, qrCode: json.data.qrCode ?? null, paymentLinkId: json.data.paymentLinkId ?? null };
    } catch (err) {
      this.logger.warn({ err: err instanceof Error ? err.message : err, orderCode: input.orderCode }, 'Gọi API tạo payment link PayOS lỗi');
      return failed;
    }
  }

  /*
   * Lấy thông tin payment link: GET /v2/payment-requests/{id}.
   * id có thể là orderCode hoặc paymentLinkId.
   */
  async getPaymentLink(orderCodeOrId: number | string): Promise<{ status?: string; amountPaid?: number; amountRemaining?: number }> {
    if (!this.isConfigured) return {};

    try {
      const res = await fetch(`${this.env.EF_PAYOS_API_URL}/v2/payment-requests/${orderCodeOrId}`, {
        method: 'GET',
        headers: {
          'x-client-id': this.env.EF_PAYOS_CLIENT_ID,
          'x-api-key': this.env.EF_PAYOS_API_KEY,
        },
        signal: AbortSignal.timeout(10_000),
      });

      const json = (await res.json()) as { code?: string; data?: { status?: string; amountPaid?: number; amountRemaining?: number } };
      return json.data ?? {};
    } catch (err) {
      this.logger.warn({ err: err instanceof Error ? err.message : err }, 'Truy vấn payment link PayOS lỗi');
      return {};
    }
  }

  /*
   * Hủy payment link: DELETE /v2/payment-requests/{id}.
   */
  async cancelPaymentLink(orderCodeOrId: number | string): Promise<boolean> {
    if (!this.isConfigured) return false;

    try {
      const res = await fetch(`${this.env.EF_PAYOS_API_URL}/v2/payment-requests/${orderCodeOrId}`, {
        method: 'DELETE',
        headers: {
          'x-client-id': this.env.EF_PAYOS_CLIENT_ID,
          'x-api-key': this.env.EF_PAYOS_API_KEY,
        },
        signal: AbortSignal.timeout(10_000),
      });

      const json = (await res.json()) as { code?: string };
      return json.code === '00';
    } catch (err) {
      this.logger.warn({ err: err instanceof Error ? err.message : err }, 'Hủy payment link PayOS lỗi');
      return false;
    }
  }

  /*
   * Xác minh chữ ký webhook PayOS: HMAC-SHA256(checksumKey, `k1=v1&k2=v2…`) trên các trường của `data` sắp theo tên khoá.
   * Chuẩn hoá giá trị theo SDK chính thức: null/undefined → chuỗi rỗng; mảng/đối tượng → JSON (khoá sắp xếp); còn lại String(v).
   * So sánh hằng-thời-gian (chống dò chữ ký). Thiếu cấu hình / thiếu data / thiếu signature ⇒ false.
   */
  verifyWebhookSignature(body: { data?: Record<string, unknown>; signature?: string }): boolean {
    if (!this.isConfigured || !body.data || typeof body.signature !== 'string') return false;
    const expected = this.sign(PayosService.canonicalQuery(body.data), this.env.EF_PAYOS_CHECKSUM_KEY);
    const a = Buffer.from(expected.toLowerCase(), 'utf8');
    const b = Buffer.from(body.signature.toLowerCase(), 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private static canonicalValue(v: unknown): string {
    if (v === null || v === undefined || v === 'null' || v === 'undefined') return '';
    if (Array.isArray(v)) return JSON.stringify((v as unknown[]).map((x): unknown => (x && typeof x === 'object' ? PayosService.sortKeys(x as Record<string, unknown>) : x)));
    if (typeof v === 'object') return JSON.stringify(PayosService.sortKeys(v as Record<string, unknown>));
    return typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' ? String(v) : '';
  }

  private static sortKeys(o: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
  }

  private static canonicalQuery(data: Record<string, unknown>): string {
    return Object.keys(data)
      .sort()
      .map((k) => `${k}=${PayosService.canonicalValue(data[k])}`)
      .join('&');
  }

  /*
   * Chi trả (payout): POST /v1/payouts (tài liệu https://payos.vn/docs/api/#tag/payout, đọc 2026-10-26).
   * Header: x-client-id + x-api-key của KÊNH CHI, `x-idempotency-key` (bắt buộc — cùng key gửi lại không chi đôi), `x-signature` (bắt buộc).
   * Body: { referenceId, amount (số nguyên), description, toBin, toAccountNumber, category? }. Phản hồi `{ code: "00", desc, data: { id, referenceId, transactions[{state}], approvalState } }`;
   * "00" = PayOS ĐÃ NHẬN lệnh — tiền đi bất đồng bộ (state PROCESSING → SUCCEEDED) nên kết quả cuối lấy bằng `getPayout` (job đối chiếu), KHÔNG coi "00" là đã chuyển xong.
   * x-signature: HMAC-SHA256 (checksum key của KÊNH CHI) trên `payoutCanonical(body)` — công thức theo mục lệnh chi của trang "Kiểm tra dữ liệu với signature" (có mã hoá URI,
   *   khác payment-request). Tài liệu mẫu ký phần `data` của PHẢN HỒI; việc áp cùng công thức cho BODY của request là suy ra — chưa kiểm với tài khoản thật. Nếu PayOS trả 401 khi
   *   chi thử, chỉnh `signPayout` (một chỗ) theo hướng dẫn của support@payos.vn.
   */
  async payout(input: {
    referenceId: string;
    amount: bigint;
    toBin: string;
    toAccountNumber: string;
    description: string;
    idempotencyKey: string;
  }): Promise<{ ok: boolean; code: string; message: string; transactionId?: string; raw: unknown }> {
    if (!this.isPayoutConfigured) {
      return { ok: false, code: 'NOT_CONFIGURED', message: 'PayOS payout chưa được cấu hình', raw: null };
    }

    const body = {
      referenceId: input.referenceId,
      amount: Number(input.amount),
      description: input.description,
      toBin: input.toBin,
      toAccountNumber: input.toAccountNumber,
    };

    try {
      const res = await fetch(`${this.env.EF_PAYOS_API_URL}/v1/payouts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-client-id': this.env.EF_PAYOS_PAYOUT_CLIENT_ID,
          'x-api-key': this.env.EF_PAYOS_PAYOUT_API_KEY,
          'x-idempotency-key': input.idempotencyKey,
          'x-signature': this.signPayout(body),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });

      const text = await res.text();
      let json: { code?: string; desc?: string; message?: string; data?: { id?: string } } = {};
      try {
        json = JSON.parse(text) as typeof json;
      } catch {
        // HTTP lỗi không phải JSON (401/403/429/5xx) — giữ nguyên mã HTTP làm lý do
      }
      const code = json.code ?? String(res.status);
      const ok = res.ok && code === '00';
      return { ok, code, message: json.desc ?? json.message ?? (ok ? 'success' : `HTTP ${res.status}`), transactionId: json.data?.id, raw: json };
    } catch (err) {
      this.logger.warn({ err: err instanceof Error ? err.message : err, referenceId: input.referenceId }, 'Gọi API payout PayOS lỗi');
      return { ok: false, code: '99', message: 'Không gọi được cổng PayOS', raw: null };
    }
  }

  /*
   * Tra trạng thái một lệnh chi: GET /v1/payouts/{payoutId}. `state`: succeeded (mọi giao dịch SUCCEEDED) · failed (có giao dịch lỗi / bị từ chối / huỷ / hoàn)
   * · processing (còn đang xử lý) · unknown (không tra được — giữ nguyên, thử lại lần sau).
   */
  async getPayout(payoutId: string): Promise<{ state: 'succeeded' | 'failed' | 'processing' | 'unknown'; detail: string }> {
    if (!this.isPayoutConfigured) return { state: 'unknown', detail: 'PayOS payout chưa được cấu hình' };
    try {
      const res = await fetch(`${this.env.EF_PAYOS_API_URL}/v1/payouts/${encodeURIComponent(payoutId)}`, {
        method: 'GET',
        headers: { 'x-client-id': this.env.EF_PAYOS_PAYOUT_CLIENT_ID, 'x-api-key': this.env.EF_PAYOS_PAYOUT_API_KEY },
        signal: AbortSignal.timeout(10_000),
      });
      const json = (await res.json()) as { code?: string; desc?: string; data?: { approvalState?: string; transactions?: Array<{ state?: string }> } };
      if (!res.ok || json.code !== '00' || !json.data) return { state: 'unknown', detail: json.desc ?? `HTTP ${res.status}` };
      return PayosService.payoutState(json.data.approvalState, (json.data.transactions ?? []).map((t) => t.state ?? ''));
    } catch (err) {
      this.logger.warn({ err: err instanceof Error ? err.message : err, payoutId }, 'Tra cứu lệnh chi PayOS lỗi');
      return { state: 'unknown', detail: 'Không gọi được cổng PayOS' };
    }
  }

  /* Gộp approvalState + state từng giao dịch → trạng thái của hệ thống. Chữ lạ coi là "đang xử lý" (an toàn: không tự đánh đã trả / lỗi). */
  static payoutState(approvalState: string | undefined, txStates: string[]): { state: 'succeeded' | 'failed' | 'processing'; detail: string } {
    const bad = /FAIL|REJECT|CANCEL|REVERS|ERROR/i;
    const approval = approvalState ?? '';
    if (bad.test(approval)) return { state: 'failed', detail: `approvalState=${approval}` };
    const badTx = txStates.find((s) => bad.test(s));
    if (badTx) return { state: 'failed', detail: `state=${badTx}` };
    if (txStates.length > 0 && txStates.every((s) => /^SUCCEED/i.test(s))) return { state: 'succeeded', detail: 'SUCCEEDED' };
    return { state: 'processing', detail: txStates.join(',') || approval };
  }

  private signPayout(body: Record<string, unknown>): string {
    return this.sign(PayosService.payoutCanonical(body), this.env.EF_PAYOS_PAYOUT_CHECKSUM_KEY);
  }

  /*
   * Chuỗi ký của PAYOUT — KHÁC payment-request (tài liệu "Kiểm tra dữ liệu với signature", mục lệnh chi): khoá sắp alphabet ở MỌI cấp, mỗi cặp là
   * `encodeURIComponent(khoá)=encodeURIComponent(giá trị)` nối bằng `&`; null/undefined → chuỗi rỗng; mảng / đối tượng lồng nhau → JSON.stringify sau khi sắp khoá (giữ thứ tự mảng).
   * (Payment-request KHÔNG mã hoá URI — đừng dùng chung hàm.)
   */
  static payoutCanonical(data: Record<string, unknown>): string {
    const deepSort = (v: unknown): unknown => {
      if (Array.isArray(v)) return (v as unknown[]).map(deepSort);
      if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, deepSort((v as Record<string, unknown>)[k])]));
      return v;
    };
    const str = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(deepSort(v)) : typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' ? String(v) : '');
    return Object.keys(data)
      .sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(str(data[k]))}`)
      .join('&');
  }

  /*
   * Tra cứu số dư tài khoản chi (payout account): GET /v1/payouts-account/balance.
   */
  async payoutBalance(): Promise<{ balance: bigint | null; code: string; message: string }> {
    if (!this.isPayoutConfigured) {
      return { balance: null, code: 'NOT_CONFIGURED', message: 'PayOS payout chưa được cấu hình' };
    }

    try {
      const res = await fetch(`${this.env.EF_PAYOS_API_URL}/v1/payouts-account/balance`, {
        method: 'GET',
        headers: {
          'x-client-id': this.env.EF_PAYOS_PAYOUT_CLIENT_ID,
          'x-api-key': this.env.EF_PAYOS_PAYOUT_API_KEY,
        },
        signal: AbortSignal.timeout(10_000),
      });

      const json = (await res.json()) as { code?: string; message?: string; data?: { balance?: number } };

      return {
        balance: json.data?.balance !== undefined ? BigInt(json.data.balance) : null,
        code: json.code ?? '99',
        message: json.message ?? '',
      };
    } catch (err) {
      this.logger.warn({ err: err instanceof Error ? err.message : err }, 'Tra cứu số dư payout account PayOS lỗi');
      return { balance: null, code: '99', message: 'Không gọi được cổng PayOS' };
    }
  }

  private sign(data: string, checksumKey: string): string {
    return createHmac('sha256', checksumKey).update(Buffer.from(data, 'utf8')).digest('hex');
  }
}
