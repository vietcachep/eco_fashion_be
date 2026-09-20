import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE } from '../queue/queue.module';
import { MailMessage, MailService } from './mail.service';

/*
 * Processor queue `mail` (chỉ worker nạp): gọi SMTP thật. Lỗi → BullMQ retry theo defaultJobOptions.
 */
@Processor(QUEUE.MAIL, { concurrency: 5 })
export class MailProcessor extends WorkerHost {
  private readonly logger = new Logger(MailProcessor.name);

  constructor(private readonly mail: MailService) {
    super();
  }

  async process(job: Job<MailMessage>): Promise<void> {
    try {
      await this.mail.sendNow(job.data);
    } catch (err) {
      this.logger.warn({ err, jobId: job.id, to: job.data.to }, 'Gửi email lỗi — BullMQ sẽ thử lại');
      throw err;
    }
  }
}
