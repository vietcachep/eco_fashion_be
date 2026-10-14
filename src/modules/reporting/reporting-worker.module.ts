import { Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ReportingModule } from './reporting.module';
import { ReportingService } from './reporting.service';

/* Số ngày tính lại mỗi đêm (hôm qua + 13 ngày trước đó = 14 ngày) — phủ độ trễ thu tiền COD / cập nhật trạng thái thanh toán. */
const CLOSE_WINDOW_DAYS = 14;

/* Worker reporting: tính lại hôm nay mỗi 5 phút; lúc 00:05 giờ VN (container chạy UTC → 17:05 UTC) tính lại 14 ngày gần nhất. */
@Injectable()
export class DailySalesJob implements OnModuleInit {
  private readonly logger = new Logger(DailySalesJob.name);
  private running = false;

  constructor(private readonly reports: ReportingService) {}

  async onModuleInit(): Promise<void> {
    // Khởi động: bảo đảm 35 ngày gần nhất có số liệu — phủ "tháng này" của dashboard và đơn demo trải ~3 tuần
    // (máy mới seed xong vẫn có biểu đồ tháng đúng; 35 truy vấn gộp, chạy dưới 1 giây).
    const today = ReportingService.vnDay(new Date());
    const from = ReportingService.vnDay(new Date(Date.now() - 34 * 86_400_000));
    try {
      await this.reports.recomputeRange(from, today);
    } catch (err) {
      this.logger.error({ err }, 'Tính daily_sales lúc khởi động lỗi');
    }
  }

  @Cron('0 */5 * * * *')
  async today(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.reports.recomputeDay(ReportingService.vnDay(new Date()));
    } catch (err) {
      this.logger.error({ err }, 'Tính daily_sales hôm nay lỗi');
    } finally {
      this.running = false;
    }
  }

  /*
   * Chốt hàng đêm: tính lại 14 NGÀY gần nhất (hôm qua lùi về 13 ngày trước đó), không chỉ hôm qua. Lý do: doanh thu chỉ tính đơn
   * đã `paid`, mà đơn COD tạo ngày 1 có thể giao/thu tiền ngày 4 — nếu chỉ chốt hôm qua thì ngày 1 không bao giờ được cập nhật
   * và doanh thu COD bị thấp. recomputeDay là upsert (idempotent) nên tính lại nhiều lần an toàn; 14 truy vấn gộp/đêm vẫn nhẹ.
   * Mỗi ngày bọc try/catch riêng để một ngày lỗi không chặn các ngày còn lại.
   */
  @Cron('0 5 17 * * *')
  async closeRecentDays(): Promise<void> {
    const to = ReportingService.vnDay(new Date(Date.now() - 86_400_000));
    const from = ReportingService.vnDay(new Date(Date.now() - CLOSE_WINDOW_DAYS * 86_400_000));
    let failed = 0;
    for (const day of ReportingService.periods(from, to, 'day')) {
      try {
        await this.reports.recomputeDay(day);
      } catch (err) {
        failed++;
        this.logger.error({ err, day }, 'Chốt daily_sales ngày gần đây lỗi');
      }
    }
    this.logger.log({ from, to, failed }, 'Đã chốt daily_sales các ngày gần đây');
  }
}

@Module({ imports: [ReportingModule], providers: [DailySalesJob] })
export class ReportingWorkerModule {}
