import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { WorkerModule } from './worker.module';

/*
 * Entrypoint worker: application context (không HTTP). Processor BullMQ + @Cron tự chạy khi context lên.
 * SIGTERM/SIGINT → đóng gọn (hook của Nest gọi onModuleDestroy của BullMQ/Redis/TypeORM).
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  const logger = app.get(Logger);
  app.useLogger(logger);
  app.enableShutdownHooks();
  await app.init();
  logger.log('EcoFashion worker khởi động — BullMQ (default, mail, ai) + outbox relay + job định kỳ');
}

void bootstrap();
