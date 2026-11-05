import { Injectable, Logger, Module } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ShippingModule } from './shipping.module';
import { ShippingService } from './shipment/shipping.service';

/* Worker phục hồi inbox/unknown và dò trạng thái; nhiều tiến trình được bảo vệ bằng lease + khoá DB. */
@Injectable()
class ShippingJobs {
  private running = false;
  private readonly logger = new Logger(ShippingJobs.name);
  constructor(private readonly shipping: ShippingService) {}
  @Interval(5 * 60_000)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try { await this.shipping.runJobs(); } catch { this.logger.warn('Job vận chuyển chưa xử lý xong, sẽ tự thử lại'); } finally { this.running = false; }
  }
}
@Module({ imports: [ShippingModule], providers: [ShippingJobs] })
export class ShippingWorkerModule {}
