import type { Tx } from '../prisma/types';

export const NOTIFICATION_GATEWAY = Symbol('NOTIFICATION_GATEWAY');

export interface NotifyCommand {
  userId: string;
  /* Nhóm để FE chọn icon/lọc: order | payment | promotion | review | support | system | ai */
  type: string;
  title: string;
  content?: string | null;
  /* Đường dẫn tương đối trên web (bán hàng hoặc quản trị) để bấm vào là tới đúng chỗ. */
  link?: string | null;
  payload?: Record<string, unknown> | null;
}

/*
 * Cổng ghi thông báo trong-app cho user — module system cài đặt (bảng system.notifications).
 * Gọi được TRONG transaction của module nghiệp vụ (nhận `tx`) để đơn/thanh toán đổi trạng thái
 * và thông báo cùng sống cùng chết; email/push thì đi đường outbox → worker.
 */
export interface NotificationGateway {
  notify(cmd: NotifyCommand, tx?: Tx): Promise<void>;
  notifyMany(cmds: NotifyCommand[], tx?: Tx): Promise<void>;
}
