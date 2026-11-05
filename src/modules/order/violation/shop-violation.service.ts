import { Inject, Injectable } from '@nestjs/common';
import { NOTIFICATION_GATEWAY, NotificationGateway } from '@common/gateway/notification.gateway';
import { USER_DIRECTORY_GATEWAY, UserDirectoryGateway } from '@common/gateway/user-directory.gateway';
import { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';
import { PageResponse } from '@common/response/api-response';
import { ShopQueryApi } from '../../shop/queryapi/shop.queryapi';
import { SETTING_KEY } from '../../system/enums/setting-keys';
import { SystemQueryApi } from '../../system/queryapi/system.queryapi';
import { VIOLATION_KIND_LABEL, VIOLATION_WINDOW_DAYS, type ViolationKind } from '../foundation/order.constants';

const DAY = 86_400_000;

export interface ShopViolationView {
  id: string;
  orderCode: string;
  kind: string;
  kindLabel: string;
  points: number;
  createdAt: string;
}

export interface ShopViolationSummary {
  /* Tổng điểm trong VIOLATION_WINDOW_DAYS ngày gần nhất. */
  points: number;
  windowDays: number;
  /* Ngưỡng nhắc quản lý xem xét khoá (setting `shop.violation_suspend_points`). */
  threshold: number;
}

/*
 * Điểm vi phạm xử lý đơn của gian hàng (PLAN-0027 §2.1). `record` IDEMPOTENT nhờ UNIQUE(order_code, kind): job SLA chạy lại / sự kiện outbox phát lại không cộng điểm hai lần.
 * Tổng điểm 30 ngày ≥ `shop.violation_suspend_points` ⇒ nhắc quản lý (quyền `supplier.shop.suspend`) xem xét khoá — tối đa MỘT lần / 7 ngày / shop (claim bằng upsert có điều kiện
 * nên nhiều worker không nhắc đôi). Chỉ GHI ĐIỂM + NHẮC — không tự khoá shop (quyết định của con người).
 */
@Injectable()
export class ShopViolationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly system: SystemQueryApi,
    private readonly shops: ShopQueryApi,
    @Inject(USER_DIRECTORY_GATEWAY) private readonly users: UserDirectoryGateway,
    @Inject(NOTIFICATION_GATEWAY) private readonly notify: NotificationGateway,
  ) {}

  /* Ghi điểm trong tx của caller. Trả true nếu điểm MỚI được ghi (false = đã có điểm cùng loại cho đơn này). */
  async record(tx: Tx, v: { shopId: string; orderCode: string; kind: ViolationKind; points?: number }): Promise<boolean> {
    const created = await tx.shopViolation.createMany({ data: [{ shopId: v.shopId, orderCode: v.orderCode, kind: v.kind, points: v.points ?? 1 }], skipDuplicates: true });
    if (created.count === 0) return false;
    await this.alertIfOverThreshold(tx, v.shopId);
    return true;
  }

  private async alertIfOverThreshold(tx: Tx, shopId: string): Promise<void> {
    const threshold = await this.system.settingNumber(SETTING_KEY.SHOP_VIOLATION_SUSPEND_POINTS);
    if (threshold <= 0) return;
    const agg = await tx.shopViolation.aggregate({ where: { shopId, createdAt: { gte: new Date(Date.now() - VIOLATION_WINDOW_DAYS * DAY) } }, _sum: { points: true } });
    const total = agg._sum.points ?? 0;
    if (total < threshold) return;
    // Claim: chỉ worker nào ghi/cập nhật được dòng mốc (chưa có hoặc đã quá 7 ngày) mới nhắc.
    const claimed = await tx.$executeRaw`INSERT INTO "order"."shop_violation_alerts" (shop_id, alerted_at) VALUES (${shopId}::uuid, now())
      ON CONFLICT (shop_id) DO UPDATE SET alerted_at = now() WHERE "order"."shop_violation_alerts".alerted_at < now() - interval '7 days'`; // 7 ngày = VIOLATION_ALERT_INTERVAL_DAYS (hằng số trong SQL: tham số hoá "N * interval" dễ lệch kiểu)
    if (claimed === 0) return;
    const [managers, shop] = await Promise.all([this.users.staffUserIdsWithPermission('supplier.shop.suspend'), this.shops.findBrief(shopId)]);
    const name = shop?.name ?? shopId;
    await this.notify.notifyMany(
      managers.map((userId) => ({
        userId,
        type: 'system',
        title: `Gian hàng ${name} vi phạm ${total} điểm trong ${VIOLATION_WINDOW_DAYS} ngày`,
        content: `Đạt ngưỡng ${threshold} điểm vi phạm xử lý đơn (quá hạn xác nhận/giao, huỷ vì hết hàng/sai giá…). Hãy xem lịch sử vi phạm và xem xét khoá gian hàng nếu cần.`,
        link: `/shop/shops/${shopId}`,
      })),
      tx,
    );
  }

  async list(shopId: string, page: number, size: number): Promise<PageResponse<ShopViolationView>> {
    const where = { shopId };
    const [rows, total] = await Promise.all([
      this.prisma.shopViolation.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * size, take: size }),
      this.prisma.shopViolation.count({ where }),
    ]);
    return PageResponse.of(
      rows.map((r) => ({ id: r.id, orderCode: r.orderCode, kind: r.kind, kindLabel: VIOLATION_KIND_LABEL[r.kind as ViolationKind] ?? r.kind, points: r.points, createdAt: r.createdAt.toISOString() })),
      page,
      size,
      total,
    );
  }

  async summary(shopId: string): Promise<ShopViolationSummary> {
    const [agg, threshold] = await Promise.all([
      this.prisma.shopViolation.aggregate({ where: { shopId, createdAt: { gte: new Date(Date.now() - VIOLATION_WINDOW_DAYS * DAY) } }, _sum: { points: true } }),
      this.system.settingNumber(SETTING_KEY.SHOP_VIOLATION_SUSPEND_POINTS),
    ]);
    return { points: agg._sum.points ?? 0, windowDays: VIOLATION_WINDOW_DAYS, threshold };
  }
}
