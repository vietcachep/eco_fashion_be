export const USER_DIRECTORY_GATEWAY = Symbol('USER_DIRECTORY_GATEWAY');

/* Snapshot người dùng cho module khác chép vào chứng từ (đơn, đánh giá) — không phải entity identity. */
export interface UserSnapshot {
  userId: string;
  email: string;
  fullName: string;
  phone: string | null;
  roleCode: string;
  status: string;
}

/*
 * Cổng tra cứu người dùng cho module khác (order, review, ai…) — identity cài đặt, chỉ ĐỌC.
 * Trả null khi không có; không ném lỗi để module gọi tự quyết định 404/409.
 */
export interface UserDirectoryGateway {
  findSnapshot(userId: string): Promise<UserSnapshot | null>;
  findSnapshots(userIds: string[]): Promise<Map<string, UserSnapshot>>;
  /* Id của mọi nhân viên đang active có quyền `permissionCode` — dùng gửi thông báo nội bộ. */
  staffUserIdsWithPermission(permissionCode: string): Promise<string[]>;
}
