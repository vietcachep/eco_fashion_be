/*
 * Gian hàng mẫu (PLAN-0017 Track D) — sàn đa gian hàng: mỗi shop bán một vài ngành gốc. FITLY Official (SHOP-000001) là shop chính chủ
 * của sàn, đã có sẵn từ migration. Mỗi shop có CHỦ (vai shop_owner) và vài shop có NHÂN VIÊN (shop_staff) để thử phân quyền vendor.
 *   Chủ shop / nhân viên đăng nhập web quản trị (cổng vendor) bằng email dưới đây, mật khẩu Vendor123456!
 * Có 1 shop CHỜ DUYỆT và 1 shop BỊ KHOÁ để màn quản lý shop của sàn có đủ trạng thái (sản phẩm shop bị khoá bị ẩn khỏi trang khách).
 */
import type { SeedShopDef } from './types';

export const DEMO_VENDOR_PASSWORD = 'Vendor123456!';

/* Mã ngành GỐC (department) — đồng bộ với file `dept/<slug>.ts` */
export const DEPT_SLUGS = [
  'dien-thoai-phu-kien',
  'may-tinh-thiet-bi-dien-tu',
  'nha-cua-doi-song',
  'sac-dep-suc-khoe',
  'giay-dep-tui-xach',
  'dong-ho-phu-kien',
  'the-thao-da-ngoai',
  'me-be',
  'sach-van-phong-pham',
  'thuc-pham-do-uong',
  'thu-cung',
  'o-to-xe-may',
] as const;

export const SHOPS = [
  { slug: 'fitly-official', code: 'SHOP-000001', name: 'FITLY Official', description: 'Gian hàng chính chủ của sàn FITLY: thời trang nam nữ thiết kế tối giản, kèm một số mặt hàng công nghệ, gia dụng và làm đẹp chọn lọc.', status: 'approved', commissionRate: 0, owner: { email: 'admin@ecofashion.vn', fullName: 'Quản trị viên', phone: '0900000000' }, depts: ['dien-thoai-phu-kien', 'nha-cua-doi-song', 'sac-dep-suc-khoe'], emoji: '🛍️', theme: 'coral' },
  { slug: 'techzone-vn', code: 'SHOP-000002', name: 'TechZone Việt Nam', description: 'Chuyên điện thoại, laptop, thiết bị công nghệ chính hãng. Bảo hành toàn quốc, trả góp 0%, giao nhanh 2 giờ nội thành.', status: 'approved', commissionRate: 6, owner: { email: 'techzone@ecofashion.vn', fullName: 'Nguyễn Minh Khoa', phone: '0903100001' }, staff: [{ email: 'nv.techzone@ecofashion.vn', fullName: 'Lê Hoàng Nam', phone: '0903100002' }], depts: ['dien-thoai-phu-kien', 'may-tinh-thiet-bi-dien-tu'], emoji: '💻', theme: 'indigo' },
  { slug: 'mobile-hub', code: 'SHOP-000003', name: 'Mobile Hub', description: 'Phụ kiện điện thoại đủ loại: ốp lưng, cáp sạc, sạc dự phòng, tai nghe. Giá sỉ lẻ rõ ràng, đổi trả 30 ngày.', status: 'approved', commissionRate: 8, owner: { email: 'mobilehub@ecofashion.vn', fullName: 'Trần Quốc Bảo', phone: '0903100003' }, depts: ['dien-thoai-phu-kien'], emoji: '📱', theme: 'sky' },
  { slug: 'gia-dung-thong-minh', code: 'SHOP-000004', name: 'Gia Dụng Thông Minh', description: 'Đồ điện gia dụng và dụng cụ nhà bếp cho gia đình hiện đại: nồi chiên, máy xay, robot hút bụi, bếp từ.', status: 'approved', commissionRate: 7, owner: { email: 'giadung@ecofashion.vn', fullName: 'Phạm Thị Lan', phone: '0903100004' }, staff: [{ email: 'nv.giadung@ecofashion.vn', fullName: 'Vũ Thanh Hà', phone: '0903100005' }], depts: ['nha-cua-doi-song'], emoji: '🍳', theme: 'orange' },
  { slug: 'nha-xinh-decor', code: 'SHOP-000005', name: 'Nhà Xinh Decor', description: 'Nội thất và đồ trang trí phong cách Bắc Âu, tối giản: sofa, bàn ghế, đèn, tranh, chăn ga gối nệm.', status: 'approved', commissionRate: 9, owner: { email: 'nhaxinh@ecofashion.vn', fullName: 'Đặng Thu Hương', phone: '0903100006' }, depts: ['nha-cua-doi-song'], emoji: '🛋️', theme: 'brown' },
  { slug: 'beauty-box-vn', code: 'SHOP-000006', name: 'Beauty Box', description: 'Mỹ phẩm chính hãng Hàn – Nhật – Việt: chăm sóc da, trang điểm, chăm sóc tóc, nước hoa. Tem phụ tiếng Việt đầy đủ.', status: 'approved', commissionRate: 10, owner: { email: 'beautybox@ecofashion.vn', fullName: 'Ngô Mỹ Linh', phone: '0903100007' }, staff: [{ email: 'nv.beautybox@ecofashion.vn', fullName: 'Bùi Ngọc Anh', phone: '0903100008' }], depts: ['sac-dep-suc-khoe'], emoji: '💄', theme: 'rose' },
  { slug: 'healthy-life', code: 'SHOP-000007', name: 'Healthy Life', description: 'Thực phẩm chức năng, vitamin, đồ ăn lành mạnh và thiết bị chăm sóc sức khoẻ tại nhà.', status: 'approved', commissionRate: 9, owner: { email: 'healthy@ecofashion.vn', fullName: 'Lý Thanh Tùng', phone: '0903100009' }, depts: ['sac-dep-suc-khoe', 'thuc-pham-do-uong'], emoji: '🌿', theme: 'emerald' },
  { slug: 'sneaker-station', code: 'SHOP-000008', name: 'Sneaker Station', description: 'Giày thể thao, sneaker, sandal chính hãng và phụ kiện chăm sóc giày. Check size miễn phí, đổi size 7 ngày.', status: 'approved', commissionRate: 8, owner: { email: 'sneaker@ecofashion.vn', fullName: 'Hoàng Đức Thắng', phone: '0903100010' }, depts: ['giay-dep-tui-xach', 'the-thao-da-ngoai'], emoji: '👟', theme: 'navy' },
  { slug: 'bag-and-co', code: 'SHOP-000009', name: 'Bag & Co', description: 'Túi xách, balo, vali thời trang và du lịch. Chất liệu bền, bảo hành đường may 12 tháng.', status: 'approved', commissionRate: 9, owner: { email: 'bagco@ecofashion.vn', fullName: 'Trương Mai Phương', phone: '0903100011' }, depts: ['giay-dep-tui-xach'], emoji: '👜', theme: 'fuchsia' },
  { slug: 'time-lab', code: 'SHOP-000010', name: 'Time Lab Watches', description: 'Đồng hồ nam nữ, kính mắt, trang sức bạc. Hàng chính hãng, có hộp và thẻ bảo hành quốc tế.', status: 'approved', commissionRate: 7, owner: { email: 'timelab@ecofashion.vn', fullName: 'Cao Văn Đạt', phone: '0903100012' }, depts: ['dong-ho-phu-kien'], emoji: '⌚', theme: 'slate' },
  { slug: 'sport-planet', code: 'SHOP-000011', name: 'Sport Planet', description: 'Dụng cụ tập gym, yoga, xe đạp, đồ dã ngoại cắm trại. Tư vấn chọn đồ theo bộ môn.', status: 'approved', commissionRate: 8, owner: { email: 'sportplanet@ecofashion.vn', fullName: 'Đinh Quang Huy', phone: '0903100013' }, depts: ['the-thao-da-ngoai'], emoji: '🏋️', theme: 'lime' },
  { slug: 'baby-land', code: 'SHOP-000012', name: 'BabyLand', description: 'Mọi thứ cho mẹ và bé: sữa, tã, đồ chơi an toàn, xe đẩy, quần áo sơ sinh. Cam kết hàng chính hãng.', status: 'approved', commissionRate: 8, owner: { email: 'babyland@ecofashion.vn', fullName: 'Phan Thị Hoa', phone: '0903100014' }, depts: ['me-be'], emoji: '🧸', theme: 'mint' },
  { slug: 'book-cafe', code: 'SHOP-000013', name: 'Book & Cafe', description: 'Sách văn học, kỹ năng, thiếu nhi và văn phòng phẩm. Tặng bookmark cho mọi đơn hàng.', status: 'approved', commissionRate: 6, owner: { email: 'bookcafe@ecofashion.vn', fullName: 'Lâm Gia Bảo', phone: '0903100015' }, depts: ['sach-van-phong-pham'], emoji: '📚', theme: 'sand' },
  { slug: 'ngon-viet', code: 'SHOP-000014', name: 'Ngon Việt', description: 'Đặc sản và đồ ăn vặt ba miền, cà phê, trà. Nguồn gốc rõ ràng, hạn dùng dài, đóng gói kỹ.', status: 'approved', commissionRate: 8, owner: { email: 'ngonviet@ecofashion.vn', fullName: 'Mai Xuân Quý', phone: '0903100016' }, depts: ['thuc-pham-do-uong'], emoji: '🍜', theme: 'amber' },
  { slug: 'pet-world', code: 'SHOP-000015', name: 'Pet World', description: 'Thức ăn, đồ chơi, phụ kiện cho chó mèo. Thương hiệu nhập khẩu và nội địa, giao nhanh trong ngày.', status: 'approved', commissionRate: 8, owner: { email: 'petworld@ecofashion.vn', fullName: 'Đỗ Khánh Vy', phone: '0903100017' }, depts: ['thu-cung'], emoji: '🐶', theme: 'teal' },
  { slug: 'auto-moto-pro', code: 'SHOP-000016', name: 'Auto Moto Pro', description: 'Phụ kiện ô tô, xe máy, mũ bảo hiểm, đồ chăm sóc xe. Hỗ trợ lắp đặt tại cửa hàng nội thành.', status: 'approved', commissionRate: 7, owner: { email: 'automoto@ecofashion.vn', fullName: 'Hà Văn Lộc', phone: '0903100018' }, depts: ['o-to-xe-may'], emoji: '🏍️', theme: 'violet' },
  { slug: 'cua-hang-moi', code: 'SHOP-000017', name: 'Cửa Hàng Mới Mở', description: 'Gian hàng vừa đăng ký, đang chờ sàn duyệt hồ sơ.', status: 'pending', commissionRate: 10, owner: { email: 'cuahangmoi@ecofashion.vn', fullName: 'Vương Thị Ngân', phone: '0903100019' }, depts: [], emoji: '🏪', theme: 'sky' },
  { slug: 'hang-nhai-24h', code: 'SHOP-000018', name: 'Hàng Nhái 24h', description: 'Gian hàng đã bị khoá do bán hàng giả (dữ liệu mẫu để thử luồng khoá shop — sản phẩm bị ẩn khỏi trang khách).', status: 'suspended', commissionRate: 10, owner: { email: 'hangnhai@ecofashion.vn', fullName: 'Tạ Văn Gian', phone: '0903100020' }, depts: ['thuc-pham-do-uong'], emoji: '🚫', theme: 'slate' },
] as const satisfies readonly SeedShopDef[];

export type ShopSlug = (typeof SHOPS)[number]['slug'];
