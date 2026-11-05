import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { WORKER_HEARTBEAT_INTERVAL_MS, WorkerHeartbeatService } from './worker-heartbeat.service';

/*
 * Chỉ WORKER nạp (qua SystemWorkerModule — API không chạy job nền): ghi nhịp tim vào Redis mỗi 5 giây để `/health` biết worker còn sống.
 * Nhịp đầu ghi ngay lúc khởi động (không chờ chu kỳ đầu) để `/health` xanh nhanh sau deploy.
 * Không chạy chồng; lỗi Redis chỉ cảnh báo MỘT lần cho tới khi hồi phục (tránh ngập log khi Redis sập) — không bao giờ làm worker thoát.
 * Giới hạn: đây là nhịp của TIẾN TRÌNH worker (event loop còn quay), chưa phải nhịp từng job — theo dõi từng job là phần `runTrackedJob` của PLAN-0029 §2.4.
 */
@Injectable()
export class WorkerHeartbeatJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(WorkerHeartbeatJob.name);
  private running = false;
  private failing = false;

  constructor(private readonly heartbeat: WorkerHeartbeatService) {}

  onApplicationBootstrap(): void {
    void this.tick();
  }

  @Interval(WORKER_HEARTBEAT_INTERVAL_MS)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.heartbeat.beat();
      if (this.failing) {
        this.failing = false;
        this.logger.log('Đã ghi lại được nhịp tim worker (Redis hồi phục)');
      }
    } catch (err) {
      if (!this.failing) {
        this.failing = true;
        this.logger.warn({ err }, 'Không ghi được nhịp tim worker vào Redis — /health sẽ báo worker DOWN/UNKNOWN cho tới khi ghi lại được');
      }
    } finally {
      this.running = false;
    }
  }
}
