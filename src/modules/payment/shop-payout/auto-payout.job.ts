import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SETTING_KEY } from '@modules/system/enums/setting-keys';
import { SystemQueryApi } from '@modules/system/queryapi/system.queryapi';
import { ShopPayoutService } from './shop-payout.service';

/* Múi giờ vận hành (UTC+7, không có giờ mùa hè) — mốc ngày của kỳ đối soát tính theo giờ Việt Nam. */
const VN_OFFSET_MS = 7 * 3_600_000;
const DAY_MS = 24 * 3_600_000;

/* 00:00 giờ Việt Nam của ngày chứa `now` (dưới dạng instant UTC). */
export function startOfVnDay(now: Date): Date {
  return new Date(Math.floor((now.getTime() + VN_OFFSET_MS) / DAY_MS) * DAY_MS - VN_OFFSET_MS);
}

export type AutoPayoutOutcome =
  | { status: 'disabled' }
  | { status: 'payos_not_configured' }
  | { status: 'empty_period' }
  | { status: 'ran'; periodStart: Date; periodEnd: Date; created: number };

/*
 * Cron CHI TRẢ TỰ ĐỘNG (PLAN-0018) — mỗi ngày 02:00 Asia/Ho_Chi_Minh, chạy trong WORKER.
 * Tự gọi ShopPayoutService.run cho kỳ [mốc kết thúc kỳ gần nhất .. 00:00 hôm nay (hết hôm qua)]; chưa có kỳ nào thì kỳ đầu là [00:00 hôm qua .. 00:00 hôm nay]
 * (đơn đủ điều kiện cũ hơn vẫn được gom — `run` chọn đơn theo hạn đổi trả, không theo ngày bắt đầu kỳ). Đơn PayOS lẫn COD đi cùng MỘT đường.
 *  - Chỉ chạy khi setting `payout.auto_enabled` = true (mặc định true, sửa ở màn tham số) VÀ PayOS chi đã cấu hình khoá; thiếu một trong hai ⇒ bỏ qua êm (log).
 *    Bản thân cron KHÔNG tự chi nếu chưa có khoá: thiếu khoá `run` vẫn tạo kỳ `pending` cho kế toán chuyển tay, nên cron chặn hẳn để không tạo kỳ ngoài ý muốn.
 *  - Idempotent: kỳ mới nối ngay sau kỳ gần nhất nên chạy lại cùng ngày ⇒ khoảng rỗng ⇒ bỏ qua; nếu vẫn chạy chồng (nhiều worker) thì UNIQUE(shop, kỳ) + dòng đối soát
 *    UNIQUE(orderCode, kind) + idempotency-key PayOS (= mã kỳ) bảo đảm không tạo trùng, không chi đôi. Kỳ rỗng (không shop nào có dòng) không tạo gì.
 *  - Audit (actor null = hệ thống) + outbox PAYOUT_* + thông báo thành viên shop do ShopPayoutService/listener sẵn có ghi. Không throw ra ngoài (lỗi chỉ log);
 *    nút chạy tay `POST /admin/payouts/run` giữ nguyên để chạy bù.
 */
@Injectable()
export class AutoPayoutJob {
  private readonly logger = new Logger(AutoPayoutJob.name);
  private running = false;

  constructor(
    private readonly payouts: ShopPayoutService,
    private readonly system: SystemQueryApi,
  ) {}

  @Cron('0 0 2 * * *', { name: 'auto-payout', timeZone: 'Asia/Ho_Chi_Minh' })
  async tick(): Promise<void> {
    if (this.running) return; // cron lặp khi lượt trước còn chạy (chi PayOS chậm)
    this.running = true;
    try {
      const r = await this.runOnce(new Date());
      if (r.status === 'ran') this.logger.log({ created: r.created, periodStart: r.periodStart.toISOString(), periodEnd: r.periodEnd.toISOString() }, 'Đã chạy đối soát chi trả shop tự động');
      else this.logger.log({ status: r.status }, 'Bỏ qua đối soát chi trả tự động');
    } catch (err) {
      this.logger.error({ err }, 'Đối soát chi trả tự động lỗi');
    } finally {
      this.running = false;
    }
  }

  /* Một lượt chạy (tách khỏi @Cron để test được và để gọi bù nếu cần). `now` truyền vào cho tất định. */
  async runOnce(now: Date): Promise<AutoPayoutOutcome> {
    if (!(await this.system.settingBool(SETTING_KEY.PAYOUT_AUTO_ENABLED))) return { status: 'disabled' };
    if (!this.payouts.payoutConfigured) return { status: 'payos_not_configured' };

    const periodEnd = startOfVnDay(now);
    const latest = await this.payouts.latestPeriodEnd();
    const periodStart = latest ?? new Date(periodEnd.getTime() - DAY_MS);
    if (periodStart.getTime() >= periodEnd.getTime()) return { status: 'empty_period' };

    const created = await this.payouts.run({ periodStart, periodEnd }, null);
    return { status: 'ran', periodStart, periodEnd, created: created.length };
  }
}
