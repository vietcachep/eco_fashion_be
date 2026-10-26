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
  p('catalog', 'dynamic_attribute.read', 'Xem thuộc tính động cho ngành hàng (PLAN-0016)'),
  p('catalog', 'dynamic_attribute.manage', 'Tạo / sửa thuộc tính động cho ngành hàng (PLAN-0016)'),
  p('catalog', 'collection.manage', 'Tạo / sửa bộ sưu tập'),
  // product
  p('product', 'product.read', 'Xem sản phẩm (khu quản trị)'),
  { ...p('product', 'product.create', 'Tạo sản phẩm'), deprecated: true }, // PLAN-0021: việc của CHỦ SHOP — sàn không làm thay
  { ...p('product', 'product.update', 'Sửa sản phẩm, biến thể, ảnh, giá'), deprecated: true }, // PLAN-0021: việc của CHỦ SHOP — sàn không làm thay
  p('product', 'product.publish', 'Đăng bán / ẩn sản phẩm'),
  { ...p('product', 'product.delete', 'Xoá mềm sản phẩm'), deprecated: true }, // PLAN-0021: việc của CHỦ SHOP — sàn không làm thay
  p('product', 'inventory.read', 'Xem tồn kho'),
  { ...p('product', 'inventory.receive', 'Lập phiếu nhập kho'), deprecated: true }, // PLAN-0021: việc của CHỦ SHOP — sàn không làm thay
  { ...p('product', 'inventory.adjust', 'Điều chỉnh / kiểm kê tồn kho'), deprecated: true }, // PLAN-0021: việc của CHỦ SHOP — sàn không làm thay
  // order
  p('order', 'order.read', 'Xem đơn hàng'),
  { ...p('order', 'order.status.update', 'Xác nhận / đóng gói / giao / hoàn tất đơn'), deprecated: true }, // PLAN-0021: việc của CHỦ SHOP — sàn không làm thay
  p('order', 'order.cancel', 'Huỷ đơn thay khách'),
  p('order', 'return.read', 'Xem yêu cầu đổi trả'),
  p('order', 'return.process', 'Duyệt / từ chối / hoàn tất đổi trả'),
  // payment
  p('payment', 'payment.read', 'Xem giao dịch thanh toán'),
  p('payment', 'transfer.confirm', 'Xác nhận chuyển khoản (LỊCH SỬ — PLAN-0018 đã bỏ chuyển khoản tay, không còn endpoint dùng mã này)'),
  p('payment', 'refund.create', 'Tạo yêu cầu hoàn tiền'),
  p('payment', 'refund.process', 'Duyệt / thực hiện hoàn tiền'),
  p('payment', 'method.manage', 'Bật / tắt phương thức thanh toán'),
  // promotion
  p('promotion', 'promotion.read', 'Xem mã giảm giá'),
  p('promotion', 'promotion.manage', 'Tạo / sửa / bật tắt mã giảm giá'),
  // review
  p('review', 'review.read', 'Xem đánh giá (khu quản trị)'),
  p('review', 'review.moderate', 'Duyệt / ẩn đánh giá'),
  { ...p('review', 'review.reply', 'Trả lời đánh giá thay cửa hàng'), deprecated: true }, // PLAN-0021: việc của CHỦ SHOP — sàn không làm thay
  // system
  p('system', 'setting.read', 'Xem tham số vận hành'),
  p('system', 'setting.update', 'Sửa tham số vận hành'),
  p('system', 'banner.manage', 'Quản lý banner trang chủ'),
  p('system', 'province.manage', 'Quản lý tỉnh/thành + phí ship'),
  p('system', 'notification.send', 'Gửi thông báo tới khách'),
  p('system', 'contact.read', 'Xem tin khách gửi SÀN (form Liên hệ) và giám sát tin gửi các gian hàng'),
  p('system', 'contact.reply', 'Trả lời tin khách gửi SÀN (tin gửi shop do shop tự trả lời)'),
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
  // supplier (PLAN-0014) — nhân viên SÀN (admin/manager hiện có) thao tác trên MỌI gian hàng
  p('supplier', 'shop.read', 'Xem danh sách / chi tiết mọi gian hàng'),
  p('supplier', 'shop.approve', 'Duyệt gian hàng mới đăng ký'),
  p('supplier', 'shop.suspend', 'Khoá gian hàng vi phạm'),
  p('supplier', 'shop.reject', 'Từ chối gian hàng đăng ký'),
  p('supplier', 'shop.commission', 'Sửa % hoa hồng của một gian hàng'),
  // shop (PLAN-0014) — chủ/nhân viên gian hàng tự quản CHÍNH gian hàng của mình. Kiểm bằng ShopContextGuard
  // đọc ShopMember.roleId (KHÔNG qua PermissionGuard toàn cục — vai scope=shop không gán vào User.roleId).
  p('shop', 'profile.read', 'Xem hồ sơ gian hàng của mình'),
  p('shop', 'profile.update', 'Sửa hồ sơ gian hàng của mình'),
  p('shop', 'product.read', 'Xem sản phẩm của gian hàng mình'),
  p('shop', 'product.manage', 'Thêm / sửa sản phẩm của gian hàng mình'),
  p('shop', 'review.read', 'Xem đánh giá sản phẩm của gian hàng mình'),
  p('shop', 'review.reply', 'Trả lời đánh giá sản phẩm của gian hàng mình'),
  p('shop', 'staff.read', 'Xem nhân viên gian hàng của mình'),
  p('shop', 'staff.invite', 'Thêm nhân viên vào gian hàng của mình (tạo tài khoản nhân viên)'), // mã giữ tên cũ "invite" — đã gán cho vai/FE
  p('shop', 'staff.update', 'Đổi vai nhân viên gian hàng của mình'),
  p('shop', 'staff.remove', 'Gỡ nhân viên khỏi gian hàng của mình'),
  // PLAN-0017 — vendor tự vận hành gian hàng: đơn · kho · khuyến mãi · báo cáo · ví · đối soát (chỉ dữ liệu CỦA shop mình)
  p('shop', 'order.read', 'Xem đơn hàng của gian hàng mình'),
  p('shop', 'order.update', 'Xác nhận / đóng gói / giao / huỷ đơn của gian hàng mình'),
  p('shop', 'inventory.read', 'Xem tồn kho sản phẩm của gian hàng mình'),
  p('shop', 'inventory.manage', 'Nhập kho / điều chỉnh tồn sản phẩm của gian hàng mình'),
  p('shop', 'promotion.read', 'Xem mã giảm giá của gian hàng mình'),
  p('shop', 'promotion.manage', 'Tạo / sửa / bật tắt mã giảm giá của gian hàng mình'),
  p('shop', 'report.read', 'Xem báo cáo doanh thu / đơn / tồn của gian hàng mình'),
  p('shop', 'contact.read', 'Xem tin nhắn khách gửi gian hàng mình (hỏi sản phẩm / đơn)'),
  p('shop', 'contact.reply', 'Trả lời tin nhắn khách gửi gian hàng mình'),
  p('shop', 'payout.read', 'Xem các kỳ đối soát / chi trả của gian hàng mình'),
  // PLAN-0017/0018 — nhân viên SÀN xem + chạy đối soát chi trả cho MỌI gian hàng (khác mã với shop.payout.*); PLAN-0018 bỏ ví quỹ COD nên không còn mã wallet
  p('supplier', 'payout.read', 'Xem các kỳ đối soát / chi trả của mọi gian hàng'),
  p('supplier', 'payout.process', 'Chạy kỳ đối soát và chi trả cho gian hàng'),
  // PLAN-0020 — ví đặt cọc COD: shop xem ví + nộp cọc; sàn xem mọi ví, duyệt/từ chối khoản nộp và chỉnh ví
  p('shop', 'wallet.read', 'Xem ví đặt cọc COD và lịch sử của gian hàng mình'),
  p('shop', 'wallet.deposit_request', 'Gửi yêu cầu nộp tiền đặt cọc COD của gian hàng mình'),
  p('supplier', 'wallet.read', 'Xem ví đặt cọc COD và các khoản nộp cọc của mọi gian hàng'),
  p('supplier', 'wallet.approve', 'Đối chiếu và duyệt / từ chối khoản nộp cọc COD của gian hàng (không chỉnh được số dư)'),
  p('supplier', 'wallet.adjust', 'Chỉnh tay số dư ví đặt cọc COD của gian hàng (có lý do) — chỉ Admin, vì tự cộng / trừ tiền không cần chứng từ'),
];

/* Mã còn hiệu lực (bỏ mã deprecated) — vai admin = toàn bộ tập này. */
export const ALL_PERMISSION_CODES: readonly string[] = PERMISSION_CATALOG.filter((d) => !d.deprecated).map((d) => d.code);

export function codesOfModules(...modules: string[]): readonly string[] {
  const set = new Set(modules);
  return PERMISSION_CATALOG.filter((d) => set.has(d.module) && !d.deprecated).map((d) => d.code);
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
  ACCOUNTANT: 'accountant',
  MARKETING: 'marketing',
  CUSTOMER: 'customer',
  /* PLAN-0014 — vai scope=shop, KHÔNG bao giờ gán vào User.roleId (chỉ dùng qua ShopMember.roleId). */
  SHOP_OWNER: 'shop_owner',
  SHOP_STAFF: 'shop_staff',
} as const;
export type RoleCode = (typeof ROLE_CODES)[keyof typeof ROLE_CODES];

/* platform = vai áp dụng toàn hệ thống, gán vào User.roleId; shop = vai chỉ có nghĩa TRONG một gian hàng,
   gán vào ShopMember.roleId (PLAN-0014) — identity.roles.scope lưu giá trị này. */
export type RoleScope = 'platform' | 'shop';

/* Vai NHÂN VIÊN NỀN TẢNG hợp lệ cho `POST /admin/users` (CreateStaffRequest.roleCode) — CHỦ Ý không có
   shop_owner/shop_staff: vai đó gán qua ShopMember (module shop mời nhân viên bằng email), không qua đây. */
export const STAFF_ROLE_CODES: readonly RoleCode[] = [
  ROLE_CODES.ADMIN,
  ROLE_CODES.MANAGER,
  ROLE_CODES.SALES,
  ROLE_CODES.ACCOUNTANT,
  ROLE_CODES.MARKETING,
];

/* Vai scope=shop hợp lệ cho ShopMember.roleId (module shop resolve từ roleCode trong request, không nhận roleId trần). */
export const SHOP_ROLE_CODES: readonly RoleCode[] = [ROLE_CODES.SHOP_OWNER, ROLE_CODES.SHOP_STAFF];

export const ROLE_PRESETS: Record<RoleCode, { name: string; description: string; codes: readonly string[]; scope: RoleScope }> = {
  admin: { name: 'Quản trị viên', description: 'Chủ cửa hàng — toàn quyền', codes: ALL_PERMISSION_CODES, scope: 'platform' },
  manager: {
    name: 'Quản lý cửa hàng',
    description: 'Ngành hàng, sản phẩm, tồn kho, đơn, khuyến mãi, đánh giá, báo cáo, duyệt gian hàng',
    codes: [
      ...codesOfModules('catalog', 'product', 'order', 'promotion', 'review', 'reporting'),
      ...codes(
        'identity.user.read',
        'payment.payment.read',
        'system.setting.read',
        'system.banner.manage',
        'ai.insight.read',
        'ai.copy.create',
        'ai.moderation.read',
        'ai.usage.read',
        'supplier.shop.read',
        'supplier.shop.approve',
        'supplier.shop.suspend',
        'supplier.shop.reject',
        'supplier.payout.read',
        'supplier.wallet.read',
        'system.contact.read',
      ),
    ],
    scope: 'platform',
  },
  sales: {
    name: 'Chăm sóc khách hàng',
    description: 'Phân xử khiếu nại / đổi trả, huỷ đơn khi tranh chấp, kiểm duyệt đánh giá, hỗ trợ khách từ chatbot — sàn không bán hàng',
    codes: codes(
      'product.product.read',
      'order.order.read',
      'order.order.cancel',
      'order.return.read',
      'order.return.process',
      'payment.payment.read',
      'review.review.read',
      'review.review.moderate',
      'ai.support.read',
      'ai.support.resolve',
      'ai.chat.read',
      'ai.copy.create',
      'system.notification.send',
      'system.contact.read',
      'system.contact.reply',
    ),
    scope: 'platform',
  },
  accountant: {
    name: 'Kế toán',
    description: 'Thanh toán, hoàn tiền, đối soát chi trả shop, ví đặt cọc COD, doanh thu',
    codes: codes('order.order.read', 'order.return.read', 'payment.payment.read', 'payment.transfer.confirm', 'payment.refund.create', 'payment.refund.process', 'reporting.dashboard.read', 'reporting.revenue.read', 'ai.usage.read', 'supplier.payout.read', 'supplier.payout.process', 'supplier.wallet.read', 'supplier.wallet.approve'),
    scope: 'platform',
  },
  marketing: {
    name: 'Marketing',
    description: 'Banner, khuyến mãi, bộ sưu tập, nội dung AI, kho tri thức chatbot',
    codes: codes('catalog.category.read', 'catalog.collection.manage', 'product.product.read', 'promotion.promotion.read', 'promotion.promotion.manage', 'system.banner.manage', 'system.notification.send', 'ai.knowledge.manage', 'ai.copy.create', 'ai.insight.read', 'reporting.dashboard.read'),
    scope: 'platform',
  },
  customer: { name: 'Khách hàng', description: 'Mua sắm — không có quyền quản trị', codes: [], scope: 'platform' },
  // PLAN-0014 — vai scope=shop: gán qua ShopMember.roleId (module shop), KHÔNG hiện trong STAFF_ROLE_CODES,
  // không cấp/chặn qua /admin/users. Quyền của vai này chỉ có hiệu lực TRONG gian hàng mà ShopMember trỏ tới.
  shop_owner: {
    name: 'Chủ gian hàng',
    description: 'Toàn quyền trên gian hàng của mình: hồ sơ, nhân viên, sản phẩm, đơn, kho, khuyến mãi, đánh giá, báo cáo, ví, đối soát',
    codes: codesOfModules('shop'),
    scope: 'shop',
  },
  shop_staff: {
    name: 'Nhân viên gian hàng',
    description: 'Vận hành hằng ngày: xem hồ sơ/nhân viên, xem + sửa sản phẩm, xử lý đơn, xem kho, trả lời đánh giá — không đụng nhân sự, khuyến mãi, ví, đối soát',
    codes: codes('shop.profile.read', 'shop.staff.read', 'shop.product.read', 'shop.product.manage', 'shop.order.read', 'shop.order.update', 'shop.inventory.read', 'shop.review.read', 'shop.review.reply'),
    scope: 'shop',
  },
};
