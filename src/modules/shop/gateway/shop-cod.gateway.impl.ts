import { Injectable } from '@nestjs/common';
import type { ShopCodGateway } from '@common/gateway/shop-cod.gateway';
import { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';
import { ShopAuditLogService } from '../audit/shop-audit-log.service';

/* Implement ShopCodGateway: cập nhật Shop.codEnabled và ghi nhật ký */
@Injectable()
export class ShopCodGatewayImpl implements ShopCodGateway {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: ShopAuditLogService,
  ) {}

  /* Đổi cờ COD bằng một câu UPDATE có điều kiện (không đọc-rồi-ghi) — trả true chỉ khi trạng thái thực sự đổi. */
  async setCodEnabled(shopId: string, enabled: boolean, tx?: Tx): Promise<boolean> {
    const db = tx ?? this.prisma;
    const r = await db.shop.updateMany({ where: { id: shopId, codEnabled: !enabled }, data: { codEnabled: enabled } });
    if (r.count === 0) return false; // shop không tồn tại hoặc đã ở trạng thái đó

    await this.auditLog.write(tx ?? null, null, { action: enabled ? 'COD_ENABLED' : 'COD_DISABLED', entityType: 'Shop', entityId: shopId, before: { codEnabled: !enabled }, after: { codEnabled: enabled } });
    return true;
  }
}
