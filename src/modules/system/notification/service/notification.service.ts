import { Inject, Injectable } from '@nestjs/common';
import { NotFoundException } from '@common/exception/business.exception';
import { NotificationGateway, NotifyCommand } from '@common/gateway/notification.gateway';
import { USER_DIRECTORY_GATEWAY, UserDirectoryGateway } from '@common/gateway/user-directory.gateway';
import { PrismaService } from '@common/prisma/prisma.service';
import { Prisma, Tx } from '@common/prisma/types';
import { PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { SystemAuditLogService } from '../../audit/system-audit-log.service';
import { SYSTEM_AUDIT, SYSTEM_ERR } from '../../foundation/system.constants';

export interface NotificationResponse {
  id: string;
  type: string;
  title: string;
  content: string | null;
  link: string | null;
  payload: unknown;
  readAt: string | null;
  createdAt: string;
}

/*
 * Thông báo trong-app. Cài NotificationGateway (common): module nghiệp vụ gọi `notify(cmd, tx)` TRONG transaction của mình
 * (đơn đổi trạng thái và thông báo cùng sống cùng chết). `notifyStaff(permission, ...)` gửi cho mọi nhân viên có quyền
 * (kho sắp hết, đơn mới, đổi trả) — id lấy qua UserDirectoryGateway.
 */
@Injectable()
export class NotificationService implements NotificationGateway {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: SystemAuditLogService,
    @Inject(USER_DIRECTORY_GATEWAY) private readonly users: UserDirectoryGateway,
  ) {}

  async notify(cmd: NotifyCommand, tx?: Tx): Promise<void> {
    await (tx ?? this.prisma).notification.create({
      data: { userId: cmd.userId, type: cmd.type, title: cmd.title, content: cmd.content ?? null, link: cmd.link ?? null, payload: cmd.payload ? (JSON.parse(JSON.stringify(cmd.payload)) as Prisma.InputJsonValue) : undefined },
    });
  }

  async notifyMany(cmds: NotifyCommand[], tx?: Tx): Promise<void> {
    if (cmds.length === 0) return;
    await (tx ?? this.prisma).notification.createMany({
      data: cmds.map((c) => ({ userId: c.userId, type: c.type, title: c.title, content: c.content ?? null, link: c.link ?? null, payload: c.payload ? (JSON.parse(JSON.stringify(c.payload)) as Prisma.InputJsonValue) : undefined })),
    });
  }

  async notifyStaff(permissionCode: string, cmd: Omit<NotifyCommand, 'userId'>, tx?: Tx): Promise<number> {
    const ids = await this.users.staffUserIdsWithPermission(permissionCode);
    await this.notifyMany(ids.map((userId) => ({ ...cmd, userId })), tx);
    return ids.length;
  }

  async listMine(actor: AuthenticatedActor, page: number, size: number, unreadOnly: boolean): Promise<PageResponse<NotificationResponse> & { unreadCount: number }> {
    const where = { userId: actor.userId, ...(unreadOnly ? { readAt: null } : {}) };
    const [items, total, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * size, take: size }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { userId: actor.userId, readAt: null } }),
    ]);
    const pageRes = PageResponse.of(
      items.map((n) => ({ id: n.id, type: n.type, title: n.title, content: n.content, link: n.link, payload: n.payload, readAt: n.readAt?.toISOString() ?? null, createdAt: n.createdAt.toISOString() })),
      page,
      size,
      total,
    );
    return Object.assign(pageRes, { unreadCount });
  }

  async markRead(actor: AuthenticatedActor, id: string): Promise<void> {
    const r = await this.prisma.notification.updateMany({ where: { id, userId: actor.userId, readAt: null }, data: { readAt: new Date() } });
    if (r.count === 0 && !(await this.prisma.notification.findFirst({ where: { id, userId: actor.userId } }))) throw new NotFoundException(SYSTEM_ERR.NOTIFICATION_NOT_FOUND, 'Không tìm thấy thông báo');
  }

  async markAllRead(actor: AuthenticatedActor): Promise<number> {
    const r = await this.prisma.notification.updateMany({ where: { userId: actor.userId, readAt: null }, data: { readAt: new Date() } });
    return r.count;
  }

  /* Admin gửi thông báo tay cho một nhóm khách (system.notification.send). */
  async broadcast(actor: AuthenticatedActor, input: { userIds: string[]; title: string; content: string | null; link: string | null }): Promise<number> {
    const ids = [...new Set(input.userIds)];
    await this.prisma.$transaction(async (tx) => {
      await this.notifyMany(ids.map((userId) => ({ userId, type: 'system', title: input.title, content: input.content, link: input.link })), tx);
      await this.audit.write(tx, actor, { action: SYSTEM_AUDIT.NOTIFICATION_SENT, entityType: 'notification', after: { title: input.title, recipients: ids.length } });
    });
    return ids.length;
  }

  async purgeRead(olderThan: Date): Promise<number> {
    const r = await this.prisma.notification.deleteMany({ where: { readAt: { not: null, lt: olderThan } } });
    return r.count;
  }
}
