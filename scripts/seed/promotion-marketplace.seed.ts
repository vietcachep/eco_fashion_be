/*
 * SEED mã giảm giá sàn đa gian hàng (PLAN-0017) — bổ sung cho 5 mã cũ ở `promotion.seed.ts` (FREESHIP, GIAM10, DAM100K, CHAOBAN, HETHAN):
 *   - voucher SÀN   (scope 'platform', shopId NULL): áp trên tổng đơn nhiều shop, sàn chịu giảm — freeship, %, số tiền cố định, theo ngành,
 *     dịp lễ/sinh nhật, mã nội bộ nhập tay (isPublic=false), 1 mã đã hết hạn + 1 mã sắp hết lượt để demo trạng thái.
 *   - voucher SHOP  (scope 'shop', shopId = gian hàng): chỉ áp cho đơn con của đúng shop phát hành, shop chịu giảm. Mỗi shop đã duyệt 2–3 mã
 *     (tiền tố riêng, mã duy nhất toàn hệ thống); shop bị khoá có 1 mã tạo từ trước; shop chờ duyệt không có mã.
 * Lưu ý về mục tiêu `category`: dòng giỏ so khớp `targetRef` với slug NGÀNH LÁ của sản phẩm (xem PromotionService.discountOf — so sánh bằng ===,
 * sản phẩm chỉ gán vào ngành lá) nên mã "theo ngành gốc" phải liệt kê TẤT CẢ ngành lá của ngành gốc đó, không đặt slug ngành gốc.
 * Idempotent: tìm theo mã (không phân biệt hoa thường, isDeleted=false) → có rồi thì bỏ qua, KHÔNG ghi đè (kể cả usedCount). Shop tra theo slug —
 * cần chạy sau `marketplace.seed` (tạo gian hàng); thiếu shop thì in cảnh báo và bỏ qua shop đó.
 * Ngày hiệu lực tính theo hôm nay lúc chạy seed: bắt đầu trong quá khứ (để đơn lịch sử còn dùng được), kết thúc ở tương lai.
 */
import type { PrismaClient } from '../../src/generated/prisma/client';
import { DEPARTMENTS } from './data/dept';
import { SHOPS, type ShopSlug } from './data/shops';

const DAY = 86_400_000;

/* 5 mã đã có ở promotion.seed.ts — không được trùng. */
const LEGACY_CODES = ['FREESHIP', 'GIAM10', 'DAM100K', 'CHAOBAN', 'HETHAN'];
/* 7 ngành thời trang cũ (catalog.seed.ts) — sản phẩm của FITLY Official, không nằm trong data/dept. */
const FASHION_LEAVES = ['ao-thun', 'ao-so-mi', 'quan-jean', 'quan-short', 'vay', 'dam', 'ao-khoac'];

type PromoType = 'percentage' | 'fixed_amount' | 'free_shipping';

interface VoucherSpec {
  code: string;
  type: PromoType;
  /* % (1–100) hoặc số tiền VND (> 0); free_shipping bỏ qua (luôn 0) */
  value?: number;
  /* trần giảm — chỉ có nghĩa với percentage */
  maxDiscount?: number;
  minOrder: number;
  /* tổng lượt toàn hệ thống; bỏ trống = không giới hạn */
  limit?: number;
  /* số lượt đã dùng khi tạo (giả lập để demo trạng thái "sắp hết lượt"; không kèm dòng promotion_usages) */
  used?: number;
  perUser?: number;
  /* slug NGÀNH LÁ — có thì appliesTo='category', không thì 'all' */
  targets?: readonly string[];
  /* cụm từ chỉ nhóm hàng áp dụng, dùng sinh tên/mô tả mã shop ("phụ kiện điện thoại") */
  label?: string;
  /* tên hiển thị (bắt buộc với mã sàn; mã shop tự sinh nếu bỏ trống) */
  name?: string;
  /* câu mô tả mở đầu (thay cho câu "Áp dụng cho …" tự sinh) */
  note?: string;
  /* hiệu lực: bắt đầu `startsAgo` ngày TRƯỚC hôm nay, kết thúc `endsIn` ngày SAU hôm nay (âm = đã hết hạn) */
  startsAgo: number;
  endsIn: number;
  /* true = isPublic=false: không hiện phiếu trên web, khách phải nhập tay */
  hidden?: boolean;
}

interface ShopPlan {
  shop: ShopSlug;
  /* tên gọi ngắn trong tên mã ("tại TechZone") */
  short: string;
  /* 3–8 ký tự IN HOA lấy từ tên shop; mọi mã của shop phải bắt đầu bằng tiền tố này */
  prefix: string;
  vouchers: readonly VoucherSpec[];
}

/* Ngành lá của một ngành gốc — đọc từ DSL dữ liệu mẫu để không lệch với ngành thật được seed. */
function leavesOf(deptSlug: string): string[] {
  const dept = DEPARTMENTS.find((d) => d.slug === deptSlug);
  if (!dept) throw new Error(`Không có ngành gốc '${deptSlug}' trong data/dept`);
  return dept.categories.map((c) => c.slug);
}

// ---------------------------------------------------------------------------------------------------------------------
// Voucher SÀN
// ---------------------------------------------------------------------------------------------------------------------
const PLATFORM: readonly VoucherSpec[] = [
  // --- toàn sàn ---
  { code: 'SHIP299', name: 'Freeship toàn sàn đơn từ 299k', note: 'Miễn phí vận chuyển cho mọi gian hàng.', type: 'free_shipping', minOrder: 299_000, perUser: 5, startsAgo: 30, endsIn: 120 },
  { code: 'SALE15', name: 'Giảm 15% toàn sàn', note: 'Áp dụng cho mọi sản phẩm trên sàn.', type: 'percentage', value: 15, maxDiscount: 100_000, minOrder: 500_000, limit: 2000, perUser: 2, startsAgo: 30, endsIn: 90 },
  { code: 'GIAM200K', name: 'Giảm 200.000₫ cho đơn lớn', note: 'Dành cho đơn hàng giá trị cao, áp dụng toàn sàn.', type: 'fixed_amount', value: 200_000, minOrder: 2_000_000, limit: 500, perUser: 1, startsAgo: 30, endsIn: 100 },
  // --- theo NGÀNH GỐC (liệt kê toàn bộ ngành lá) ---
  { code: 'DIENTHOAI50K', name: 'Giảm 50.000₫ điện thoại & phụ kiện', note: 'Áp dụng cho ngành Điện thoại & Phụ kiện.', type: 'fixed_amount', value: 50_000, minOrder: 500_000, targets: leavesOf('dien-thoai-phu-kien'), limit: 1000, perUser: 2, startsAgo: 21, endsIn: 75 },
  { code: 'MEBE12', name: 'Giảm 12% mẹ & bé', note: 'Áp dụng cho ngành Mẹ & Bé: sữa, tã, đồ chơi, xe đẩy, quần áo sơ sinh.', type: 'percentage', value: 12, maxDiscount: 80_000, minOrder: 250_000, targets: leavesOf('me-be'), limit: 800, perUser: 2, startsAgo: 21, endsIn: 80 },
  { code: 'SACDEP15', name: 'Giảm 15% sắc đẹp & sức khoẻ', note: 'Áp dụng cho ngành Sắc đẹp & Sức khoẻ: chăm sóc da, trang điểm, nước hoa, thực phẩm chức năng.', type: 'percentage', value: 15, maxDiscount: 70_000, minOrder: 200_000, targets: leavesOf('sac-dep-suc-khoe'), limit: 1200, perUser: 3, startsAgo: 28, endsIn: 90 },
  { code: 'THUCPHAM20K', name: 'Giảm 20.000₫ thực phẩm & đồ uống', note: 'Áp dụng cho ngành Thực phẩm & Đồ uống.', type: 'fixed_amount', value: 20_000, minOrder: 150_000, targets: leavesOf('thuc-pham-do-uong'), perUser: 3, startsAgo: 30, endsIn: 90 },
  { code: 'NHACUA10', name: 'Giảm 10% nhà cửa & đời sống', note: 'Áp dụng cho ngành Nhà cửa & Đời sống: gia dụng, nội thất, trang trí, chăn ga gối nệm.', type: 'percentage', value: 10, maxDiscount: 150_000, minOrder: 500_000, targets: leavesOf('nha-cua-doi-song'), limit: 600, perUser: 2, startsAgo: 25, endsIn: 80 },
  // --- dịp lễ / sinh nhật (hiệu lực rộng quanh hôm nay) ---
  { code: 'PHUNU2010', name: 'Mừng 20/10 — giảm 20%', note: 'Quà tri ân nhân Ngày Phụ nữ Việt Nam 20/10.', type: 'percentage', value: 20, maxDiscount: 100_000, minOrder: 399_000, limit: 3000, perUser: 1, startsAgo: 30, endsIn: 60 },
  { code: 'SALE1111', name: 'Đôi 11.11 — giảm 111.000₫', note: 'Siêu sale 11.11 toàn sàn.', type: 'fixed_amount', value: 111_000, minOrder: 1_111_000, limit: 1111, perUser: 1, startsAgo: 30, endsIn: 90 },
  { code: 'SINHNHAT', name: 'Quà sinh nhật FITLY — giảm 100.000₫', note: 'Mừng sinh nhật sàn FITLY, áp dụng toàn sàn.', type: 'fixed_amount', value: 100_000, minOrder: 799_000, limit: 1500, perUser: 1, startsAgo: 30, endsIn: 120 },
  // --- trạng thái demo ---
  { code: 'HEVUI', name: 'Hè vui — giảm 20% (đã kết thúc)', note: 'Chương trình mùa hè đã kết thúc, dùng để kiểm tra thông báo hết hạn.', type: 'percentage', value: 20, maxDiscount: 100_000, minOrder: 300_000, limit: 2000, used: 874, startsAgo: 100, endsIn: -10 },
  { code: 'FLASH50', name: 'Flash sale — giảm 50.000₫ cho 50 lượt đầu', note: 'Số lượt còn rất ít, để kiểm tra trạng thái sắp hết lượt.', type: 'fixed_amount', value: 50_000, minOrder: 199_000, limit: 50, used: 47, perUser: 1, startsAgo: 5, endsIn: 30 },
  // --- mã nội bộ, khách nhập tay (isPublic=false) ---
  { code: 'VIP20', name: 'Ưu đãi khách VIP — giảm 20%', note: 'Dành riêng cho khách thân thiết, nhập tay khi thanh toán.', type: 'percentage', value: 20, maxDiscount: 300_000, minOrder: 500_000, limit: 300, perUser: 3, startsAgo: 40, endsIn: 120, hidden: true },
  { code: 'XINLOI30K', name: 'Mã xin lỗi từ CSKH — giảm 30.000₫', note: 'CSKH gửi riêng để bù đắp trải nghiệm chưa tốt, nhập tay khi thanh toán.', type: 'fixed_amount', value: 30_000, minOrder: 99_000, limit: 200, perUser: 1, startsAgo: 40, endsIn: 120, hidden: true },
  { code: 'KOL10', name: 'Mã đối tác KOL — giảm 10%', note: 'Mã đồng hành cùng đối tác truyền thông, nhập tay khi thanh toán.', type: 'percentage', value: 10, maxDiscount: 60_000, minOrder: 199_000, perUser: 2, startsAgo: 45, endsIn: 100, hidden: true },
];

// ---------------------------------------------------------------------------------------------------------------------
// Voucher GIAN HÀNG — tiền tố lấy từ tên shop; `targets` chỉ gồm ngành lá shop thật sự bán (kiểm ở validatePlans)
// ---------------------------------------------------------------------------------------------------------------------
const SHOP_PLANS: readonly ShopPlan[] = [
  {
    shop: 'fitly-official', short: 'FITLY Official', prefix: 'FITLY',
    vouchers: [
      { code: 'FITLY10', type: 'percentage', value: 10, maxDiscount: 60_000, minOrder: 300_000, perUser: 3, startsAgo: 60, endsIn: 120 },
      { code: 'FITLY30K', type: 'fixed_amount', value: 30_000, minOrder: 250_000, limit: 2000, perUser: 2, startsAgo: 45, endsIn: 90 },
      { code: 'FITLYAO', type: 'percentage', value: 15, maxDiscount: 80_000, minOrder: 400_000, targets: ['ao-thun', 'ao-so-mi', 'ao-khoac'], label: 'áo thun, áo sơ mi, áo khoác', limit: 800, perUser: 2, startsAgo: 30, endsIn: 75 },
    ],
  },
  {
    shop: 'techzone-vn', short: 'TechZone', prefix: 'TECHZONE',
    vouchers: [
      { code: 'TECHZONE10', type: 'percentage', value: 10, maxDiscount: 300_000, minOrder: 500_000, perUser: 2, startsAgo: 90, endsIn: 120 },
      { code: 'TECHZONE30K', type: 'fixed_amount', value: 30_000, minOrder: 250_000, targets: ['phu-kien-dien-thoai', 'chuot-ban-phim', 'tai-nghe-loa'], label: 'phụ kiện & thiết bị ngoại vi', limit: 3000, perUser: 3, startsAgo: 60, endsIn: 90 },
      { code: 'TECHZONESHIP', type: 'free_shipping', minOrder: 299_000, perUser: 5, startsAgo: 75, endsIn: 100 },
    ],
  },
  {
    shop: 'mobile-hub', short: 'Mobile Hub', prefix: 'MHUB',
    vouchers: [
      { code: 'MHUB10', type: 'percentage', value: 10, maxDiscount: 50_000, minOrder: 200_000, perUser: 3, startsAgo: 70, endsIn: 110 },
      { code: 'MHUB30K', type: 'fixed_amount', value: 30_000, minOrder: 250_000, limit: 1500, perUser: 2, startsAgo: 50, endsIn: 80 },
      { code: 'MHUBPK20', type: 'percentage', value: 20, maxDiscount: 40_000, minOrder: 100_000, targets: ['phu-kien-dien-thoai'], label: 'phụ kiện điện thoại', limit: 1000, perUser: 2, startsAgo: 25, endsIn: 60 },
    ],
  },
  {
    shop: 'gia-dung-thong-minh', short: 'Gia Dụng Thông Minh', prefix: 'GIADUNG',
    vouchers: [
      { code: 'GIADUNG10', type: 'percentage', value: 10, maxDiscount: 150_000, minOrder: 500_000, perUser: 2, startsAgo: 80, endsIn: 100 },
      { code: 'GIADUNG50K', type: 'fixed_amount', value: 50_000, minOrder: 500_000, targets: ['do-dien-gia-dung'], label: 'đồ điện gia dụng', limit: 600, perUser: 2, startsAgo: 40, endsIn: 70 },
      { code: 'GIADUNGSHIP', type: 'free_shipping', minOrder: 399_000, perUser: 4, startsAgo: 60, endsIn: 90 },
    ],
  },
  {
    shop: 'nha-xinh-decor', short: 'Nhà Xinh Decor', prefix: 'NHAXINH',
    vouchers: [
      { code: 'NHAXINH10', type: 'percentage', value: 10, maxDiscount: 100_000, minOrder: 400_000, perUser: 2, startsAgo: 85, endsIn: 110 },
      { code: 'NHAXINH100K', type: 'fixed_amount', value: 100_000, minOrder: 900_000, targets: ['chan-ga-goi-nem'], label: 'chăn, ga, gối, nệm', limit: 300, perUser: 1, startsAgo: 35, endsIn: 70 },
      { code: 'NHAXINHSHIP', type: 'free_shipping', minOrder: 600_000, perUser: 3, startsAgo: 55, endsIn: 120 },
    ],
  },
  {
    shop: 'beauty-box-vn', short: 'Beauty Box', prefix: 'BEAUTY',
    vouchers: [
      { code: 'BEAUTY10', type: 'percentage', value: 10, maxDiscount: 50_000, minOrder: 200_000, perUser: 3, startsAgo: 70, endsIn: 100 },
      { code: 'BEAUTY15K', type: 'fixed_amount', value: 15_000, minOrder: 150_000, perUser: 5, startsAgo: 90, endsIn: 150 },
      { code: 'BEAUTY100K', type: 'fixed_amount', value: 100_000, minOrder: 699_000, targets: ['nuoc-hoa'], label: 'nước hoa', limit: 200, perUser: 1, startsAgo: 20, endsIn: 60 },
    ],
  },
  {
    shop: 'healthy-life', short: 'Healthy Life', prefix: 'HEALTHY',
    vouchers: [
      { code: 'HEALTHY10', type: 'percentage', value: 10, maxDiscount: 50_000, minOrder: 200_000, perUser: 3, startsAgo: 65, endsIn: 100 },
      { code: 'HEALTHY20K', type: 'fixed_amount', value: 20_000, minOrder: 199_000, targets: ['thuc-pham-chuc-nang', 'ngu-coc-hat-dinh-duong'], label: 'thực phẩm chức năng & ngũ cốc dinh dưỡng', limit: 1500, perUser: 3, startsAgo: 40, endsIn: 75 },
      { code: 'HEALTHYSHIP', type: 'free_shipping', minOrder: 250_000, perUser: 5, startsAgo: 50, endsIn: 90 },
    ],
  },
  {
    shop: 'sneaker-station', short: 'Sneaker Station', prefix: 'SNEAKER',
    vouchers: [
      { code: 'SNEAKER10', type: 'percentage', value: 10, maxDiscount: 100_000, minOrder: 500_000, perUser: 2, startsAgo: 90, endsIn: 120 },
      { code: 'SNEAKER50K', type: 'fixed_amount', value: 50_000, minOrder: 700_000, targets: ['giay-the-thao'], label: 'giày thể thao', limit: 500, perUser: 1, startsAgo: 30, endsIn: 60 },
      { code: 'SNEAKERVIP', name: 'Ưu đãi khách thân thiết — giảm 15% tại Sneaker Station', note: 'Dành cho khách thân thiết của Sneaker Station, nhập tay khi thanh toán.', type: 'percentage', value: 15, maxDiscount: 150_000, minOrder: 800_000, limit: 100, perUser: 3, startsAgo: 45, endsIn: 100, hidden: true },
    ],
  },
  {
    shop: 'bag-and-co', short: 'Bag & Co', prefix: 'BAGCO',
    vouchers: [
      { code: 'BAGCO10', type: 'percentage', value: 10, maxDiscount: 80_000, minOrder: 300_000, perUser: 3, startsAgo: 75, endsIn: 110 },
      { code: 'BAGCO30K', type: 'fixed_amount', value: 30_000, minOrder: 250_000, limit: 2000, perUser: 2, startsAgo: 60, endsIn: 90 },
      { code: 'BAGCOSHIP', type: 'free_shipping', minOrder: 399_000, perUser: 4, startsAgo: 50, endsIn: 80 },
    ],
  },
  {
    shop: 'time-lab', short: 'Time Lab Watches', prefix: 'TIMELAB',
    vouchers: [
      { code: 'TIMELAB10', type: 'percentage', value: 10, maxDiscount: 200_000, minOrder: 800_000, perUser: 2, startsAgo: 80, endsIn: 120 },
      { code: 'TIMELAB100K', type: 'fixed_amount', value: 100_000, minOrder: 1_500_000, targets: ['dong-ho-nam', 'dong-ho-nu'], label: 'đồng hồ nam & nữ', limit: 300, perUser: 1, startsAgo: 35, endsIn: 70 },
    ],
  },
  {
    shop: 'sport-planet', short: 'Sport Planet', prefix: 'SPORTP',
    vouchers: [
      { code: 'SPORTP20', type: 'percentage', value: 20, maxDiscount: 100_000, minOrder: 400_000, limit: 1000, perUser: 2, startsAgo: 45, endsIn: 75 },
      { code: 'SPORTP30K', type: 'fixed_amount', value: 30_000, minOrder: 250_000, perUser: 3, startsAgo: 80, endsIn: 120 },
      { code: 'SPORTPSHIP', type: 'free_shipping', minOrder: 299_000, perUser: 5, startsAgo: 60, endsIn: 100 },
    ],
  },
  {
    shop: 'baby-land', short: 'BabyLand', prefix: 'BABYLAND',
    vouchers: [
      { code: 'BABYLAND10', type: 'percentage', value: 10, maxDiscount: 60_000, minOrder: 250_000, perUser: 3, startsAgo: 70, endsIn: 100 },
      { code: 'BABYLAND30K', type: 'fixed_amount', value: 30_000, minOrder: 250_000, targets: ['sua-ta-be'], label: 'sữa & tã bé', limit: 1200, perUser: 2, startsAgo: 40, endsIn: 80 },
      { code: 'BABYLANDSHIP', type: 'free_shipping', minOrder: 299_000, perUser: 5, startsAgo: 55, endsIn: 90 },
    ],
  },
  {
    shop: 'book-cafe', short: 'Book & Cafe', prefix: 'BOOKCAFE',
    vouchers: [
      { code: 'BOOKCAFE10', type: 'percentage', value: 10, maxDiscount: 30_000, minOrder: 150_000, perUser: 3, startsAgo: 85, endsIn: 120 },
      { code: 'BOOKCAFE15K', type: 'fixed_amount', value: 15_000, minOrder: 120_000, targets: ['sach-van-hoc-ky-nang', 'sach-thieu-nhi'], label: 'sách văn học, kỹ năng và sách thiếu nhi', perUser: 3, startsAgo: 50, endsIn: 100 },
    ],
  },
  {
    shop: 'ngon-viet', short: 'Ngon Việt', prefix: 'NGONVIET',
    vouchers: [
      { code: 'NGONVIET10', type: 'percentage', value: 10, maxDiscount: 40_000, minOrder: 200_000, perUser: 3, startsAgo: 70, endsIn: 100 },
      { code: 'NGONVIET20K', type: 'fixed_amount', value: 20_000, minOrder: 199_000, targets: ['do-an-vat', 'ca-phe-tra'], label: 'đồ ăn vặt, cà phê & trà', limit: 2000, perUser: 3, startsAgo: 45, endsIn: 75 },
      { code: 'NGONVIETSHIP', type: 'free_shipping', minOrder: 250_000, perUser: 5, startsAgo: 60, endsIn: 90 },
    ],
  },
  {
    shop: 'pet-world', short: 'Pet World', prefix: 'PETWORLD',
    vouchers: [
      { code: 'PETWORLD10', type: 'percentage', value: 10, maxDiscount: 60_000, minOrder: 250_000, perUser: 3, startsAgo: 80, endsIn: 110 },
      { code: 'PETWORLD30K', type: 'fixed_amount', value: 30_000, minOrder: 300_000, targets: ['thuc-an-thu-cung'], label: 'thức ăn thú cưng', limit: 800, perUser: 2, startsAgo: 35, endsIn: 70 },
    ],
  },
  {
    shop: 'auto-moto-pro', short: 'Auto Moto Pro', prefix: 'AUTOMOTO',
    vouchers: [
      { code: 'AUTOMOTO10', type: 'percentage', value: 10, maxDiscount: 100_000, minOrder: 300_000, perUser: 2, startsAgo: 90, endsIn: 120 },
      { code: 'AUTOMOTO50K', type: 'fixed_amount', value: 50_000, minOrder: 500_000, targets: ['mu-bao-hiem', 'cham-soc-xe'], label: 'mũ bảo hiểm & đồ chăm sóc xe', limit: 500, perUser: 2, startsAgo: 40, endsIn: 80 },
      { code: 'AUTOMOTOSHIP', type: 'free_shipping', minOrder: 399_000, perUser: 4, startsAgo: 50, endsIn: 100 },
    ],
  },
  {
    // Shop BỊ KHOÁ: giữ 1 mã tạo từ trước khi bị khoá để màn quản lý mã của sàn có ví dụ (sản phẩm shop này đã bị ẩn khỏi trang khách).
    shop: 'hang-nhai-24h', short: 'Hàng Nhái 24h', prefix: 'HANGNHAI',
    vouchers: [
      { code: 'HANGNHAI15', note: 'Mã tạo từ trước khi gian hàng bị khoá, dùng để thử luồng khoá shop.', type: 'percentage', value: 15, maxDiscount: 40_000, minOrder: 100_000, perUser: 2, startsAgo: 60, endsIn: 30 },
    ],
  },
];

// ---------------------------------------------------------------------------------------------------------------------
// Kiểm dữ liệu — cùng luật với PromotionService.validate + ràng buộc DB; sai thì từ chối ghi để khỏi seed dở
// ---------------------------------------------------------------------------------------------------------------------
function soldLeaves(shop: ShopSlug): Set<string> {
  const out = new Set<string>();
  for (const d of DEPARTMENTS) for (const p of d.products) if (p.shop === shop) out.add(p.category);
  if (shop === 'fitly-official') for (const s of FASHION_LEAVES) out.add(s);
  return out;
}

function validatePlans(): void {
  const errors: string[] = [];
  const seen = new Set<string>(LEGACY_CODES);
  const allLeaves = new Set<string>(FASHION_LEAVES);
  for (const d of DEPARTMENTS) for (const c of d.categories) allLeaves.add(c.slug);

  const check = (s: VoucherSpec, shop: ShopPlan | null): void => {
    const at = shop ? `mã ${s.code} (shop ${shop.shop})` : `mã sàn ${s.code}`;
    if (!/^[A-Z0-9]{3,40}$/.test(s.code)) errors.push(`${at}: mã phải IN HOA/số, 3–40 ký tự`);
    const key = s.code.toUpperCase();
    if (seen.has(key)) errors.push(`${at}: trùng mã (so với mã cũ hoặc mã khác trong file này)`);
    seen.add(key);
    if (s.type === 'percentage' && (!s.value || s.value < 1 || s.value > 100)) errors.push(`${at}: phần trăm giảm phải trong 1–100`);
    if (s.type === 'fixed_amount' && (!s.value || s.value <= 0)) errors.push(`${at}: số tiền giảm phải > 0`);
    if (s.type === 'free_shipping' && s.value) errors.push(`${at}: freeship phải có value = 0`);
    if (s.maxDiscount !== undefined && s.type !== 'percentage') errors.push(`${at}: chỉ mã phần trăm mới có trần giảm`);
    for (const n of [s.value ?? 0, s.maxDiscount ?? 0, s.minOrder]) if (!Number.isInteger(n) || n < 0) errors.push(`${at}: tiền/giá trị phải là số nguyên không âm`);
    if (s.startsAgo + s.endsIn <= 0) errors.push(`${at}: ngày kết thúc phải sau ngày bắt đầu`);
    if (s.used !== undefined && (s.limit === undefined || s.used > s.limit)) errors.push(`${at}: usedCount phải ≤ usageLimit (ràng buộc ck_promotions_used_le_limit)`);
    if (s.perUser !== undefined && s.perUser < 1) errors.push(`${at}: usageLimitPerUser phải ≥ 1`);
    const targets = s.targets ?? [];
    if (s.targets && targets.length === 0) errors.push(`${at}: phạm vi category cần ít nhất một ngành`);
    for (const t of targets) {
      if (!allLeaves.has(t)) errors.push(`${at}: '${t}' không phải slug ngành lá nào trong dữ liệu mẫu`);
      else if (shop && !soldLeaves(shop.shop).has(t)) errors.push(`${at}: shop ${shop.shop} không bán ngành '${t}'`);
    }
    if (!shop && !s.name) errors.push(`${at}: mã sàn phải có name`);
    if (!shop && !s.note) errors.push(`${at}: mã sàn phải có note (mô tả)`);
    if (shop && !s.code.startsWith(shop.prefix)) errors.push(`${at}: mã phải bắt đầu bằng tiền tố '${shop.prefix}'`);
  };

  if (PLATFORM.length < 8) errors.push('Cần ≥ 8 mã sàn');
  for (const s of PLATFORM) check(s, null);
  const planned = new Set<string>();
  for (const plan of SHOP_PLANS) {
    if (planned.has(plan.shop)) errors.push(`shop ${plan.shop}: khai báo 2 lần`);
    planned.add(plan.shop);
    const def = SHOPS.find((s) => s.slug === plan.shop);
    if (!def) errors.push(`shop ${plan.shop}: không có trong data/shops.ts`);
    else if (def.status !== 'approved' && def.status !== 'suspended') errors.push(`shop ${plan.shop}: shop ${def.status} không được có mã`);
    else if (def.status === 'suspended' && plan.vouchers.length !== 1) errors.push(`shop ${plan.shop}: shop bị khoá chỉ giữ 1 mã`);
    else if (def.status === 'approved' && (plan.vouchers.length < 2 || plan.vouchers.length > 3)) errors.push(`shop ${plan.shop}: mỗi shop đã duyệt cần 2–3 mã`);
    if (!/^[A-Z]{3,8}$/.test(plan.prefix)) errors.push(`shop ${plan.shop}: tiền tố '${plan.prefix}' phải gồm 3–8 chữ cái IN HOA`);
    for (const s of plan.vouchers) check(s, plan);
  }
  // Mọi shop đã duyệt phải có kế hoạch mã
  for (const s of SHOPS) if (s.status === 'approved' && !planned.has(s.slug)) errors.push(`shop ${s.slug}: đã duyệt nhưng chưa có mã giảm giá`);

  if (errors.length > 0) {
    for (const e of errors) console.error(`   ✗ ${e}`);
    throw new Error(`Dữ liệu mã giảm giá sàn đa gian hàng có ${errors.length} lỗi`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Dựng dòng ghi DB
// ---------------------------------------------------------------------------------------------------------------------
interface PromoRow {
  code: string;
  name: string;
  description: string;
  type: PromoType;
  value: string;
  maxDiscount: string | null;
  minOrderAmount: string;
  usageLimit: number | null;
  usageLimitPerUser: number | null;
  usedCount: number;
  appliesTo: 'all' | 'category';
  startsAt: Date;
  endsAt: Date;
  isPublic: boolean;
  targets: Array<{ targetType: 'category'; targetRef: string }>;
}

const vnd = (n: number): string => `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}₫`;
/* 299000 → "299k", 2000000 → "2tr" (dùng trong tên mã) */
const shortMoney = (n: number): string => (n >= 1_000_000 && n % 1_000_000 === 0 ? `${n / 1_000_000}tr` : `${Math.round(n / 1000)}k`);

/* Câu điều kiện sinh từ chính các trường số → mô tả không bao giờ lệch với giá trị thật. */
function conditionText(s: VoucherSpec): string {
  const parts: string[] = [];
  if (s.minOrder > 0) parts.push(`đơn từ ${vnd(s.minOrder)}`);
  if (s.type === 'percentage' && s.maxDiscount) parts.push(`giảm tối đa ${vnd(s.maxDiscount)}`);
  if (s.perUser) parts.push(`mỗi tài khoản dùng tối đa ${s.perUser} lần`);
  if (s.limit !== undefined && s.limit <= 100) parts.push(`chỉ ${s.limit} lượt đầu tiên`);
  if (parts.length === 0) return '';
  const text = parts.join(', ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

function shopName(s: VoucherSpec, short: string): string {
  if (s.name) return s.name;
  const base = s.type === 'percentage' ? `Giảm ${s.value}%` : s.type === 'fixed_amount' ? `Giảm ${vnd(s.value ?? 0)}` : 'Freeship';
  const what = s.label ? ` ${s.label}` : s.minOrder > 0 ? ` cho đơn từ ${shortMoney(s.minOrder)}` : '';
  return `${base}${what} tại ${short}`;
}

function toRow(s: VoucherSpec, now: number, short: string | null): PromoRow {
  const lead = s.note ?? (short ? (s.label ? `Áp dụng cho ${s.label}.` : `Áp dụng cho mọi sản phẩm của ${short}.`) : '');
  return {
    code: s.code,
    name: short ? shopName(s, short) : (s.name ?? s.code),
    description: [lead, conditionText(s)].filter(Boolean).join(' '),
    type: s.type,
    value: s.type === 'free_shipping' ? '0' : String(s.value),
    maxDiscount: s.type === 'percentage' && s.maxDiscount ? String(s.maxDiscount) : null,
    minOrderAmount: String(s.minOrder),
    usageLimit: s.limit ?? null,
    usageLimitPerUser: s.perUser ?? null,
    usedCount: s.used ?? 0,
    appliesTo: s.targets && s.targets.length > 0 ? 'category' : 'all',
    startsAt: new Date(now - s.startsAgo * DAY),
    endsAt: new Date(now + s.endsIn * DAY),
    isPublic: !s.hidden,
    targets: [...new Set(s.targets ?? [])].map((targetRef) => ({ targetType: 'category' as const, targetRef })),
  };
}

type Outcome = 'created' | 'exists' | 'conflict';

/* Mã duy nhất toàn hệ thống không phân biệt hoa thường: có rồi thì giữ nguyên (không đụng usedCount/ngày đã sửa tay). */
async function createIfAbsent(prisma: PrismaClient, row: PromoRow, scope: 'platform' | 'shop', shopId: string | null): Promise<Outcome> {
  const found = await prisma.promotion.findFirst({ where: { code: { equals: row.code, mode: 'insensitive' }, isDeleted: false }, select: { id: true, scope: true, shopId: true } });
  if (found) return found.scope === scope && found.shopId === shopId ? 'exists' : 'conflict';
  await prisma.promotion.create({
    data: {
      code: row.code, name: row.name, description: row.description, type: row.type, value: row.value, maxDiscount: row.maxDiscount, minOrderAmount: row.minOrderAmount,
      usageLimit: row.usageLimit, usageLimitPerUser: row.usageLimitPerUser, usedCount: row.usedCount, appliesTo: row.appliesTo, startsAt: row.startsAt, endsAt: row.endsAt,
      isActive: true, isPublic: row.isPublic, scope, shopId,
      targets: { create: row.targets },
    },
  });
  return 'created';
}

export async function seed(prisma: PrismaClient): Promise<void> {
  validatePlans();
  const now = Date.now();

  // ---- voucher SÀN
  let platformCreated = 0;
  for (const s of PLATFORM) {
    const outcome = await createIfAbsent(prisma, toRow(s, now, null), 'platform', null);
    if (outcome === 'created') platformCreated += 1;
    else if (outcome === 'conflict') console.log(`   ! mã ${s.code} đã tồn tại nhưng không phải voucher sàn — bỏ qua`);
  }
  console.log(`   mã giảm giá sàn: ${PLATFORM.length} (tạo mới ${platformCreated})`);

  // ---- voucher GIAN HÀNG
  let shopTotal = 0;
  let shopCreated = 0;
  const perShop: string[] = [];
  for (const plan of SHOP_PLANS) {
    const shop = await prisma.shop.findFirst({ where: { slug: plan.shop, isDeleted: false }, select: { id: true } });
    if (!shop) {
      console.log(`   ! bỏ qua mã của shop '${plan.shop}': chưa có gian hàng trong DB (chạy marketplace.seed trước)`);
      continue;
    }
    let created = 0;
    for (const s of plan.vouchers) {
      const outcome = await createIfAbsent(prisma, toRow(s, now, plan.short), 'shop', shop.id);
      if (outcome === 'created') created += 1;
      else if (outcome === 'conflict') console.log(`   ! mã ${s.code} đã tồn tại nhưng không thuộc shop '${plan.shop}' — bỏ qua`);
    }
    shopTotal += plan.vouchers.length;
    shopCreated += created;
    perShop.push(`${plan.shop} +${created}/${plan.vouchers.length}`);
  }
  console.log(`   mã giảm giá gian hàng: ${shopTotal} (tạo mới ${shopCreated}) — ${perShop.join(' · ')}`);
}
