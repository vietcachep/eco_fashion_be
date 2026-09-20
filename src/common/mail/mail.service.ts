import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { createTransport, Transporter } from 'nodemailer';
import { ENV } from '@config/config.module';
import type { Env } from '@config/env';
import { QUEUE } from '../queue/queue.module';

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export const MAIL_JOB = 'send-mail';

/*
 * Gửi email: API chỉ ENQUEUE (BullMQ queue `mail`), worker mới gọi SMTP — request không bao giờ chờ mạng.
 * `sendNow` chỉ worker/processor dùng. Dev: mailpit trong compose (không auth, cổng 1025 trong network).
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: Transporter | null = null;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @InjectQueue(QUEUE.MAIL) private readonly queue: Queue<MailMessage>,
  ) {}

  async enqueue(message: MailMessage): Promise<void> {
    await this.queue.add(MAIL_JOB, message, { removeOnComplete: true });
  }

  async sendNow(message: MailMessage): Promise<void> {
    if (!this.transporter) {
      this.transporter = createTransport({
        host: this.env.EF_MAIL_HOST,
        port: this.env.EF_MAIL_PORT,
        secure: this.env.EF_MAIL_SECURE,
        auth: this.env.EF_MAIL_USER
          ? { user: this.env.EF_MAIL_USER, pass: this.env.EF_MAIL_PASSWORD }
          : undefined,
      });
    }
    await this.transporter.sendMail({ from: this.env.EF_MAIL_FROM, ...message });
    this.logger.log({ to: message.to, subject: message.subject }, 'Đã gửi email');
  }
}
