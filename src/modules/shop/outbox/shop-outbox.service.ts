import { Injectable } from '@nestjs/common';
import { OutboxEventInput, writeOutboxEvent } from '@common/outbox/outbox';
import { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';

/*
 * Outbox của module shop → bảng shop.outbox_events. Ghi TRONG transaction nghiệp vụ; worker
 * (ShopWorkerModule) relay sau commit tới listener qua EventEmitter `outbox.shop.<EVENT_TYPE>`.
 * Chưa có listener ở PLAN-0014 bước 1-4 — product/order (bước 5+) sẽ đăng ký khi cần phản ứng theo
 * trạng thái gian hàng (vd ẩn sản phẩm khi shop bị khoá).
 */
@Injectable()
export class ShopOutboxService {
  constructor(private readonly prisma: PrismaService) {}

  async publish(tx: Tx | null, input: OutboxEventInput): Promise<void> {
    const client = tx ?? this.prisma;
    await writeOutboxEvent(client.shopOutboxEvent, input);
  }

  /*
   * Listener gọi để đảm bảo idempotent: INSERT processed_events (unique event_id+handler) — trùng → đã xử lý,
   * trả false để listener bỏ qua. Gọi CÙNG transaction với side effect.
   */
  async markProcessed(tx: Tx, eventId: string, eventType: string, handler: string): Promise<boolean> {
    const existing = await tx.shopProcessedEvent.findUnique({ where: { eventId_handler: { eventId, handler } } });
    if (existing) return false;
    await tx.shopProcessedEvent.create({ data: { eventId, eventType, handler } });
    return true;
  }
}
