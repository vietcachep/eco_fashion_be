/*
 * SEED hoạt động mua bán nhiều gian hàng / nhiều ngành hàng (demo): thêm 40 khách (khach6..khach45@ecofashion.vn, mỗi người một địa chỉ mặc định
 * ở nhiều tỉnh/thành) + ~320 đơn con LỊCH SỬ trải 110 ngày gần đây, gói trong ~270 OrderGroup (≈12% là giỏ nhiều shop). Mỗi đơn con thuộc đúng
 * 1 shop, có đủ: dòng hàng snapshot, lịch sử trạng thái, Payment + giao dịch (COD/PayOS), sổ kho (RESERVE/SALE/RELEASE/RETURN),
 * voucher sàn + voucher shop (PromotionUsage + usedCount), đổi trả có hoàn tiền (ReturnRequest + Refund có shopId). Sàn thu MỌI khoản tiền (PayOS online, COD do shipper thu hộ cho sàn):
 * đơn COD đã giao/hoàn tất có Payment `paid` + giao dịch cod_collect, và (như PayOS) sẽ vào kỳ chi trả cho shop ở bước `settlement`.
 *
 * Thiết kế:
 *  - TẤT ĐỊNH: mọi ngẫu nhiên đến từ mulberry32 với seed cố định (mỗi nhóm/đơn con có PRNG riêng theo chỉ số → cấu trúc đơn không phụ thuộc
 *    dữ liệu đã có trong DB). Chỉ MỐC THỜI GIAN tính từ Date.now() lúc chạy trừ daysAgo. Mã đơn `DHSEED00001..`, mã nhóm `GRSEED00001..` đánh số
 *    theo thứ tự thời gian (cũ → mới).
 *  - IDEMPOTENT: nhóm tồn tại theo mã → bỏ qua; mỗi nhóm ghi trong MỘT transaction (đơn + thanh toán + kho + voucher cùng sống cùng chết).
 *    Khách tìm theo email trước khi tạo.
 *  - KHO: trước khi ghi đơn, mô phỏng sổ kho THEO THỜI GIAN từng biến thể (kho hiện tại + mọi RESERVE/SALE/RELEASE/RETURN của đơn mới) để
 *    (a) nhập bổ sung bằng phiếu `posted` theo shop (có sổ kho RECEIPT) sao cho stock − reserved ≥ 3 ở MỌI thời điểm (không âm kho, reserved ≤ stock —
 *    CHECK ck_product_variants_stock_nonneg) và (b) tính đúng `stockAfter` từng dòng sổ kho.
 *  - Bất biến tiền: số nguyên VND (bigint); discount = shopDiscount + platformDiscount; total = subtotal + shippingFee − discount ≥ 0; OrderGroup = tổng các
 *    đơn con; phí ship tính RIÊNG từng đơn con theo bảng phí tỉnh + ngưỡng freeship (như OrderService.price); voucher sàn tính trên cả giỏ rồi phân bổ
 *    theo tỉ lệ (như OrderService.applyVouchers); công thức giảm đúng PromotionService.discountOf.
 *  - Mỗi nhóm dùng CHUNG một phương thức thanh toán + một địa chỉ (như placeOrder). COD bị loại khi đơn con vượt hạn mức COD.
 *  - Shop bị khoá chỉ có đơn CŨ (≥ 60 ngày) đã hoàn tất/huỷ; shop chờ duyệt không có đơn (không có cột "ngày khoá" nên dùng mốc bảo thủ này).
 * Cần chạy sau: identity, system (tỉnh + phí ship), catalog, dynamic-attribute, marketplace (shop + sản phẩm), product, payment, promotion
 * (voucher sàn + voucher từng shop, scope='shop'). Không tạo thông báo/outbox (đơn lịch sử).
 */
import { createHash } from 'node:crypto';
import * as argon2 from 'argon2';
import { formatVnd, minVnd, percentOf, vnd } from '../../src/common/utils/money';
import type { Prisma, PrismaClient } from '../../src/generated/prisma/client';
import { METHOD, PAY_STATUS, REFUND_STATUS, TX_TYPE } from '../../src/modules/payment/foundation/payment.constants';
import { DEMO_CUSTOMER_PASSWORD } from './identity.seed';
import { FITLY_OFFICIAL_SHOP_ID } from './lib/seed-shop';

/* ============================================================================================== hằng số + kiểu */

const SEED = 0x5eed2610; // cố định — đổi số này là đổi toàn bộ dữ liệu sinh ra
const CODE_PREFIX = 'DHSEED';
const GROUP_PREFIX = 'GRSEED';
const TARGET_CHILD_ORDERS = 320;
const HISTORY_DAYS = 110;
const MIN_ORDERS_PER_SHOP = 6;
const SUSPENDED_SHOP_ORDERS = 8;
const SUSPENDED_MIN_AGE_DAYS = 60;
const MULTI_SHOP_RATIO = 0.12;
const STOCK_MARGIN = 3; // tồn khả dụng tối thiểu còn lại sau mọi đơn
const MIN_ORDER_TOTAL = 10_000n;

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

type Tx = Prisma.TransactionClient;
type Rng = () => number;
type Status = 'pending' | 'confirmed' | 'packing' | 'shipping' | 'delivered' | 'completed' | 'cancelled';
type PayMethod = (typeof METHOD)[keyof typeof METHOD];
type CancelKind = 'expired' | 'customer' | 'shop';
type ReturnState = 'requested' | 'approved' | 'refunded' | 'rejected';
type Target = Status | 'return';
type StockType = 'RESERVE' | 'RELEASE' | 'SALE' | 'RETURN';

const CHAIN: Status[] = ['pending', 'confirmed', 'packing', 'shipping', 'delivered', 'completed'];

/* Trọng số đơn theo shop (slug) — shop lớn nhiều đơn hơn; shop lạ mặc định 4. Mọi shop đã duyệt đều ≥ MIN_ORDERS_PER_SHOP. */
const SHOP_WEIGHTS: Record<string, number> = {
  'fitly-official': 20, 'techzone-vn': 14, 'mobile-hub': 12, 'beauty-box-vn': 12, 'gia-dung-thong-minh': 10, 'sneaker-station': 9, 'healthy-life': 8,
  'nha-xinh-decor': 7, 'bag-and-co': 7, 'baby-land': 6, 'sport-planet': 6, 'ngon-viet': 6, 'book-cafe': 5, 'pet-world': 5, 'time-lab': 4, 'auto-moto-pro': 3,
};

const METHOD_WEIGHTS: ReadonlyArray<readonly [PayMethod, number]> = [[METHOD.COD, 45], [METHOD.PAYOS, 55]];
const HOUR_WEIGHTS = [1, 1, 0.5, 0.5, 0.5, 1, 2, 4, 6, 8, 9, 9, 8, 7, 7, 8, 8, 8, 9, 11, 12, 12, 8, 4];

const CUSTOMER_NOTES = ['Giao giờ hành chính giúp mình', 'Gọi trước khi giao nhé', 'Để hàng ở bảo vệ nếu không có nhà', 'Gói quà giúp mình với', 'Giao buổi tối sau 18h', 'Kiểm tra hàng kỹ trước khi giao giúp shop'];
const CANCEL_REASONS_CUSTOMER = ['Tôi muốn đổi sản phẩm khác', 'Đặt nhầm sản phẩm/phân loại', 'Thay đổi địa chỉ giao hàng', 'Tìm được giá rẻ hơn ở nơi khác', 'Không còn nhu cầu mua'];
const CANCEL_REASONS_SHOP = ['Hết hàng tại kho', 'Không liên hệ được người nhận', 'Sản phẩm lỗi khi kiểm hàng', 'Khách yêu cầu huỷ qua hotline'];
const RETURN_REASONS = [
  { reason: 'Không vừa size/kích cỡ', detail: 'Sản phẩm không vừa như mong đợi, muốn đổi trả hoàn tiền.' },
  { reason: 'Sản phẩm lỗi/hư hỏng', detail: 'Nhận hàng thấy có lỗi, đã chụp ảnh gửi kèm.' },
  { reason: 'Giao sai màu/sai mẫu', detail: 'Hàng nhận được khác với phân loại đã đặt.' },
  { reason: 'Không giống mô tả', detail: 'Chất lượng và hình thức khác với mô tả trên trang sản phẩm.' },
];
const RETURN_REJECT_REASONS = ['Sản phẩm đã qua sử dụng/giặt, không còn nguyên tem mác', 'Minh chứng chưa đủ rõ để xác nhận lỗi từ shop'];

/* 40 khách mới: họ tên Việt có dấu (nam/nữ lẫn lộn) + địa chỉ mặc định — nhiều ở HCM/Hà Nội/Đà Nẵng/Cần Thơ/Hải Phòng, còn lại là tỉnh nhỏ. */
interface CustomerDef { no: number; fullName: string; provinceCode: string; district: string; ward: string; street: string }
const NEW_CUSTOMERS: CustomerDef[] = [
  { no: 6, fullName: 'Nguyễn Thị Mai Anh', provinceCode: '79', district: 'Quận 3', ward: 'Phường Võ Thị Sáu', street: '45 Nam Kỳ Khởi Nghĩa' },
  { no: 7, fullName: 'Trần Quốc Huy', provinceCode: '79', district: 'Quận Bình Thạnh', ward: 'Phường 25', street: '120 Điện Biên Phủ' },
  { no: 8, fullName: 'Lê Hoàng Yến', provinceCode: '79', district: 'Quận 7', ward: 'Phường Tân Phong', street: '88 Nguyễn Lương Bằng' },
  { no: 9, fullName: 'Phạm Minh Tuấn', provinceCode: '79', district: 'TP. Thủ Đức', ward: 'Phường Hiệp Bình Chánh', street: '15 Quốc Lộ 13' },
  { no: 10, fullName: 'Võ Thị Thanh Thảo', provinceCode: '79', district: 'Quận Gò Vấp', ward: 'Phường 10', street: '32 Quang Trung' },
  { no: 11, fullName: 'Huỳnh Gia Bảo', provinceCode: '79', district: 'Quận Tân Bình', ward: 'Phường 2', street: '7 Hoàng Văn Thụ' },
  { no: 12, fullName: 'Đặng Ngọc Trâm', provinceCode: '79', district: 'Quận 10', ward: 'Phường 12', street: '210 Sư Vạn Hạnh' },
  { no: 13, fullName: 'Bùi Anh Khoa', provinceCode: '79', district: 'Quận Phú Nhuận', ward: 'Phường 9', street: '56 Phan Xích Long' },
  { no: 14, fullName: 'Nguyễn Đức Anh', provinceCode: '01', district: 'Quận Cầu Giấy', ward: 'Phường Dịch Vọng', street: '24 Trần Thái Tông' },
  { no: 15, fullName: 'Trần Thị Hải Yến', provinceCode: '01', district: 'Quận Đống Đa', ward: 'Phường Láng Hạ', street: '98 Thái Hà' },
  { no: 16, fullName: 'Lê Minh Quân', provinceCode: '01', district: 'Quận Thanh Xuân', ward: 'Phường Nhân Chính', street: '11 Lê Văn Lương' },
  { no: 17, fullName: 'Hoàng Thu Hà', provinceCode: '01', district: 'Quận Hai Bà Trưng', ward: 'Phường Bách Khoa', street: '5 Tạ Quang Bửu' },
  { no: 18, fullName: 'Phan Văn Long', provinceCode: '01', district: 'Quận Hà Đông', ward: 'Phường Mộ Lao', street: '76 Nguyễn Văn Lộc' },
  { no: 19, fullName: 'Đỗ Thị Lan Hương', provinceCode: '01', district: 'Quận Tây Hồ', ward: 'Phường Quảng An', street: '19 Xuân Diệu' },
  { no: 20, fullName: 'Ngô Thanh Sơn', provinceCode: '01', district: 'Quận Long Biên', ward: 'Phường Ngọc Lâm', street: '33 Nguyễn Văn Cừ' },
  { no: 21, fullName: 'Dương Thị Kim Ngân', provinceCode: '48', district: 'Quận Hải Châu', ward: 'Phường Hoà Cường Bắc', street: '142 Núi Thành' },
  { no: 22, fullName: 'Lý Quốc Bảo', provinceCode: '48', district: 'Quận Thanh Khê', ward: 'Phường Chính Gián', street: '27 Hà Huy Tập' },
  { no: 23, fullName: 'Trương Mỹ Linh', provinceCode: '48', district: 'Quận Sơn Trà', ward: 'Phường An Hải Bắc', street: '9 Ngô Quyền' },
  { no: 24, fullName: 'Đinh Văn Tài', provinceCode: '48', district: 'Quận Ngũ Hành Sơn', ward: 'Phường Mỹ An', street: '64 Lê Văn Hiến' },
  { no: 25, fullName: 'Lâm Thị Cẩm Tú', provinceCode: '92', district: 'Quận Ninh Kiều', ward: 'Phường Xuân Khánh', street: '51 đường 3 Tháng 2' },
  { no: 26, fullName: 'Châu Minh Nhật', provinceCode: '92', district: 'Quận Cái Răng', ward: 'Phường Lê Bình', street: '18 Võ Nguyên Giáp' },
  { no: 27, fullName: 'Mai Thị Diễm My', provinceCode: '92', district: 'Quận Bình Thuỷ', ward: 'Phường Long Hoà', street: '73 Cách Mạng Tháng Tám' },
  { no: 28, fullName: 'Vũ Hải Đăng', provinceCode: '31', district: 'Quận Hồng Bàng', ward: 'Phường Hoàng Văn Thụ', street: '12 Điện Biên Phủ' },
  { no: 29, fullName: 'Phạm Thị Thuỳ Dương', provinceCode: '31', district: 'Quận Lê Chân', ward: 'Phường An Dương', street: '85 Tô Hiệu' },
  { no: 30, fullName: 'Nguyễn Tiến Dũng', provinceCode: '31', district: 'Quận Ngô Quyền', ward: 'Phường Lạch Tray', street: '40 Lạch Tray' },
  { no: 31, fullName: 'Cao Thị Bích Ngọc', provinceCode: '74', district: 'TP. Thủ Dầu Một', ward: 'Phường Phú Cường', street: '25 Đại lộ Bình Dương' },
  { no: 32, fullName: 'Tô Văn Hậu', provinceCode: '75', district: 'TP. Biên Hoà', ward: 'Phường Trảng Dài', street: '112 Đồng Khởi' },
  { no: 33, fullName: 'Hà Thị Phương Thảo', provinceCode: '56', district: 'TP. Nha Trang', ward: 'Phường Lộc Thọ', street: '6 Trần Phú' },
  { no: 34, fullName: 'Quách Gia Hưng', provinceCode: '46', district: 'TP. Huế', ward: 'Phường Vĩnh Ninh', street: '29 Lê Lợi' },
  { no: 35, fullName: 'Kiều Thị Ánh Tuyết', provinceCode: '22', district: 'TP. Hạ Long', ward: 'Phường Bãi Cháy', street: '47 Hạ Long' },
  { no: 36, fullName: 'Lương Văn Phúc', provinceCode: '40', district: 'TP. Vinh', ward: 'Phường Hưng Bình', street: '83 Lê Mao' },
  { no: 37, fullName: 'Đoàn Thị Hồng Nhung', provinceCode: '68', district: 'TP. Đà Lạt', ward: 'Phường 3', street: '14 Phan Đình Phùng' },
  { no: 38, fullName: 'Tạ Quang Vinh', provinceCode: '77', district: 'TP. Vũng Tàu', ward: 'Phường Thắng Tam', street: '61 Trương Công Định' },
  { no: 39, fullName: 'La Thị Quỳnh Anh', provinceCode: '19', district: 'TP. Thái Nguyên', ward: 'Phường Quang Trung', street: '8 Hoàng Văn Thụ' },
  { no: 40, fullName: 'Thái Bá Duy', provinceCode: '27', district: 'TP. Bắc Ninh', ward: 'Phường Suối Hoa', street: '37 Lý Thái Tổ' },
  { no: 41, fullName: 'Diệp Thị Mỹ Duyên', provinceCode: '80', district: 'TP. Tân An', ward: 'Phường 2', street: '21 Hùng Vương' },
  { no: 42, fullName: 'Khuất Văn Thắng', provinceCode: '91', district: 'TP. Rạch Giá', ward: 'Phường Vĩnh Thanh', street: '90 Nguyễn Trung Trực' },
  { no: 43, fullName: 'Từ Thị Hoài Thương', provinceCode: '66', district: 'TP. Buôn Ma Thuột', ward: 'Phường Tân Lợi', street: '55 Lê Duẩn' },
  { no: 44, fullName: 'Âu Đức Minh', provinceCode: '38', district: 'TP. Thanh Hoá', ward: 'Phường Điện Biên', street: '17 Trần Phú' },
  { no: 45, fullName: 'Bạch Thị Tuyết Mai', provinceCode: '52', district: 'TP. Quy Nhơn', ward: 'Phường Nguyễn Văn Cừ', street: '33 Nguyễn Huệ' },
];
const EXISTING_CUSTOMER_EMAILS = [1, 2, 3, 4, 5].map((i) => `khach${i}@ecofashion.vn`);
const ARGON2 = { type: 2 as const, memoryCost: 19456, timeCost: 2, parallelism: 1 }; // argon2id — cùng tham số identity.seed

interface AddrSnap { recipientName: string; phone: string; provinceCode: string | null; provinceName: string; districtName: string | null; wardName: string | null; street: string }
interface CustomerRef { key: string; fullName: string; phone: string; weight: number; addr: AddrSnap; userId: string | null; isNew: boolean; def: CustomerDef | null; firstOrderAt: number | null }
interface ImageCtx { url: string; colorCode: string | null; isPrimary: boolean }
interface VariantCtx { id: string; sku: string; colorCode: string | null; colorName: string | null; sizeCode: string | null; price: bigint; stock: number; reserved: number; optionsText: string }
interface ProductCtx { id: string; slug: string; name: string; categorySlug: string; shopId: string; basePrice: bigint; variants: VariantCtx[]; images: ImageCtx[]; weight: number }
interface ShopCtx { id: string; code: string; slug: string; name: string; status: string; commissionRate: string; ownerUserId: string; products: ProductCtx[] }
interface PromoDef {
  id: string; code: string; name: string; type: string; value: string; maxDiscount: bigint | null; minOrder: bigint; usageLimit: number | null; perUser: number | null; usedCount: number;
  appliesTo: string; targets: Array<{ targetType: string; targetRef: string }>; startsAt: number; endsAt: number; scope: 'platform' | 'shop'; shopId: string | null;
}
interface PromoLine { productId: string; categorySlug: string; lineTotal: bigint }
interface PromoBasket { subtotal: bigint; shippingFee: bigint; lines: PromoLine[] }

interface LinePlan { product: ProductCtx; variant: VariantCtx; qty: number; unitPrice: bigint; lineTotal: bigint; imageUrl: string | null; color: string; size: string }
interface StockEvt { at: number; ord: number; variantId: string; productId: string; type: StockType; qty: number; refType: 'order' | 'return'; refId: string; stockAfter: number }
interface ReturnPlan { requestedAt: number; processedAt: number | null; refundedAt: number | null; state: ReturnState; reason: string; detail: string; rejectReason: string | null }
interface Lifecycle {
  status: Status;
  idx: number; // chỉ số trong CHAIN (−1 nếu đã huỷ)
  s: number[]; // s[0..5] mốc thời gian (ms) — chỉ s[k] với k ≤ idx có hiệu lực
  autoComplete: boolean;
  cancel: { kind: CancelKind; at: number; reason: string } | null;
  paidAt: number | null;
  unpaidOnline: boolean;
  payDelay: number;
  ret: ReturnPlan | null;
  cancelRefund: { at: number; done: boolean } | null;
}
interface ChildPlan {
  seq: number;
  code: string;
  shop: ShopCtx;
  lines: LinePlan[];
  subtotal: bigint;
  shippingFee: bigint;
  shopDiscount: bigint;
  platformDiscount: bigint;
  discount: bigint;
  total: bigint;
  itemCount: number;
  shopPromo: { promo: PromoDef; discount: bigint } | null;
  method: PayMethod;
  life: Lifecycle;
  note: string | null;
  refundAmount: bigint; // số hoàn nếu có đổi trả (1 đơn vị dòng đầu, trừ phần giảm giá theo tỉ lệ)
  events: StockEvt[];
  ids: { bankRef: string; payosCode: string; linkId: string };
}
interface GroupPlan { idx: number; code: string; customer: CustomerRef; createdAt: number; children: ChildPlan[]; platform: { promo: PromoDef; discount: bigint } | null }

interface PlanCtx {
  now: number;
  freeThreshold: bigint;
  defaultFee: bigint;
  codMax: bigint;
  provinceFee: Map<string, bigint>;
  promos: PromoDef[];
  usedByPromo: Map<string, number>;
  usedByUser: Map<string, number>;
  staff: { sales: string | null; warehouse: string | null; accountant: string | null };
  evtOrd: number;
}

/* ============================================================================================== tiện ích tất định */

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const rngFor = (...parts: Array<string | number>): Rng => mulberry32((SEED ^ hash32(parts.join(':'))) >>> 0);
const rolls = (rng: Rng, n: number): number[] => Array.from({ length: n }, () => rng());
const between = (r: number, lo: number, hi: number): number => lo + r * (hi - lo);
const pickOf = <T>(r: number, arr: readonly T[]): T => arr[Math.min(arr.length - 1, Math.floor(r * arr.length))];

function weightedPick<T>(r: number, items: ReadonlyArray<readonly [T, number]>): T {
  const total = items.reduce((s, [, w]) => s + w, 0);
  const x = r * total;
  let acc = 0;
  for (const [it, w] of items) {
    acc += w;
    if (x < acc) return it;
  }
  return items[items.length - 1][0];
}

/* UUID tất định (dạng v5) theo khoá — id đặt trước để dùng createMany mà vẫn nối được khoá ngoại. */
function uid(key: string): string {
  const h = createHash('sha1').update(`activity-seed:${key}`).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

const code5 = (n: number): string => String(n).padStart(5, '0');
const dt = (ms: number): Date => new Date(ms);
const dtOrNull = (ms: number | null): Date | null => (ms === null ? null : new Date(ms));
const hex32 = (key: string): string => createHash('sha1').update(`activity-seed:${key}`).digest('hex').slice(0, 32);

/* ============================================================================================== voucher (cùng công thức PromotionService) */

function discountOf(p: PromoDef, b: PromoBasket): bigint {
  const base = b.lines
    .filter((l) => p.appliesTo === 'all' || p.targets.some((t) => (t.targetType === 'category' && t.targetRef === l.categorySlug) || (t.targetType === 'product' && t.targetRef === l.productId)))
    .reduce((s, l) => s + l.lineTotal, 0n);
  if (p.type === 'free_shipping') return base > 0n ? b.shippingFee : 0n;
  if (base <= 0n) return 0n;
  if (p.type === 'percentage') {
    const d = percentOf(base, Number(p.value));
    return p.maxDiscount !== null ? minVnd(d, p.maxDiscount) : d;
  }
  return minVnd(vnd(p.value), base);
}

/* Mã dùng được tại thời điểm `at` cho giỏ này? Trả số giảm (>0) hoặc null. Kiểm cùng điều kiện PromotionService.evaluate (hạn, hạn mức, đơn tối thiểu, mỗi khách). */
function quotePromo(ctx: PlanCtx, p: PromoDef, basket: PromoBasket, at: number, shopId: string | null, customerKey: string): bigint | null {
  if (p.startsAt > at || p.endsAt < at) return null;
  if (p.scope === 'shop' && (!p.shopId || p.shopId !== shopId)) return null;
  if (p.usageLimit !== null && (ctx.usedByPromo.get(p.id) ?? p.usedCount) >= p.usageLimit) return null;
  if (basket.subtotal < p.minOrder) return null;
  if (p.perUser !== null && (ctx.usedByUser.get(`${p.id}|${customerKey}`) ?? 0) >= p.perUser) return null;
  const d = discountOf(p, basket);
  return d > 0n ? d : null;
}

function commitPromo(ctx: PlanCtx, p: PromoDef, customerKey: string): void {
  ctx.usedByPromo.set(p.id, (ctx.usedByPromo.get(p.id) ?? p.usedCount) + 1);
  const k = `${p.id}|${customerKey}`;
  ctx.usedByUser.set(k, (ctx.usedByUser.get(k) ?? 0) + 1);
}

/* Phân bổ voucher về từng đơn con — bản sao OrderService.applyVouchers (voucher shop → đúng đơn; voucher sàn theo tỉ lệ, dồn phần dư vào gói cuối có trọng số). */
function allocateVouchers(groups: Array<{ subtotal: bigint; shippingFee: bigint; shopDiscountRaw: bigint }>, platform: { type: string; discount: bigint } | null) {
  const weight = (g: { subtotal: bigint; shippingFee: bigint }): bigint => (platform?.type === 'free_shipping' ? g.shippingFee : g.subtotal);
  const totalWeight = groups.reduce((s, g) => s + weight(g), 0n);
  const lastWeighted = groups.reduce((idx, g, i) => (weight(g) > 0n ? i : idx), -1);
  let allocated = 0n;
  return groups.map((g, i) => {
    let platformShare = 0n;
    if (platform && totalWeight > 0n && weight(g) > 0n) {
      platformShare = i === lastWeighted ? platform.discount - allocated : (platform.discount * weight(g)) / totalWeight;
      if (i !== lastWeighted) allocated += platformShare;
    }
    const cap = g.subtotal + g.shippingFee;
    const shopDiscount = g.shopDiscountRaw > cap ? cap : g.shopDiscountRaw;
    const platformDiscount = platformShare > cap - shopDiscount ? cap - shopDiscount : platformShare;
    const discount = shopDiscount + platformDiscount;
    return { shopDiscount, platformDiscount, discount, total: cap - discount };
  });
}

/* ============================================================================================== vòng đời đơn */

function rollTarget(r: number, ageDays: number, suspended: boolean): Target {
  if (suspended) return r < 0.85 ? 'completed' : 'cancelled';
  if (ageDays > 21) return weightedPick<Target>(r, [['completed', 84], ['cancelled', 7], ['return', 6], ['delivered', 3]]);
  if (ageDays >= 7) return weightedPick<Target>(r, [['completed', 52], ['delivered', 24], ['shipping', 7], ['cancelled', 11], ['return', 6]]);
  return weightedPick<Target>(r, [['pending', 20], ['confirmed', 15], ['packing', 16], ['shipping', 22], ['delivered', 20], ['cancelled', 7]]);
}

/*
 * Dựng mốc thời gian + trạng thái cho MỘT đơn con. Mọi mốc tăng dần, ≤ now − 3 phút; completedAt chỉ có khi completed; COD chỉ paid khi delivered/completed;
 * đơn online chỉ confirmed khi đã paid (như OrderService.updateStatus). Trạng thái mục tiêu bị hạ xuống nếu đơn còn quá mới để đạt tới bước đó; đơn chưa kết thúc
 * mà đã "cũ" thì được đẩy sang bước kế (không để đơn pending/đóng gói tồn đọng nhiều ngày).
 */
function planLifecycle(a: { r: number[]; now: number; createdAt: number; method: PayMethod; target: Target }): Lifecycle {
  const { r, now, createdAt, method, target } = a;
  const ageDays = (now - createdAt) / DAY;
  const online = method !== METHOD.COD;
  const expiryMs = online ? 30 * MIN : 0;
  const payDelay = (1 + r[5] * 11) * MIN;
  const limit = now - 3 * MIN;

  const s: number[] = [createdAt];
  s[1] = createdAt + (online ? payDelay + (0.5 + r[6] * 11.5) * HOUR : (1 + r[6] * 13) * HOUR);
  s[2] = s[1] + (2 + r[7] * 18) * HOUR;
  s[3] = s[2] + (4 + r[8] * 20) * HOUR;
  s[4] = s[3] + (24 + r[9] * 72) * HOUR;
  const autoComplete = r[11] >= 0.2;
  s[5] = autoComplete ? s[4] + 7 * DAY + r[10] * 2 * HOUR : s[4] + (1 + r[10] * 5) * DAY;
  let reach = 0;
  for (let k = 1; k <= 5; k += 1) {
    if (s[k] <= limit) reach = k;
    else break;
  }

  // ---- huỷ
  let cancel: Lifecycle['cancel'] = null;
  if (target === 'cancelled') {
    const kind: CancelKind =
      method === METHOD.COD
        ? weightedPick<CancelKind>(r[2], [['customer', 65], ['shop', 35]])
        : weightedPick<CancelKind>(r[2], [['expired', 35], ['customer', 45], ['shop', 20]]);
    let at: number;
    let reason: string;
    if (kind === 'expired') {
      at = createdAt + expiryMs + (1 + r[4] * 9) * MIN;
      reason = 'Quá hạn thanh toán PayOS';
    } else if (kind === 'customer') {
      at = createdAt + (expiryMs > 0 ? Math.min((10 + r[4] * 470) * MIN, 0.8 * expiryMs) : (10 + r[4] * 470) * MIN);
      reason = pickOf(r[3], CANCEL_REASONS_CUSTOMER);
    } else {
      at = s[1] + (1 + r[4] * 19) * HOUR;
      reason = pickOf(r[3], CANCEL_REASONS_SHOP);
    }
    if (at <= limit) cancel = { kind, at, reason };
  }

  // ---- trạng thái
  let idx = -1;
  if (!cancel) {
    let t = target === 'return' ? (r[22] < 0.75 ? 5 : 4) : target === 'cancelled' ? 0 : CHAIN.indexOf(target);
    t = Math.min(t, reach);
    const nonTerminal = target === 'pending' || target === 'confirmed' || target === 'packing' || target === 'shipping' || target === 'cancelled';
    if (nonTerminal) {
      const maxAge = [40 * HOUR, 36 * HOUR, 40 * HOUR, 9 * DAY];
      while (t < 4 && t + 1 <= reach && now - s[t] > maxAge[t]) t += 1;
    }
    // "delivered" của đơn 7–21 ngày: dời mốc giao về gần hiện tại để đơn không treo quá hạn tự hoàn tất
    if (t === 4 && target === 'delivered' && ageDays >= 7 && ageDays <= 21) {
      const wanted = now - (0.5 + r[20] * 6) * DAY;
      if (s[4] < wanted) s[4] = Math.min(Math.max(wanted, s[3] + 12 * HOUR), limit);
    }
    if (t === 3 && target === 'shipping' && ageDays >= 7) {
      const wanted = now - (0.3 + r[20] * 4) * DAY;
      if (s[3] < wanted) s[3] = Math.min(Math.max(wanted, s[2] + 4 * HOUR), limit);
    }
    idx = t;
  }
  const status: Status = cancel ? 'cancelled' : CHAIN[idx];

  // ---- thanh toán
  const needsOnlinePay = online;
  let paidAt: number | null = null;
  let unpaidOnline = false;
  if (cancel) {
    if (cancel.kind === 'shop' && needsOnlinePay) paidAt = createdAt + payDelay;
  } else if (idx >= 1) {
    paidAt = needsOnlinePay ? createdAt + payDelay : idx >= 4 ? s[4] : null;
  } else if (needsOnlinePay) {
    const canBeUnpaid = now - createdAt < 30 * MIN;
    const paidTime = createdAt + payDelay;
    unpaidOnline = paidTime > limit || (canBeUnpaid && r[12] < 0.55);
    if (!unpaidOnline) paidAt = paidTime;
  }

  // ---- huỷ sau khi shop xác nhận + đã thu tiền online → yêu cầu hoàn tiền
  let cancelRefund: Lifecycle['cancelRefund'] = null;
  if (cancel?.kind === 'shop' && paidAt !== null) {
    const at = cancel.at + (3 + r[23] * 33) * HOUR;
    cancelRefund = { at, done: at <= limit };
  }

  // ---- đổi trả (chỉ đơn đã giao, trong hạn 7 ngày kể từ lúc giao)
  let ret: ReturnPlan | null = null;
  if (target === 'return' && (status === 'delivered' || status === 'completed')) {
    const requestedAt = s[4] + (0.25 + r[15] * 4.75) * DAY;
    if (requestedAt <= now - HOUR) {
      const processed0 = requestedAt + (3 + r[16] * 37) * HOUR;
      const refunded0 = processed0 + (12 + r[17] * 60) * HOUR;
      const want = ageDays > 21 ? weightedPick<ReturnState>(r[18], [['refunded', 70], ['rejected', 30]]) : weightedPick<ReturnState>(r[18], [['requested', 25], ['approved', 20], ['refunded', 40], ['rejected', 15]]);
      let state: ReturnState = want;
      if (processed0 > limit) state = 'requested';
      else if (want === 'refunded' && refunded0 > limit) state = 'approved';
      const rr = pickOf(r[19], RETURN_REASONS);
      ret = {
        requestedAt,
        processedAt: state === 'requested' ? null : processed0,
        refundedAt: state === 'refunded' ? refunded0 : null,
        state,
        reason: rr.reason,
        detail: rr.detail,
        rejectReason: state === 'rejected' ? pickOf(r[24], RETURN_REJECT_REASONS) : null,
      };
    }
  }
  return { status, idx, s, autoComplete, cancel, paidAt, unpaidOnline, payDelay, ret, cancelRefund };
}

/* ============================================================================================== chọn dòng hàng */

function pickLines(lr: Rng, shop: ShopCtx, wantReturn: boolean): LinePlan[] {
  const wantLines = weightedPick(lr(), [[1, 45], [2, 30], [3, 17], [4, 8]] as const);
  const nLines = Math.min(wantLines, shop.products.length);
  const chosen: ProductCtx[] = [];
  for (let k = 0; k < nLines; k += 1) {
    const pool = shop.products.filter((p) => !chosen.includes(p));
    chosen.push(weightedPick(lr(), pool.map((p) => [p, p.weight] as const)));
  }
  const lines = chosen.map((p): LinePlan => {
    const v = pickOf(lr(), p.variants);
    const qtyRoll = weightedPick(lr(), [[1, 62], [2, 28], [3, 10]] as const);
    const highRoll = lr();
    const unitPrice = v.price;
    const qty = unitPrice >= 2_000_000n && highRoll < 0.9 ? 1 : qtyRoll;
    const img = p.images.find((i) => i.colorCode !== null && i.colorCode === v.colorCode) ?? p.images.find((i) => i.isPrimary) ?? p.images[0];
    return { product: p, variant: v, qty, unitPrice, lineTotal: unitPrice * BigInt(qty), imageUrl: img?.url ?? null, color: (v.colorName ?? v.optionsText).slice(0, 120), size: (v.sizeCode ?? '').slice(0, 40) };
  });
  // đơn có đổi trả cần ≥ 2 sản phẩm để đổi trả MỘT PHẦN (không biến thành đơn "returned")
  if (wantReturn && lines.reduce((n, l) => n + l.qty, 0) < 2) {
    lines[0].qty = 2;
    lines[0].lineTotal = lines[0].unitPrice * 2n;
  }
  return lines;
}

/* ============================================================================================== lập kế hoạch toàn bộ nhóm */

interface RawGroup { idx: number; shopIdxs: number[]; suspended: boolean }

function allocateShopOrders(shops: ShopCtx[], budget: number): number[] {
  const weights = shops.map((s) => SHOP_WEIGHTS[s.slug] ?? 4);
  const sumW = weights.reduce((a, b) => a + b, 0);
  const alloc = weights.map((w) => Math.max(MIN_ORDERS_PER_SHOP, Math.floor((budget * w) / sumW)));
  let sum = alloc.reduce((a, b) => a + b, 0);
  const order = weights.map((w, i) => [w, i] as const).sort((x, y) => y[0] - x[0] || x[1] - y[1]).map(([, i]) => i);
  for (let guard = 0; sum < budget && guard < 10_000; guard += 1) {
    alloc[order[guard % order.length]] += 1;
    sum += 1;
  }
  for (let guard = 0; sum > budget && guard < 10_000; guard += 1) {
    const i = order[guard % order.length];
    if (alloc[i] > MIN_ORDERS_PER_SHOP) {
      alloc[i] -= 1;
      sum -= 1;
    }
  }
  return alloc;
}

function packGroups(approved: ShopCtx[], alloc: number[], suspended: ShopCtx[]): RawGroup[] {
  const plan = rngFor('pack');
  const slots: number[] = [];
  alloc.forEach((n, i) => {
    for (let k = 0; k < n; k += 1) slots.push(i);
  });
  for (let i = slots.length - 1; i > 0; i -= 1) {
    const j = Math.floor(plan() * (i + 1));
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }
  const groups: RawGroup[] = [];
  while (slots.length > 0) {
    const first = slots.shift() as number;
    const members = [first];
    const multi = plan() < MULTI_SHOP_RATIO;
    const k = plan() < 0.75 ? 2 : 3;
    if (multi) {
      for (let j = 1; j < k; j += 1) {
        const at = slots.findIndex((s) => !members.includes(s));
        if (at < 0) break;
        members.push(slots.splice(at, 1)[0]);
      }
    }
    groups.push({ idx: groups.length, shopIdxs: members, suspended: false });
  }
  // shop bị khoá: chỉ đơn lẻ, đơn cũ
  suspended.forEach((_, si) => {
    for (let k = 0; k < SUSPENDED_SHOP_ORDERS; k += 1) groups.push({ idx: groups.length, shopIdxs: [approved.length + si], suspended: true });
  });
  return groups;
}

function buildPlans(ctx: PlanCtx, shops: ShopCtx[], customers: CustomerRef[], rawGroups: RawGroup[]): GroupPlan[] {
  const now = ctx.now;
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const startOfToday = dayStart.getTime();

  // thời điểm tạo + khoá sắp xếp (cũ → mới) của từng nhóm — chỉ phụ thuộc PRNG, không phụ thuộc DB
  const timed = rawGroups.map((g) => {
    const gr = rolls(rngFor('group', g.idx), 24);
    const daysAgo = g.suspended ? SUSPENDED_MIN_AGE_DAYS + Math.floor(gr[0] * (HISTORY_DAYS - 1 - SUSPENDED_MIN_AGE_DAYS + 1)) : Math.min(HISTORY_DAYS - 1, Math.floor(HISTORY_DAYS * gr[0] ** 1.6));
    const hour = weightedPick(gr[1], HOUR_WEIGHTS.map((w, h) => [h, w] as const));
    const minuteOfDay = hour * 60 + Math.floor(gr[2] * 60);
    return { g, gr, daysAgo, minuteOfDay, key: daysAgo * 1440 + (1439 - minuteOfDay) };
  });
  timed.sort((x, y) => y.key - x.key || x.g.idx - y.g.idx);

  const plans: GroupPlan[] = [];
  let childSeq = 0;
  timed.forEach((t, gi) => {
    const { g, gr, daysAgo, minuteOfDay } = t;
    const groupNo = gi + 1;
    const groupCode = `${GROUP_PREFIX}${code5(groupNo)}`;
    const customer = weightedPick(gr[3], customers.map((c) => [c, c.weight] as const));
    // hôm nay: nén cả ngày vào [00:00, now − 5 phút] để không có đơn ở tương lai
    const cutoff = Math.max(0, now - 5 * MIN - startOfToday);
    const base = daysAgo === 0 ? startOfToday + Math.floor((minuteOfDay / 1440) * cutoff) : startOfToday - daysAgo * DAY + minuteOfDay * MIN + Math.floor(gr[8] * 60) * 1000;
    const createdAt = Math.min(base, now - 5 * MIN);
    const ageDays = (now - createdAt) / DAY;

    // ---- đơn con: dòng hàng + phí ship
    const memberShops = g.shopIdxs.map((i) => shops[i]);
    const kids = memberShops.map((shop, j) => {
      const r = rolls(rngFor('child', g.idx, j), 40);
      const target = rollTarget(r[0], ageDays, g.suspended);
      const lines = pickLines(rngFor('lines', g.idx, j), shop, target === 'return');
      const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0n);
      const provFee = ctx.provinceFee.get(customer.addr.provinceCode ?? '') ?? ctx.defaultFee;
      const shippingFee = ctx.freeThreshold > 0n && subtotal >= ctx.freeThreshold ? 0n : provFee;
      return { shop, r, target, lines, subtotal, shippingFee };
    });
    const wholeBasket: PromoBasket = {
      subtotal: kids.reduce((s, k) => s + k.subtotal, 0n),
      shippingFee: kids.reduce((s, k) => s + k.shippingFee, 0n),
      lines: kids.flatMap((k) => k.lines.map((l) => ({ productId: l.product.id, categorySlug: l.product.categorySlug, lineTotal: l.lineTotal }))),
    };

    // ---- voucher: tối đa 1 mã sàn (cả giỏ) + 1 mã shop cho mỗi đơn con
    const choose = (withVouchers: boolean) => {
      let platform: { promo: PromoDef; discount: bigint } | null = null;
      const shopPicks: Array<{ promo: PromoDef; discount: bigint } | null> = kids.map(() => null);
      if (withVouchers) {
        if (gr[6] < 0.22) {
          const cands = ctx.promos.filter((p) => p.scope === 'platform').map((p) => ({ promo: p, discount: quotePromo(ctx, p, wholeBasket, createdAt, null, customer.key) })).filter((c): c is { promo: PromoDef; discount: bigint } => c.discount !== null);
          if (cands.length > 0) platform = pickOf(gr[7], cands);
        }
        kids.forEach((k, j) => {
          if (k.r[26] >= 0.34) return;
          const basket: PromoBasket = { subtotal: k.subtotal, shippingFee: k.shippingFee, lines: k.lines.map((l) => ({ productId: l.product.id, categorySlug: l.product.categorySlug, lineTotal: l.lineTotal })) };
          const cands = ctx.promos.filter((p) => p.scope === 'shop' && p.shopId === k.shop.id).map((p) => ({ promo: p, discount: quotePromo(ctx, p, basket, createdAt, k.shop.id, customer.key) })).filter((c): c is { promo: PromoDef; discount: bigint } => c.discount !== null);
          if (cands.length > 0) shopPicks[j] = pickOf(k.r[27], cands);
        });
      }
      const alloc = allocateVouchers(kids.map((k, j) => ({ subtotal: k.subtotal, shippingFee: k.shippingFee, shopDiscountRaw: shopPicks[j]?.discount ?? 0n })), platform ? { type: platform.promo.type, discount: platform.discount } : null);
      return { platform, shopPicks, alloc };
    };
    let chosen = choose(true);
    if (chosen.alloc.some((a) => a.total < MIN_ORDER_TOTAL)) chosen = choose(false); // không để đơn 0đ
    if (chosen.platform) commitPromo(ctx, chosen.platform.promo, customer.key);
    chosen.shopPicks.forEach((sp) => {
      if (sp) commitPromo(ctx, sp.promo, customer.key);
    });

    // ---- phương thức thanh toán chung cả nhóm (COD bị loại khi đơn con vượt hạn mức COD)
    const allowCod = kids.every((k, j) => (ctx.codMax === 0n || chosen.alloc[j].total <= ctx.codMax)); // hạn mức 0 = không giới hạn (như OrderService)
    const method: PayMethod = weightedPick(allowCod ? gr[4] : gr[5], allowCod ? METHOD_WEIGHTS : METHOD_WEIGHTS.filter(([m]) => m !== METHOD.COD));

    // ---- đơn con: vòng đời + thanh toán + kho
    const children: ChildPlan[] = kids.map((k, j) => {
      childSeq += 1;
      const seq = childSeq;
      const code = `${CODE_PREFIX}${code5(seq)}`;
      const al = chosen.alloc[j];
      const life = planLifecycle({ r: k.r, now, createdAt, method, target: k.target });
      const itemCount = k.lines.reduce((n, l) => n + l.qty, 0);
      const discount = al.discount;
      const hasDiscount = k.subtotal > 0n && discount > 0n;
      const l0 = k.lines[0];
      const refundAmount = hasDiscount ? l0.unitPrice - (l0.unitPrice * discount) / k.subtotal : l0.unitPrice;
      const events: StockEvt[] = [];
      const push = (at: number, type: StockType, l: LinePlan, qty: number, refType: 'order' | 'return') => {
        ctx.evtOrd += 1;
        events.push({ at, ord: ctx.evtOrd, variantId: l.variant.id, productId: l.product.id, type, qty, refType, refId: code, stockAfter: 0 });
      };
      for (const l of k.lines) {
        push(createdAt, 'RESERVE', l, l.qty, 'order');
        if (life.cancel) {
          if (life.cancel.kind === 'shop') {
            push(life.s[1], 'SALE', l, l.qty, 'order');
            push(life.cancel.at, 'RETURN', l, l.qty, 'order');
          } else {
            push(life.cancel.at, 'RELEASE', l, l.qty, 'order');
          }
        } else if (life.idx >= 1) {
          push(life.s[1], 'SALE', l, l.qty, 'order');
        }
      }
      if (life.ret && life.ret.processedAt !== null && (life.ret.state === 'approved' || life.ret.state === 'refunded')) push(life.ret.processedAt, 'RETURN', l0, 1, 'return');

      const ordR = k.r[21];
      return {
        seq,
        code,
        shop: k.shop,
        lines: k.lines,
        subtotal: k.subtotal,
        shippingFee: k.shippingFee,
        shopDiscount: al.shopDiscount,
        platformDiscount: al.platformDiscount,
        discount,
        total: al.total,
        itemCount,
        shopPromo: chosen.shopPicks[j],
        method,
        life,
        note: ordR < 0.14 ? pickOf(k.r[13], CUSTOMER_NOTES) : null,
        refundAmount,
        events,
        ids: {
          bankRef: `FT${String(26_000_000 + seq * 100 + Math.floor(k.r[14] * 100)).padStart(8, '0')}`,
          payosCode: String(createdAt * 1000 + (seq % 1000)),
          linkId: hex32(`link:${code}`),
        },
      };
    });
    plans.push({ idx: g.idx, code: groupCode, customer, createdAt, children, platform: chosen.platform });
    if (customer.firstOrderAt === null || createdAt < customer.firstOrderAt) customer.firstOrderAt = createdAt;
  });
  return plans;
}

/* ============================================================================================== mô phỏng kho theo thời gian */

interface StockBaseline { stock: number; reserved: number; productId: string; shopId: string; sku: string; price: bigint }

/* Trả tồn cần nhập bổ sung theo biến thể, và điền `stockAfter` cho từng sự kiện kho (đã cộng phần nhập bổ sung). */
function simulateStock(newGroups: GroupPlan[], baseline: Map<string, StockBaseline>): Map<string, number> {
  const byVariant = new Map<string, StockEvt[]>();
  for (const g of newGroups) for (const c of g.children) for (const e of c.events) byVariant.set(e.variantId, [...(byVariant.get(e.variantId) ?? []), e]);
  const topUp = new Map<string, number>();
  for (const [variantId, evts] of byVariant) {
    const b = baseline.get(variantId);
    if (!b) throw new Error(`Thiếu biến thể ${variantId} trong kho cơ sở`);
    evts.sort((x, y) => x.at - y.at || x.ord - y.ord);
    const run = (offset: number, assign: boolean): number => {
      let stock = b.stock + offset;
      let reserved = b.reserved;
      let minAvail = stock - reserved;
      for (const e of evts) {
        if (e.type === 'RESERVE') reserved += e.qty;
        else if (e.type === 'RELEASE') reserved -= e.qty;
        else if (e.type === 'SALE') {
          stock -= e.qty;
          reserved -= e.qty;
        } else stock += e.qty;
        if (assign) e.stockAfter = stock;
        minAvail = Math.min(minAvail, stock - reserved); // stock − reserved ≥ 0 kéo theo reserved ≤ stock; reserved ≥ 0 luôn đúng vì mỗi RELEASE/SALE đi sau RESERVE của chính nó
      }
      return minAvail;
    };
    const need = Math.max(0, STOCK_MARGIN - run(0, false));
    run(need, true);
    if (need > 0) topUp.set(variantId, need);
  }
  return topUp;
}

/* ============================================================================================== ghi DB */

interface WriteCtx { staff: PlanCtx['staff']; now: number }

function actorOf(shop: ShopCtx, stage: 'confirm' | 'pack' | 'ship', staff: PlanCtx['staff']): string | null {
  if (shop.id === FITLY_OFFICIAL_SHOP_ID) return stage === 'confirm' ? staff.sales : staff.warehouse;
  return shop.ownerUserId;
}

async function writeGroup(prisma: PrismaClient, g: GroupPlan, w: WriteCtx): Promise<void> {
  const userId = g.customer.userId as string;
  const addr = g.customer.addr;
  const shippingAddress = [addr.street, addr.wardName, addr.districtName, addr.provinceName].filter(Boolean).join(', ');
  const groupId = uid(`group:${g.code}`);
  const createdAt = dt(g.createdAt);

  const orders: Prisma.OrderCreateManyInput[] = [];
  const items: Prisma.OrderItemCreateManyInput[] = [];
  const histories: Prisma.OrderStatusHistoryCreateManyInput[] = [];
  const payments: Prisma.PaymentCreateManyInput[] = [];
  const payTxs: Prisma.PaymentTransactionCreateManyInput[] = [];
  const usages: Prisma.PromotionUsageCreateManyInput[] = [];
  const returns: Prisma.ReturnRequestCreateManyInput[] = [];
  const returnItems: Prisma.ReturnRequestItemCreateManyInput[] = [];
  const refunds: Prisma.RefundCreateManyInput[] = [];
  const movements: Prisma.StockMovementCreateManyInput[] = [];
  const variantDelta = new Map<string, { ds: number; dr: number }>();
  const soldDelta = new Map<string, number>();
  const usedDelta = new Map<string, number>();

  const allCancelled = g.children.every((c) => c.life.status === 'cancelled');
  if (g.platform) {
    usages.push({
      promotionId: g.platform.promo.id, userId, orderCode: g.code, discountAmount: g.platform.discount.toString(), createdAt,
      releasedAt: allCancelled ? dt(Math.max(...g.children.map((c) => c.life.cancel?.at ?? 0))) : null,
    });
    if (!allCancelled) usedDelta.set(g.platform.promo.id, (usedDelta.get(g.platform.promo.id) ?? 0) + 1);
  }

  for (const c of g.children) {
    const L = c.life;
    const orderId = uid(`order:${c.code}`);
    const paymentId = uid(`payment:${c.code}`);
    const online = c.method !== METHOD.COD;
    const s = L.s;
    const st = (k: number): number | null => (L.cancel ? (k === 1 && L.cancel.kind === 'shop' ? s[1] : null) : L.idx >= k ? s[k] : null);
    const confirmedAt = st(1);
    const packedAt = st(2);
    const shippedAt = st(3);
    const deliveredAt = st(4);
    const completedAt = st(5);
    const shopActor = (stage: 'confirm' | 'pack' | 'ship') => actorOf(c.shop, stage, w.staff);

    // ---- thanh toán: trạng thái cuối cùng
    const returnDone = L.ret?.state === 'refunded';
    const cancelRefundDone = L.cancelRefund?.done === true;
    const returnRefund = L.ret && (L.ret.state === 'approved' || L.ret.state === 'refunded') ? c.refundAmount : 0n;
    let payStatus: string;
    let orderPay: string;
    if (L.cancel) {
      if (L.paidAt !== null) {
        payStatus = cancelRefundDone ? PAY_STATUS.REFUNDED : PAY_STATUS.PAID;
        orderPay = cancelRefundDone ? 'refunded' : 'paid';
      } else {
        payStatus = PAY_STATUS.CANCELLED;
        orderPay = 'unpaid';
      }
    } else if (L.paidAt !== null) {
      payStatus = returnDone ? PAY_STATUS.PARTIALLY_REFUNDED : PAY_STATUS.PAID;
      orderPay = returnDone ? 'partially_refunded' : 'paid';
    } else {
      payStatus = PAY_STATUS.PENDING;
      orderPay = 'unpaid';
    }
    const refundedAmount = cancelRefundDone ? c.total : returnDone ? returnRefund : 0n;
    const payExpires = online ? g.createdAt + 30 * MIN : null;
    const orderExpires = c.method === METHOD.PAYOS ? payExpires : null;
    const paymentExpiresAtOnOrder = L.paidAt !== null ? null : orderExpires;

    // ---- đổi trả + hoàn tiền (dòng đầu, 1 đơn vị)
    const ret = L.ret;
    const retActor = c.shop.id === FITLY_OFFICIAL_SHOP_ID ? w.staff.sales : c.shop.ownerUserId;
    const refundMethod = c.method === METHOD.PAYOS ? 'gateway' : 'manual_transfer'; // COD hoàn thủ công
    const refundRef = (kind: string): string => (c.method === METHOD.PAYOS ? `payos-refund:${c.ids.payosCode}${kind}` : `HT-${c.code}${kind}`);

    // ---- lịch sử trạng thái
    const hist: Array<{ from: string | null; to: string; at: number; actor: string | null; note: string | null }> = [{ from: null, to: 'pending', at: g.createdAt, actor: userId, note: 'Khách đặt hàng' }];
    if (L.cancel) {
      if (L.cancel.kind === 'shop') hist.push({ from: 'pending', to: 'confirmed', at: s[1], actor: shopActor('confirm'), note: null });
      hist.push({ from: L.cancel.kind === 'shop' ? 'confirmed' : 'pending', to: 'cancelled', at: L.cancel.at, actor: L.cancel.kind === 'customer' ? userId : L.cancel.kind === 'shop' ? shopActor('confirm') : null, note: L.cancel.reason });
      if (L.cancelRefund?.done) hist.push({ from: 'cancelled', to: 'cancelled', at: L.cancelRefund.at, actor: null, note: `Đã hoàn ${formatVnd(c.total)}` });
    } else {
      for (let i = 1; i <= L.idx; i += 1) {
        hist.push({ from: CHAIN[i - 1], to: CHAIN[i], at: s[i], actor: i === 1 ? shopActor('confirm') : i <= 3 ? shopActor(i === 2 ? 'pack' : 'ship') : null, note: i === 5 ? (L.autoComplete ? 'Tự động hoàn tất sau 7 ngày' : 'Hoàn tất đơn hàng') : null });
      }
      if (ret && ret.processedAt !== null && (ret.state === 'approved' || ret.state === 'refunded')) {
        const statusThen = L.status === 'completed' && completedAt !== null && ret.processedAt < completedAt ? 'delivered' : L.status;
        hist.push({ from: statusThen, to: statusThen, at: ret.processedAt, actor: retActor, note: `Đổi trả một phần được duyệt — hoàn ${formatVnd(c.refundAmount)}` });
        if (ret.refundedAt !== null) hist.push({ from: statusThen, to: statusThen, at: ret.refundedAt, actor: null, note: `Đã hoàn ${formatVnd(c.refundAmount)}` });
      }
    }
    hist.sort((x, y) => x.at - y.at);
    for (const h of hist) histories.push({ orderId, fromStatus: h.from, toStatus: h.to, note: h.note, actorUserId: h.actor, createdAt: dt(h.at) });

    const lastAt = Math.max(g.createdAt, ...hist.map((h) => h.at), L.paidAt ?? 0, L.cancelRefund?.done ? L.cancelRefund.at : 0);

    orders.push({
      id: orderId, code: c.code, userId, shopId: c.shop.id, orderGroupId: groupId, commissionRateSnapshot: c.shop.commissionRate,
      status: L.status, paymentMethodCode: c.method, paymentStatus: orderPay,
      recipientName: addr.recipientName, recipientPhone: addr.phone, provinceCode: addr.provinceCode, provinceName: addr.provinceName, districtName: addr.districtName, wardName: addr.wardName, street: addr.street, shippingAddress,
      customerNote: c.note,
      subtotal: c.subtotal.toString(), shippingFee: c.shippingFee.toString(), discount: c.discount.toString(), shopDiscount: c.shopDiscount.toString(), platformDiscount: c.platformDiscount.toString(),
      promotionCode: g.platform?.promo.code ?? null, promotionName: g.platform?.promo.name ?? null, shopPromotionCode: c.shopPromo?.promo.code ?? null, shopPromotionName: c.shopPromo?.promo.name ?? null,
      total: c.total.toString(), itemCount: c.itemCount,
      cancelReason: L.cancel?.reason ?? null, cancelledBy: L.cancel?.kind === 'customer' ? userId : L.cancel?.kind === 'shop' ? shopActor('confirm') : null,
      paymentExpiresAt: dtOrNull(paymentExpiresAtOnOrder),
      confirmedAt: dtOrNull(confirmedAt), packedAt: dtOrNull(packedAt), shippedAt: dtOrNull(shippedAt), deliveredAt: dtOrNull(deliveredAt), completedAt: dtOrNull(completedAt), cancelledAt: dtOrNull(L.cancel?.at ?? null),
      createdAt, createdBy: userId, updatedAt: dt(lastAt), updatedBy: null,
    });

    c.lines.forEach((l, i) => {
      items.push({ id: uid(`item:${c.code}:${i}`), orderId, shopId: l.product.shopId, variantId: l.variant.id, productId: l.product.id, slug: l.product.slug, name: l.product.name, imageUrl: l.imageUrl, color: l.color, size: l.size, sku: l.variant.sku, quantity: l.qty, unitPrice: l.unitPrice.toString(), lineTotal: l.lineTotal.toString() });
      if (L.status === 'completed') soldDelta.set(l.product.id, (soldDelta.get(l.product.id) ?? 0) + l.qty);
    });

    // ---- Payment + giao dịch (đúng type/providerRef như PaymentService; (type, providerRef) duy nhất toàn bảng)
    const gatewayPayos = {
      code: '00', desc: 'success', orderCode: c.ids.payosCode, amount: Number(c.total), description: c.code, reference: c.ids.bankRef, paymentLinkId: c.ids.linkId, currency: 'VND', transactionDateTime: new Date((L.paidAt ?? g.createdAt) + 7 * HOUR).toISOString().replace('T', ' ').slice(0, 19),
    };
    const paidTxCode = c.method === METHOD.PAYOS ? c.ids.payosCode : null;
    const lastPayAt = Math.max(g.createdAt, L.paidAt ?? 0, L.cancel?.at ?? 0, L.cancelRefund?.done ? L.cancelRefund.at : 0, ret?.refundedAt ?? 0);
    payments.push({
      id: paymentId, orderId, orderCode: c.code, userId, methodCode: c.method, amount: c.total.toString(), status: payStatus,
      transactionCode: L.paidAt !== null ? paidTxCode : null,
      refundedAmount: refundedAmount.toString(),
      gatewayResponse: L.paidAt !== null && c.method === METHOD.PAYOS ? gatewayPayos : undefined,
      paidAt: dtOrNull(L.paidAt), expiresAt: dtOrNull(payExpires), createdAt, createdBy: userId, updatedAt: dt(lastPayAt),
    });
    if (c.method === METHOD.PAYOS) {
      payTxs.push({
        paymentId, type: TX_TYPE.CREATE_URL, status: 'ok', amount: c.total.toString(), providerRef: c.ids.payosCode,
        rawRequest: { payosOrderCode: c.ids.payosCode, checkoutUrl: `https://pay.payos.vn/web/${c.ids.linkId}`, paymentLinkId: c.ids.linkId }, createdAt,
      });
      if (L.paidAt !== null) payTxs.push({ paymentId, type: TX_TYPE.PAYOS_WEBHOOK, status: 'ok', amount: c.total.toString(), providerRef: c.ids.payosCode, rawResponse: gatewayPayos, createdAt: dt(L.paidAt) });
    } else if (L.paidAt !== null) {
      payTxs.push({ paymentId, type: TX_TYPE.COD_COLLECT, status: 'ok', amount: c.total.toString(), providerRef: `cod:${c.code}`, createdAt: dt(L.paidAt) });
    }

    // ---- hoàn tiền do shop huỷ đơn đã thu tiền online
    if (L.cancel?.kind === 'shop' && L.paidAt !== null && L.cancelRefund) {
      const ref = refundRef('-HUY');
      refunds.push({
        paymentId, orderCode: c.code, returnRequestId: null, amount: c.total.toString(), status: L.cancelRefund.done ? REFUND_STATUS.DONE : REFUND_STATUS.REQUESTED, method: refundMethod,
        providerRef: L.cancelRefund.done ? ref : null, reason: `Huỷ đơn: ${L.cancel.reason}`, requestedBy: shopActor('confirm'), processedBy: L.cancelRefund.done ? w.staff.accountant : null,
        processedAt: L.cancelRefund.done ? dt(L.cancelRefund.at) : null, shopId: c.shop.id, createdAt: dt(L.cancel.at), updatedAt: dt(L.cancelRefund.done ? L.cancelRefund.at : L.cancel.at),
      });
      if (L.cancelRefund.done) payTxs.push({ paymentId, type: TX_TYPE.REFUND, status: 'ok', amount: c.total.toString(), providerRef: ref, rawResponse: { manual: refundMethod === 'manual_transfer' }, createdAt: dt(L.cancelRefund.at) });
    }

    // ---- đổi trả
    if (ret) {
      const returnId = uid(`return:${c.code}`);
      const l0 = c.lines[0];
      const processed = ret.processedAt !== null;
      returns.push({
        id: returnId, orderId, orderCode: c.code, userId, status: ret.state, reason: ret.reason, detail: ret.detail, rejectReason: ret.rejectReason,
        refundAmount: c.refundAmount.toString(), evidence: [{ type: 'image', url: l0.imageUrl ?? '', name: 'anh-san-pham.jpg' }] as Prisma.InputJsonValue,
        processedBy: processed ? retActor : null, processedAt: dtOrNull(ret.processedAt), refundedAt: dtOrNull(ret.refundedAt), createdAt: dt(ret.requestedAt), updatedAt: dt(ret.refundedAt ?? ret.processedAt ?? ret.requestedAt),
      });
      returnItems.push({ returnId, orderItemId: uid(`item:${c.code}:0`), variantId: l0.variant.id, name: l0.product.name, color: l0.color, size: l0.size, quantity: 1, imageUrl: l0.imageUrl, unitPrice: l0.unitPrice.toString() });
      if (ret.state === 'approved' || ret.state === 'refunded') {
        const done = ret.state === 'refunded';
        const ref = refundRef('');
        refunds.push({
          paymentId, orderCode: c.code, returnRequestId: returnId, amount: c.refundAmount.toString(), status: done ? REFUND_STATUS.DONE : REFUND_STATUS.REQUESTED, method: refundMethod,
          providerRef: done ? ref : null, reason: `Đổi trả: ${ret.reason}`, requestedBy: retActor, processedBy: done ? w.staff.accountant : null, processedAt: done ? dt(ret.refundedAt as number) : null,
          shopId: c.shop.id, createdAt: dt(ret.processedAt as number), updatedAt: dt((ret.refundedAt ?? ret.processedAt) as number),
        });
        if (done) payTxs.push({ paymentId, type: TX_TYPE.REFUND, status: 'ok', amount: c.refundAmount.toString(), providerRef: ref, rawResponse: { manual: refundMethod === 'manual_transfer' }, createdAt: dt(ret.refundedAt as number) });
      }
    }

    // ---- voucher shop
    if (c.shopPromo) {
      usages.push({ promotionId: c.shopPromo.promo.id, userId, orderCode: c.code, discountAmount: c.shopPromo.discount.toString(), createdAt, releasedAt: dtOrNull(L.cancel?.at ?? null) });
      if (!L.cancel) usedDelta.set(c.shopPromo.promo.id, (usedDelta.get(c.shopPromo.promo.id) ?? 0) + 1);
    }

    // ---- sổ kho + chênh lệch tồn
    for (const e of c.events) {
      const signed = e.type === 'RESERVE' || e.type === 'SALE' ? -e.qty : e.qty;
      movements.push({ productId: e.productId, variantId: e.variantId, type: e.type, quantity: signed, stockAfter: e.stockAfter, refType: e.refType, refId: e.refId, note: 'seed hoạt động', actorUserId: null, createdAt: dt(e.at) });
      const d = variantDelta.get(e.variantId) ?? { ds: 0, dr: 0 };
      if (e.type === 'RESERVE') d.dr += e.qty;
      else if (e.type === 'RELEASE') d.dr -= e.qty;
      else if (e.type === 'SALE') {
        d.ds -= e.qty;
        d.dr -= e.qty;
      } else d.ds += e.qty;
      variantDelta.set(e.variantId, d);
    }
  }

  const code = g.code;
  await prisma.$transaction(
    async (tx: Tx) => {
      await tx.orderGroup.create({
        data: {
          id: groupId, code, userId, recipientName: addr.recipientName, recipientPhone: addr.phone, shippingAddress,
          subtotal: g.children.reduce((s, c) => s + c.subtotal, 0n).toString(), shippingFee: g.children.reduce((s, c) => s + c.shippingFee, 0n).toString(),
          discount: g.children.reduce((s, c) => s + c.discount, 0n).toString(), total: g.children.reduce((s, c) => s + c.total, 0n).toString(), createdAt, createdBy: userId,
        },
      });
      await tx.order.createMany({ data: orders });
      await tx.orderItem.createMany({ data: items });
      await tx.orderStatusHistory.createMany({ data: histories });
      await tx.payment.createMany({ data: payments });
      if (payTxs.length > 0) await tx.paymentTransaction.createMany({ data: payTxs });
      if (usages.length > 0) await tx.promotionUsage.createMany({ data: usages });
      if (returns.length > 0) {
        await tx.returnRequest.createMany({ data: returns });
        await tx.returnRequestItem.createMany({ data: returnItems });
      }
      if (refunds.length > 0) await tx.refund.createMany({ data: refunds });
      if (movements.length > 0) await tx.stockMovement.createMany({ data: movements });
      for (const [variantId, d] of variantDelta) {
        if (d.ds === 0 && d.dr === 0) continue;
        await tx.productVariant.update({ where: { id: variantId }, data: { stock: { increment: d.ds }, reserved: { increment: d.dr } } });
      }
      for (const [productId, n] of soldDelta) await tx.product.update({ where: { id: productId }, data: { soldCount: { increment: n } } });
      for (const [promotionId, n] of usedDelta) await tx.promotion.update({ where: { id: promotionId }, data: { usedCount: { increment: n } } });
    },
    { timeout: 120_000, maxWait: 30_000 },
  );
}

/* ============================================================================================== bước chuẩn bị */

async function settingNumber(prisma: PrismaClient, key: string, fallback: number): Promise<number> {
  const row = await prisma.setting.findUnique({ where: { key } });
  const v: unknown = row?.value;
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return fallback;
}

async function loadShops(prisma: PrismaClient): Promise<ShopCtx[]> {
  const shopRows = await prisma.shop.findMany({ where: { isDeleted: false }, select: { id: true, code: true, slug: true, name: true, status: true, commissionRate: true, ownerUserId: true }, orderBy: { code: 'asc' } });
  const productRows = await prisma.product.findMany({
    where: { isDeleted: false, status: 'active', variants: { some: { isDeleted: false, isActive: true } } },
    orderBy: { slug: 'asc' },
    select: {
      id: true, slug: true, name: true, shopId: true, categorySlug: true, basePrice: true,
      variants: {
        where: { isDeleted: false, isActive: true }, orderBy: { sku: 'asc' },
        select: { id: true, sku: true, colorCode: true, colorName: true, sizeCode: true, price: true, stock: true, reserved: true, options: { select: { attributeId: true, displayValue: true }, orderBy: { attributeId: 'asc' } } },
      },
      images: { orderBy: { sortOrder: 'asc' }, select: { url: true, colorCode: true, isPrimary: true } },
    },
  });
  const byShop = new Map<string, ProductCtx[]>();
  for (const p of productRows) {
    const base = BigInt(p.basePrice.toFixed(0));
    const ctx: ProductCtx = {
      id: p.id, slug: p.slug, name: p.name, categorySlug: p.categorySlug, shopId: p.shopId, basePrice: base, weight: 1,
      images: p.images.map((i) => ({ url: i.url, colorCode: i.colorCode, isPrimary: i.isPrimary })),
      variants: p.variants.map((v) => ({
        id: v.id, sku: v.sku, colorCode: v.colorCode, colorName: v.colorName, sizeCode: v.sizeCode, price: v.price ? BigInt(v.price.toFixed(0)) : base, stock: v.stock, reserved: v.reserved,
        optionsText: v.options.map((o) => o.displayValue).join(' / '),
      })),
    };
    byShop.set(p.shopId, [...(byShop.get(p.shopId) ?? []), ctx]);
  }
  return shopRows.map((s) => {
    // thứ hạng "bán chạy" tất định theo băm slug: sản phẩm hạng cao được chọn nhiều hơn (Zipf nhẹ)
    const products = (byShop.get(s.id) ?? []).sort((a, b) => hash32(a.slug) - hash32(b.slug) || (a.slug < b.slug ? -1 : 1));
    products.forEach((p, rank) => {
      p.weight = 1 / (rank + 1) ** 0.6;
    });
    return { id: s.id, code: s.code, slug: s.slug, name: s.name, status: s.status, commissionRate: s.commissionRate.toString(), ownerUserId: s.ownerUserId, products };
  });
}

async function loadPromos(prisma: PrismaClient): Promise<PromoDef[]> {
  const rows = await prisma.promotion.findMany({ where: { isDeleted: false, isActive: true }, include: { targets: true }, orderBy: { code: 'asc' } });
  return rows.map((p) => ({
    id: p.id, code: p.code, name: p.name, type: p.type, value: p.value.toString(), maxDiscount: p.maxDiscount ? BigInt(p.maxDiscount.toFixed(0)) : null, minOrder: BigInt(p.minOrderAmount.toFixed(0)),
    usageLimit: p.usageLimit, perUser: p.usageLimitPerUser, usedCount: p.usedCount, appliesTo: p.appliesTo, targets: p.targets.map((t) => ({ targetType: t.targetType, targetRef: t.targetRef })),
    startsAt: p.startsAt.getTime(), endsAt: p.endsAt.getTime(), scope: p.scope === 'shop' ? 'shop' : 'platform', shopId: p.shopId,
  }));
}

/* Khách: 5 khách có sẵn + 40 khách mới (địa chỉ/số điện thoại lấy từ DB nếu đã tạo, ngược lại theo định nghĩa tĩnh). Chưa ghi gì vào DB ở bước này. */
async function loadCustomers(prisma: PrismaClient, provinces: Map<string, { name: string; fee: bigint }>): Promise<CustomerRef[]> {
  const emails = [...EXISTING_CUSTOMER_EMAILS, ...NEW_CUSTOMERS.map((c) => `khach${c.no}@ecofashion.vn`)];
  const found = await prisma.user.findMany({
    where: { email: { in: emails }, isDeleted: false },
    select: { id: true, email: true, fullName: true, phone: true, addresses: { where: { isDefault: true, isDeleted: false }, take: 1 } },
  });
  const byEmail = new Map(found.map((u) => [u.email.toLowerCase(), u]));
  const phoneRng = rngFor('phones');
  const prefixes = ['090', '091', '093', '094', '096', '097', '098'];
  const usedPhones = new Set((await prisma.user.findMany({ where: { phone: { not: null }, isDeleted: false }, select: { phone: true } })).map((u) => u.phone as string));
  const genPhone = (): string => {
    for (let tries = 0; tries < 1000; tries += 1) {
      const p = `${pickOf(phoneRng(), prefixes)}${String(1_000_000 + Math.floor(phoneRng() * 8_999_999))}`;
      if (!usedPhones.has(p)) {
        usedPhones.add(p);
        return p;
      }
    }
    throw new Error('Không sinh được số điện thoại duy nhất');
  };

  const out: CustomerRef[] = [];
  let slot = 0;
  for (const email of EXISTING_CUSTOMER_EMAILS) {
    const u = byEmail.get(email);
    const a = u?.addresses[0];
    slot += 1;
    if (!u || !a) continue; // khách demo chưa có địa chỉ mặc định → không dùng
    out.push({
      key: email, fullName: u.fullName, phone: u.phone ?? a.phone, weight: 1 + ((slot * 7 + 3) % 4), userId: u.id, isNew: false, def: null, firstOrderAt: null,
      addr: { recipientName: a.recipientName, phone: a.phone, provinceCode: a.provinceCode, provinceName: a.provinceName, districtName: a.districtName, wardName: a.wardName, street: a.street },
    });
  }
  for (const def of NEW_CUSTOMERS) {
    const email = `khach${def.no}@ecofashion.vn`;
    slot += 1;
    const prov = provinces.get(def.provinceCode);
    if (!prov) throw new Error(`Thiếu tỉnh/thành mã ${def.provinceCode} — chạy system.seed trước`);
    const u = byEmail.get(email);
    const a = u?.addresses[0];
    const phone = u?.phone ?? genPhone();
    out.push({
      key: email, fullName: u?.fullName ?? def.fullName, phone, weight: 1 + ((slot * 7 + 3) % 4), userId: u?.id ?? null, isNew: !u, def, firstOrderAt: null,
      addr: a
        ? { recipientName: a.recipientName, phone: a.phone, provinceCode: a.provinceCode, provinceName: a.provinceName, districtName: a.districtName, wardName: a.wardName, street: a.street }
        : { recipientName: def.fullName, phone, provinceCode: def.provinceCode, provinceName: prov.name, districtName: def.district, wardName: def.ward, street: def.street },
    });
  }
  return out;
}

/* Tạo khách mới (idempotent theo email) + địa chỉ mặc định; ngày tạo tài khoản đặt trước đơn đầu tiên của họ. */
async function ensureCustomers(prisma: PrismaClient, customers: CustomerRef[], now: number): Promise<{ createdUsers: number; createdAddresses: number }> {
  const role = await prisma.role.findUnique({ where: { code: 'customer' }, select: { id: true } });
  if (!role) throw new Error("Thiếu vai 'customer' — perms:sync chưa chạy?");
  let hash: string | null = null;
  let createdUsers = 0;
  let createdAddresses = 0;
  for (const c of customers) {
    if (!c.def) continue;
    const rr = rngFor('customer-created', c.key);
    const at = c.firstOrderAt !== null ? c.firstOrderAt - between(rr(), 1, 20) * DAY : now - between(rr(), 10, 60) * DAY;
    const createdAt = dt(at);
    if (!c.userId) {
      const again = await prisma.user.findFirst({ where: { email: { equals: c.key, mode: 'insensitive' }, isDeleted: false }, select: { id: true } });
      if (again) {
        c.userId = again.id;
      } else {
        hash ??= await argon2.hash(DEMO_CUSTOMER_PASSWORD, ARGON2);
        const u = await prisma.user.create({
          data: { email: c.key, fullName: c.fullName, phone: c.phone, passwordHash: hash, roleId: role.id, status: 'active', emailVerifiedAt: createdAt, createdAt, updatedAt: createdAt },
          select: { id: true },
        });
        c.userId = u.id;
        createdUsers += 1;
      }
    }
    const hasAddress = await prisma.address.count({ where: { userId: c.userId, isDeleted: false } });
    if (hasAddress === 0) {
      await prisma.address.create({
        data: {
          userId: c.userId, recipientName: c.addr.recipientName, phone: c.addr.phone, provinceCode: c.addr.provinceCode, provinceName: c.addr.provinceName, districtName: c.addr.districtName,
          wardName: c.addr.wardName, street: c.addr.street, isDefault: true, createdBy: c.userId, updatedBy: c.userId, createdAt, updatedAt: createdAt,
        },
      });
      createdAddresses += 1;
    }
  }
  return { createdUsers, createdAddresses };
}

/* Nhập bổ sung kho theo shop (phiếu `posted` + sổ kho RECEIPT) cho các biến thể thiếu tồn so với mô phỏng. */
async function topUpStock(prisma: PrismaClient, topUp: Map<string, number>, baseline: Map<string, StockBaseline>, shops: ShopCtx[], firstAt: number, staff: PlanCtx['staff']): Promise<number> {
  if (topUp.size === 0) return 0;
  const byShop = new Map<string, Array<{ variantId: string; qty: number }>>();
  for (const [variantId, qty] of topUp) {
    const b = baseline.get(variantId) as StockBaseline;
    byShop.set(b.shopId, [...(byShop.get(b.shopId) ?? []), { variantId, qty }]);
  }
  const t0 = dt(firstAt - 2 * DAY);
  let receipts = 0;
  for (const [shopId, lines] of byShop) {
    const shop = shops.find((s) => s.id === shopId);
    if (!shop) continue;
    const num = shop.code.replace('SHOP-', '');
    const n = (await prisma.stockReceipt.count({ where: { code: { startsWith: `PN-ACT-${num}-` } } })) + 1;
    const code = `PN-ACT-${num}-${String(n).padStart(2, '0')}`;
    const unitCost = (variantId: string): bigint => ((baseline.get(variantId) as StockBaseline).price * 6n) / 10n;
    const poster = shop.id === FITLY_OFFICIAL_SHOP_ID ? staff.warehouse : shop.ownerUserId;
    await prisma.$transaction(
      async (tx: Tx) => {
        await tx.stockReceipt.create({
          data: {
            code, shopId, supplierName: 'Nhà cung cấp (seed hoạt động)', note: 'Nhập bổ sung kho cho đơn hàng lịch sử — dữ liệu mẫu', status: 'posted',
            totalCost: lines.reduce((s, l) => s + BigInt(l.qty) * unitCost(l.variantId), 0n).toString(), postedAt: t0, postedBy: poster, createdAt: t0, createdBy: poster, updatedAt: t0,
            items: { create: lines.map((l) => ({ variantId: l.variantId, sku: (baseline.get(l.variantId) as StockBaseline).sku, quantity: l.qty, unitCost: unitCost(l.variantId).toString() })) },
          },
        });
        for (const l of lines) {
          const b = baseline.get(l.variantId) as StockBaseline;
          await tx.productVariant.update({ where: { id: l.variantId }, data: { stock: { increment: l.qty } } });
          await tx.stockMovement.create({ data: { productId: b.productId, variantId: l.variantId, type: 'RECEIPT', quantity: l.qty, stockAfter: b.stock + l.qty, refType: 'stock_receipt', refId: code, note: 'seed hoạt động', actorUserId: poster, createdAt: t0 } });
        }
      },
      { timeout: 120_000, maxWait: 30_000 },
    );
    receipts += 1;
  }
  return receipts;
}

/* ============================================================================================== seed */

export async function seed(prisma: PrismaClient): Promise<void> {
  const now = Date.now();

  // ---- ngữ cảnh: tham số vận hành, tỉnh/thành, shop + sản phẩm, voucher, nhân viên
  const [freeThreshold, defaultFee, codMax] = await Promise.all([
    settingNumber(prisma, 'shipping.free_threshold', 500_000),
    settingNumber(prisma, 'shipping.default_fee', 30_000),
    settingNumber(prisma, 'order.cod_max_amount', 5_000_000),
  ]);
  const provinceRows = await prisma.province.findMany({ select: { code: true, name: true, shippingFee: true } });
  const provinces = new Map(provinceRows.map((p) => [p.code, { name: p.name, fee: BigInt(p.shippingFee.toFixed(0)) }]));
  if (provinces.size === 0) throw new Error('Chưa có tỉnh/thành — chạy system.seed trước');
  const shops = await loadShops(prisma);
  const approved = shops.filter((s) => s.status === 'approved' && s.products.length > 0);
  const suspended = shops.filter((s) => s.status === 'suspended' && s.products.length > 0);
  if (approved.length === 0) throw new Error('Không có gian hàng đã duyệt nào có sản phẩm đang bán — chạy marketplace/product.seed trước');
  for (const s of shops.filter((x) => x.status === 'approved' && x.products.length === 0)) console.log(`   ! gian hàng ${s.code} đã duyệt nhưng chưa có sản phẩm bán được — bỏ qua`);

  const promos = await loadPromos(prisma);
  const usedByPromo = new Map(promos.map((p) => [p.id, p.usedCount]));
  const usedByUser = new Map<string, number>();
  const staffUsers = await prisma.user.findMany({ where: { email: { in: ['sales@ecofashion.vn', 'accountant@ecofashion.vn'] }, isDeleted: false }, select: { id: true, email: true } });
  const staffId = (email: string): string | null => staffUsers.find((s) => s.email === email)?.id ?? null;
  const staff = { sales: staffId('sales@ecofashion.vn'), warehouse: staffId('sales@ecofashion.vn'), accountant: staffId('accountant@ecofashion.vn') };

  const customers = await loadCustomers(prisma, provinces);
  if (customers.length === 0) throw new Error('Không có khách nào để đặt đơn — chạy identity.seed trước');
  // lượt dùng voucher hiện có của từng khách (chưa nhả) — để không vượt usageLimitPerUser
  const existingIds = new Map(customers.filter((c) => c.userId).map((c) => [c.userId as string, c.key]));
  if (existingIds.size > 0) {
    const usage = await prisma.promotionUsage.groupBy({ by: ['promotionId', 'userId'], where: { releasedAt: null, userId: { in: [...existingIds.keys()] } }, _count: { _all: true } });
    for (const u of usage) usedByUser.set(`${u.promotionId}|${existingIds.get(u.userId)}`, u._count._all);
  }

  // ---- kế hoạch (thuần tuý, tất định)
  const budget = TARGET_CHILD_ORDERS - (suspended.length > 0 ? SUSPENDED_SHOP_ORDERS * suspended.length : 0);
  const alloc = allocateShopOrders(approved, budget);
  const allShops = [...approved, ...suspended];
  const raw = packGroups(approved, alloc, suspended);
  const ctx: PlanCtx = {
    now, freeThreshold: BigInt(freeThreshold), defaultFee: BigInt(defaultFee), codMax: BigInt(codMax),
    provinceFee: new Map([...provinces].map(([code, p]) => [code, p.fee])), promos, usedByPromo, usedByUser, staff, evtOrd: 0,
  };
  const plans = buildPlans(ctx, allShops, customers, raw);
  console.log(`   kế hoạch: ${plans.length} nhóm / ${plans.reduce((n, g) => n + g.children.length, 0)} đơn con (${plans.filter((g) => g.children.length > 1).length} giỏ nhiều shop), ${approved.length} shop đã duyệt + ${suspended.length} shop bị khoá`);

  // ---- khách mới
  const cust = await ensureCustomers(prisma, customers, now);
  console.log(`   khách: ${customers.length} dùng cho đơn (${NEW_CUSTOMERS.length} khách mới khach${NEW_CUSTOMERS[0].no}..khach${NEW_CUSTOMERS[NEW_CUSTOMERS.length - 1].no}; tạo mới ${cust.createdUsers} tài khoản, ${cust.createdAddresses} địa chỉ mặc định)`);

  // ---- nhóm chưa có trong DB
  const existingGroupCodes = new Set((await prisma.orderGroup.findMany({ where: { code: { startsWith: GROUP_PREFIX } }, select: { code: true } })).map((g) => g.code));
  const existingOrderCodes = new Set((await prisma.order.findMany({ where: { code: { startsWith: CODE_PREFIX } }, select: { code: true } })).map((o) => o.code));
  const todo = plans.filter((g) => {
    if (existingGroupCodes.has(g.code)) return false;
    if (g.children.some((c) => existingOrderCodes.has(c.code))) {
      console.log(`   ! nhóm ${g.code}: đã có đơn trùng mã (khác nhóm) — bỏ qua để tránh trùng`);
      return false;
    }
    return true;
  });

  // ---- kho: mô phỏng theo thời gian rồi nhập bổ sung
  if (todo.length > 0) {
    const variantIds = [...new Set(todo.flatMap((g) => g.children.flatMap((c) => c.lines.map((l) => l.variant.id))))];
    const fresh = await prisma.productVariant.findMany({ where: { id: { in: variantIds } }, select: { id: true, sku: true, productId: true, shopId: true, stock: true, reserved: true, price: true, product: { select: { basePrice: true } } } });
    const baseline = new Map<string, StockBaseline>(fresh.map((v) => [v.id, { stock: v.stock, reserved: v.reserved, productId: v.productId, shopId: v.shopId, sku: v.sku, price: BigInt((v.price ?? v.product.basePrice).toFixed(0)) }]));
    const topUp = simulateStock(todo, baseline);
    const receipts = await topUpStock(prisma, topUp, baseline, allShops, Math.min(...todo.map((g) => g.createdAt)), staff);
    if (topUp.size > 0) console.log(`   kho: nhập bổ sung ${topUp.size} biến thể bằng ${receipts} phiếu nhập đã duyệt (tồn khả dụng ≥ ${STOCK_MARGIN} sau mọi đơn)`);
  }

  // ---- ghi từng nhóm (cũ → mới)
  let created = 0;
  let createdChildren = 0;
  for (const g of todo) {
    await writeGroup(prisma, g, { staff, now });
    created += 1;
    createdChildren += g.children.length;
    if (created % 50 === 0) console.log(`   ... đã ghi ${created}/${todo.length} nhóm`);
  }
  console.log(`   đơn hàng: ${plans.length} nhóm kế hoạch — tạo mới ${created} nhóm / ${createdChildren} đơn con, bỏ qua ${plans.length - created} nhóm đã có`);

  // ---- tổng kết (đọc lại từ DB để tính cả đơn đã có từ lần chạy trước)
  const where = { code: { startsWith: CODE_PREFIX } };
  const [byStatus, byMethod, byShop, perGroup, voucherOrders, returnsCount, refundsCount] = await Promise.all([
    prisma.order.groupBy({ by: ['status'], where, _count: { _all: true } }),
    prisma.order.groupBy({ by: ['paymentMethodCode'], where, _count: { _all: true } }),
    prisma.order.groupBy({ by: ['shopId'], where, _count: { _all: true } }),
    prisma.order.groupBy({ by: ['orderGroupId'], where, _count: { _all: true } }),
    prisma.order.count({ where: { ...where, OR: [{ promotionCode: { not: null } }, { shopPromotionCode: { not: null } }] } }),
    prisma.returnRequest.count({ where: { orderCode: { startsWith: CODE_PREFIX } } }),
    prisma.refund.count({ where: { orderCode: { startsWith: CODE_PREFIX } } }),
  ]);
  const totalOrders = byStatus.reduce((n, x) => n + x._count._all, 0);
  const fmt = (rows: Array<{ k: string; n: number }>): string => rows.sort((a, b) => b.n - a.n).map((r) => `${r.k} ${r.n}`).join(' · ');
  const shopName = new Map(shops.map((s) => [s.id, s.name]));
  console.log(`   tổng kết: ${totalOrders} đơn con (DHSEED), ${perGroup.length} nhóm (${perGroup.filter((x) => x._count._all > 1).length} giỏ nhiều shop), ${customers.length} khách tham gia`);
  console.log(`     theo trạng thái: ${fmt(byStatus.map((x) => ({ k: x.status, n: x._count._all })))}`);
  console.log(`     theo thanh toán: ${fmt(byMethod.map((x) => ({ k: x.paymentMethodCode, n: x._count._all })))}`);
  console.log(`     theo shop: ${fmt(byShop.map((x) => ({ k: shopName.get(x.shopId) ?? x.shopId, n: x._count._all })))}`);
  console.log(`     đơn dùng voucher: ${voucherOrders}/${totalOrders} (${totalOrders > 0 ? Math.round((voucherOrders * 100) / totalOrders) : 0}%) · đổi trả ${returnsCount} · hoàn tiền ${refundsCount}`);
}
