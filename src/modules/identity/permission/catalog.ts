/*
 * CATALOG QUYỀN — nguồn sự thật của mọi mã quyền `module.resource.action` (PLAN-0002).
 * - Là DỮ LIỆU THAM CHIẾU trong code: `scripts/sync-permissions.ts` (service `migrate` của compose) đồng bộ vào
 *   bảng identity.permissions + gán preset cho vai hệ thống — máy mới dựng lên là đủ quyền, không có bước tay.
 * - Guard chỉ so mã; FE dùng cùng mã để ẩn/hiện nút. Thêm màn mới = thêm mã ở đây + preset vai + tick plan.
 * - KHÔNG xoá mã đã phát hành (route cũ có thể còn dùng); muốn bỏ thì đặt `deprecated: true`.
 */
export interface PermissionDef {
  code: string;
  module: string;
  description: string;
  deprecated?: boolean;
}

function p(module: string, code: string, description: string): PermissionDef {
  return { code: `${module}.${code}`, module, description };
}

export const PERMISSION_CATALOG: readonly PermissionDef[] = [
  // identity
  p('identity', 'user.read', 'Xem danh sách người dùng / nhân viên'),
  p('identity', 'user.create', 'Tạo tài khoản nhân viên'),
  p('identity', 'user.update', 'Sửa hồ sơ, đổi vai, đặt lại mật khẩu nhân viên'),
  p('identity', 'user.lock', 'Khoá / mở khoá tài khoản'),
  p('identity', 'role.read', 'Xem vai và bộ quyền'),
  p('identity', 'role.update', 'Sửa preset quyền của vai'),
  p('identity', 'permission.assign', 'Cấp / chặn quyền riêng cho từng người'),
  p('identity', 'audit.read', 'Xem audit log và lịch sử đăng nhập'),
  // catalog
  p('catalog', 'category.read', 'Xem ngành hàng (khu quản trị)'),
  p('catalog', 'category.manage', 'Tạo / sửa / ẩn ngành hàng'),
  { ...p('catalog', 'brand.manage', 'Tạo / sửa thương hiệu'), deprecated: true }, // đề tài một cửa hàng — không có thương hiệu
  p('catalog', 'attribute.manage', 'Tạo / sửa bộ thuộc tính (size, màu, chất liệu)'),
  p('catalog', 'collection.manage', 'Tạo / sửa bộ sưu tập'),
  // product
  p('product', 'product.read', 'Xem sản phẩm (khu quản trị)'),
  p('product', 'product.create', 'Tạo sản phẩm'),
  p('product', 'product.update', 'Sửa sản phẩm, biến thể, ảnh, giá'),
  p('product', 'product.publish', 'Đăng bán / ẩn sản phẩm'),
  p('product', 'product.delete', 'Xoá mềm sản phẩm'),
  p('product', 'inventory.read', 'Xem tồn kho'),
  p('product', 'inventory.receive', 'Lập phiếu nhập kho'),
  p('product', 'inventory.adjust', 'Điều chỉnh / kiểm kê tồn kho'),
  // order
  p('order', 'order.read', 'Xem đơn hàng'),
  p('order', 'order.status.update', 'Xác nhận / đóng gói / giao / hoàn tất đơn'),
  p('order', 'order.cancel', 'Huỷ đơn thay khách'),
  p('order', 'return.read', 'Xem yêu cầu đổi trả'),
  p('order', 'return.process', 'Duyệt / từ chối / hoàn tất đổi trả'),
  // payment
  p('payment', 'payment.read', 'Xem giao dịch thanh toán'),
  p('payment', 'transfer.confirm', 'Xác nhận chuyển khoản (đối soát)'),
  p('payment', 'refund.create', 'Tạo yêu cầu hoàn tiền'),
  p('payment', 'refund.process', 'Duyệt / thực hiện hoàn tiền'),
  p('payment', 'method.manage', 'Bật / tắt phương thức thanh toán'),
  // promotion
  p('promotion', 'promotion.read', 'Xem mã giảm giá'),
  p('promotion', 'promotion.manage', 'Tạo / sửa / bật tắt mã giảm giá'),
  // review
  p('review', 'review.read', 'Xem đánh giá (khu quản trị)'),
  p('review', 'review.moderate', 'Duyệt / ẩn đánh giá'),
  p('review', 'review.reply', 'Trả lời đánh giá thay cửa hàng'),
  // system
  p('system', 'setting.read', 'Xem tham số vận hành'),
  p('system', 'setting.update', 'Sửa tham số vận hành'),
  p('system', 'banner.manage', 'Quản lý banner trang chủ'),
  p('system', 'province.manage', 'Quản lý tỉnh/thành + phí ship'),
  p('system', 'notification.send', 'Gửi thông báo tới khách'),
  // reporting
  p('reporting', 'dashboard.read', 'Xem dashboard tổng quan'),
  p('reporting', 'revenue.read', 'Xem báo cáo doanh thu'),
  p('reporting', 'inventory.read', 'Xem báo cáo tồn kho'),
  // ai
  p('ai', 'knowledge.manage', 'Quản lý kho tri thức chatbot'),
  p('ai', 'support.read', 'Xem yêu cầu hỗ trợ từ chatbot'),
  p('ai', 'support.resolve', 'Đóng yêu cầu hỗ trợ'),
  p('ai', 'chat.read', 'Xem hội thoại chatbot (đã che PII)'),
  p('ai', 'insight.read', 'Xem gợi ý / nhận xét AI cho vận hành'),
  p('ai', 'copy.create', 'Dùng AI soạn mô tả / phản hồi'),
  p('ai', 'usage.read', 'Xem chi phí & hạn mức AI'),
  p('ai', 'moderation.read', 'Xem nhãn AI đề xuất kiểm duyệt'),
];

export const ALL_PERMISSION_CODES: readonly string[] = PERMISSION_CATALOG.map((d) => d.code);

export function codesOfModules(...modules: string[]): readonly string[] {
  const set = new Set(modules);
  return PERMISSION_CATALOG.filter((d) => set.has(d.module)).map((d) => d.code);
}

export function codes(...list: string[]): readonly string[] {
  for (const c of list) {
    if (!ALL_PERMISSION_CODES.includes(c)) throw new Error(`Mã quyền không có trong catalog: ${c}`);
  }
  return list;
}

/*
 * PRESET VAI — preset chỉ là điểm xuất phát; admin sửa được trong DB (`role_permissions`) và cấp/chặn riêng
 * từng người (`user_permissions`). `perms:sync --sync-roles` chỉ THÊM mã còn thiếu vào vai, không gỡ mã admin đã thêm tay.
 */
export const ROLE_CODES = {
  ADMIN: 'admin',
  MANAGER: 'manager',
  SALES: 'sales',
  WAREHOUSE: 'warehouse',
  ACCOUNTANT: 'accountant',
  MARKETING: 'marketing',
  CUSTOMER: 'customer',
} as const;
export type RoleCode = (typeof ROLE_CODES)[keyof typeof ROLE_CODES];

export const STAFF_ROLE_CODES: readonly RoleCode[] = [
  ROLE_CODES.ADMIN,
  ROLE_CODES.MANAGER,
  ROLE_CODES.SALES,
  ROLE_CODES.WAREHOUSE,
  ROLE_CODES.ACCOUNTANT,
  ROLE_CODES.MARKETING,
];

export const ROLE_PRESETS: Record<RoleCode, { name: string; description: string; codes: readonly string[] }> = {
  admin: { name: 'Quản trị viên', description: 'Chủ cửa hàng — toàn quyền', codes: ALL_PERMISSION_CODES },
  manager: {
    name: 'Quản lý cửa hàng',
    description: 'Ngành hàng, sản phẩm, tồn kho, đơn, khuyến mãi, đánh giá, báo cáo',
    codes: [
      ...codesOfModules('catalog', 'product', 'order', 'promotion', 'review', 'reporting'),
      ...codes('identity.user.read', 'payment.payment.read', 'system.setting.read', 'system.banner.manage', 'ai.insight.read', 'ai.copy.create', 'ai.moderation.read', 'ai.usage.read'),
    ],
  },
  sales: {
    name: 'Bán hàng & CSKH',
    description: 'Xử lý đơn, trả lời đánh giá, hỗ trợ khách từ chatbot',
    codes: codes(
      'product.product.read',
      'product.inventory.read',
      'order.order.read',
      'order.order.status.update',
      'order.order.cancel',
      'order.return.read',
      'order.return.process',
      'payment.payment.read',
      'review.review.read',
      'review.review.reply',
      'ai.support.read',
      'ai.support.resolve',
      'ai.chat.read',
      'ai.copy.create',
      'system.notification.send',
    ),
  },
  warehouse: {
    name: 'Nhân viên kho',
    description: 'Tồn kho, nhập kho, đóng gói / giao đơn',
    codes: codes('product.product.read', 'product.inventory.read', 'product.inventory.receive', 'product.inventory.adjust', 'order.order.read', 'order.order.status.update', 'order.return.read', 'reporting.inventory.read'),
  },
  accountant: {
    name: 'Kế toán',
    description: 'Thanh toán, đối soát chuyển khoản, hoàn tiền, doanh thu',
    codes: codes('order.order.read', 'order.return.read', 'payment.payment.read', 'payment.transfer.confirm', 'payment.refund.create', 'payment.refund.process', 'reporting.dashboard.read', 'reporting.revenue.read', 'ai.usage.read'),
  },
  marketing: {
    name: 'Marketing',
    description: 'Banner, khuyến mãi, bộ sưu tập, nội dung AI, kho tri thức chatbot',
    codes: codes('catalog.category.read', 'catalog.collection.manage', 'product.product.read', 'promotion.promotion.read', 'promotion.promotion.manage', 'system.banner.manage', 'system.notification.send', 'ai.knowledge.manage', 'ai.copy.create', 'ai.insight.read', 'reporting.dashboard.read'),
  },
  customer: { name: 'Khách hàng', description: 'Mua sắm — không có quyền quản trị', codes: [] },
};
