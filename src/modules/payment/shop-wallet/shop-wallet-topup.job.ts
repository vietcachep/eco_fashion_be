import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ShopWalletTopupSettleService } from './shop-wallet-topup-settle.service';

/*
 * Job dò nạp cọc PayOS (PLAN-0041 §6.4 G): mỗi 2 phút hỏi PayOS các khoản còn mở và quét đuôi 72 giờ — bắt tiền về khi MẤT webhook.
 * Cờ `running` chống chạy chồng trong tiến trình; nhiều worker vẫn an toàn nhờ CAS last_checked_at (reconcileOne) và khoá dòng khoản nạp.
 * Lỗi bị nuốt + log: job là đường tự lành, không được làm chết worker; lượt sau chạy lại.
 */
@Injectable()
export class WalletTopupJobs {
  private readonly logger = new Logger(WalletTopupJobs.name);
  private running = false;

  constructor(private readonly settle: ShopWalletTopupSettleService) {}

  @Interval(2 * 60_000)
  async reconcileWalletTopups(): Promise<{ checked: number; credited: number; closed: number } | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const r = await this.settle.reconcilePending();
      if (r.credited + r.closed > 0) this.logger.warn(r, 'Dò nạp cọc PayOS: đã ghi có / đóng khoản');
      return r;
    } catch (err) {
      this.logger.error({ err }, 'Job dò nạp cọc PayOS lỗi');
      return null;
    } finally {
      this.running = false;
    }
  }
}
