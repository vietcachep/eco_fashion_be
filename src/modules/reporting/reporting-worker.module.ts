import { Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ReportingModule } from './reporting.module';
import { ReportingService } from './reporting.service';

/* Worker reporting: tính lại hôm nay mỗi 5 phút; chốt hôm qua lúc 00:05 giờ VN (container chạy UTC → 17:05 UTC). */
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

  @Cron('0 5 17 * * *')
  async closeYesterday(): Promise<void> {
    const yesterday = ReportingService.vnDay(new Date(Date.now() - 86_400_000));
    try {
      await this.reports.recomputeDay(yesterday);
      this.logger.log({ day: yesterday }, 'Đã chốt daily_sales hôm qua');
    } catch (err) {
      this.logger.error({ err, day: yesterday }, 'Chốt daily_sales hôm qua lỗi');
    }
  }
}

@Module({ imports: [ReportingModule], providers: [DailySalesJob] })
export class ReportingWorkerModule {}
