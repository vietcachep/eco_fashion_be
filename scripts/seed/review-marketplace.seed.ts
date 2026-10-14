/*
 * SEED đánh giá cho sàn đa ngành hàng (PLAN-0017) — chạy SAU `activity.seed` (đơn con mã DHSEED*), chỉ ĐỌC đơn rồi ghi review.
 *
 * Thiết kế:
 *  - Nguồn: dòng đơn (OrderItem) của đơn DHSEED* ở trạng thái completed (~50% dòng) và delivered (~20% dòng, đơn mới giao
 *    nên ít người đánh giá) — đúng điều kiện `ReviewService.create` (đơn delivered/completed, mỗi dòng đơn một lần).
 *  - Tất định: mỗi dòng đơn có PRNG riêng (mulberry32, seed = băm `đơn|slug|sku`) nên kết quả không phụ thuộc thứ tự
 *    duyệt/số đơn đã có; KHÔNG Math.random. Chạy lại cho cùng quyết định (idempotent theo unique (userId, orderItemId)).
 *  - Điểm lệch dương ~ 5★ 48% · 4★ 30% · 3★ 12% · 2★ 6% · 1★ 4%, có "độ tốt" riêng từng sản phẩm (15% sản phẩm tốt hơn,
 *    15% kém hơn) để điểm trung bình các sản phẩm không đồng loạt như nhau nhưng tổng thể vẫn khớp phân bố.
 *  - Nội dung: ghép 1–2 mảnh câu tiếng Việt theo NGÀNH HÀNG GỐC của sản phẩm (suy từ chuỗi category cha) và đúng NGÀNH LÁ
 *    (ốp lưng không bị khen "camera đẹp"; ngành lá chưa có kho riêng thì lùi về kho gộp của ngành gốc) + câu chung/giao hàng/
 *    câu than phiền cho điểm thấp; tránh trùng nguyên văn trong cả lần chạy. ~12% review chỉ có sao (content = '' — cột
 *    NOT NULL nhưng cho phép chuỗi rỗng; LƯU Ý DTO tạo review qua API đòi ≥ 10 ký tự, nên đây là dữ liệu mẫu cho màn hiển thị).
 *  - ~35% review hiển thị được shop trả lời (1–3★ gần như luôn trả lời), ký tên theo tên shop; ~2% bị ẩn kiểm duyệt
 *    (nội dung vi phạm: spam/xúc phạm/lạc đề + nhãn đề xuất AI trong ai.moderation_flags) để demo màn kiểm duyệt.
 *  - Cuối: TÍNH LẠI Product.avgRating/reviewCount (chỉ review approved & chưa xoá, làm tròn 2 chữ số như `syncStats`) và
 *    Shop.ratingAvg (trung bình review approved của mọi sản phẩm thuộc shop, toFixed(2) như `ShopEventListeners`).
 * Bất biến giữ nguyên review.seed: gắn orderItemId + OrderItem.reviewed = true, snapshot productSlug/productName/shopId,
 * ẩn → status 'hidden' + moderationNote/moderatedBy/moderatedAt + ModerationFlag.
 */
import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '../../src/generated/prisma/client';

// ---------------------------------------------------------------- hằng số
const ORDER_PREFIX = 'DHSEED';
const SEED_KEY = 'review-marketplace-v1';
const RATE_COMPLETED = 0.5; // tỉ lệ dòng đơn completed được đánh giá
const RATE_DELIVERED = 0.2; // đơn mới giao, chưa hoàn tất: ít người đánh giá hơn
const HIDDEN_RATE = 0.02;
const REPLY_RATE_HIGH = 0.18; // 4–5★: ~18% được trả lời → tổng ~35%
const REPLY_RATE_LOW = 0.95; // 1–3★: gần như luôn được trả lời
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CHUNK = 80;
const MAX_CONTENT = 2000;

/* Xác suất chỉ có sao (không chữ) theo điểm: chủ yếu 4–5★ → tổng ~12% */
const STAR_ONLY_RATE: Record<number, number> = { 5: 0.17, 4: 0.12, 3: 0.04, 2: 0, 1: 0 };

/* Trọng số điểm [5★, 4★, 3★, 2★, 1★] theo "độ tốt" sản phẩm — hợp lại ≈ 48/30/12/6/4 */
const RATING_WEIGHTS = {
  low: [0.32, 0.31, 0.2, 0.1, 0.07],
  normal: [0.48, 0.3, 0.12, 0.06, 0.04],
  high: [0.64, 0.26, 0.06, 0.03, 0.01],
} as const;
type Quality = keyof typeof RATING_WEIGHTS;

const MARKETPLACE_ROOTS = ['dien-thoai-phu-kien', 'may-tinh-thiet-bi-dien-tu', 'nha-cua-doi-song', 'sac-dep-suc-khoe', 'giay-dep-tui-xach', 'dong-ho-phu-kien', 'the-thao-da-ngoai', 'me-be', 'sach-van-phong-pham', 'thuc-pham-do-uong', 'thu-cung', 'o-to-xe-may'] as const;
/* 7 ngành thời trang cũ (catalog.seed) là category gốc độc lập, không có cha → gom vào 'thoi-trang' */
const FASHION_ROOTS = new Set(['ao-thun', 'ao-so-mi', 'quan-jean', 'quan-short', 'vay', 'dam', 'ao-khoac']);
type DeptKey = (typeof MARKETPLACE_ROOTS)[number] | 'thoi-trang' | 'chung';

// ---------------------------------------------------------------- PRNG tất định
type Rng = () => number;

/* mulberry32: PRNG 32-bit nhỏ gọn, cùng seed → cùng dãy số. */
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

/* FNV-1a 32-bit: băm chuỗi thành số nguyên không dấu để làm seed. */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const pick = <T>(rng: Rng, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];
const chance = (rng: Rng, p: number): boolean => rng() < p;
function pickOther<T>(rng: Rng, arr: readonly T[], exclude: T): T {
  const pool = arr.filter((x) => x !== exclude);
  return pick(rng, pool.length > 0 ? pool : arr);
}
function chunked<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------- kho câu mẫu
interface Corpus {
  /** Khen — đủ độ dài để đứng một mình ở 4–5★ */
  pos: readonly string[];
  /** Có khen có chê — dùng cho 3★ và làm "vế chê nhẹ" của 4★ */
  mid: readonly string[];
  /** Than phiền hợp lý cho 1–2★ */
  neg: readonly string[];
}

/*
 * Kho câu theo NGÀNH GỐC → NGÀNH LÁ (slug category lá = Product.categorySlug): câu phải đúng loại hàng của ngành lá, nên
 * ốp lưng không bị khen "camera chụp đẹp". Ngành lá không có trong kho (ngành mới thêm sau) lùi về kho gộp của cả ngành gốc.
 */
const CORPUS: Record<Exclude<DeptKey, 'chung'>, Record<string, Corpus>> = {
  'dien-thoai-phu-kien': {
    'dien-thoai': {
      pos: [
        'Máy chạy mượt, màn hình sáng đẹp, dùng cả ngày mới cần sạc.',
        'Pin trâu thật sự, sạc nhanh, chơi game mà máy không nóng nhiều.',
        'Camera chụp ổn, màu ảnh tự nhiên, quay video cũng khá nét.',
        'Máy nguyên seal, kích hoạt bảo hành điện tử ngay trong ngày nên rất yên tâm.',
        'Mua cho ba mẹ dùng, chữ to dễ nhìn, ba mẹ khen lắm.',
      ],
      mid: [
        'Máy dùng ổn trong tầm giá, nhưng loa ngoài hơi nhỏ so với mong đợi.',
        'Pin dùng được cả ngày nhẹ nhàng, chơi game nặng thì tụt khá nhanh.',
        'Màn hình đẹp nhưng viền hơi dày, camera chụp thiếu sáng chưa thật sự nổi bật.',
      ],
      neg: [
        'Máy lag khi mở nhiều ứng dụng, bị nóng khi sạc, khá thất vọng so với giá tiền.',
        'Hộp bị móp, máy có trầy nhẹ ở viền, không giống hàng mới nguyên seal.',
        'Máy hay tự khởi động lại và sóng yếu hơn máy cũ của mình, đang chờ shop hỗ trợ bảo hành.',
      ],
    },
    'phu-kien-dien-thoai': {
      pos: [
        'Ốp lưng ôm máy vừa khít, không bị ố vàng, các nút bấm vẫn nhạy.',
        'Cáp sạc chắc tay, sạc nhanh đúng như quảng cáo, dùng hai tháng chưa thấy nóng đầu cáp.',
        'Sạc dự phòng nhỏ gọn, sạc đầy được gần 3 lần điện thoại, mang đi làm rất tiện.',
        'Tai nghe bluetooth kết nối nhanh, âm bass chắc, đeo lâu không bị đau tai.',
        'Dán cường lực lên rất phẳng, không bị bọt khí, cảm ứng vẫn mượt.',
      ],
      mid: [
        'Ốp đẹp, vừa máy nhưng hơi trơn tay, cầm lâu phải cẩn thận.',
        'Cáp sạc dùng tạm ổn, tốc độ sạc không nhanh như mình kỳ vọng.',
        'Tai nghe âm thanh được, chống ồn chỉ ở mức tương đối, đeo lâu hơi tức tai.',
      ],
      neg: [
        'Ốp lưng bị ố vàng sau hai tuần, các lỗ camera cắt lệch nhìn rất khó chịu.',
        'Cáp sạc dùng được hơn tuần thì đứt ngầm, sạc chập chờn lúc được lúc không.',
        'Tai nghe bị rè một bên, kết nối bluetooth hay đứt quãng, đã nhắn shop nhưng chưa thấy xử lý.',
        'Sạc dự phòng ghi 10.000mAh mà sạc được chưa tới 2 lần, nghi dung lượng ảo.',
      ],
    },
    'may-tinh-bang': {
      pos: [
        'Màn hình tablet đẹp, xem phim và học online đều ổn, loa nghe khá to.',
        'Máy mỏng nhẹ, cầm một tay đọc truyện cả tiếng không mỏi, pin dùng hai ngày mới phải sạc.',
        'Cảm ứng nhạy, vẽ bằng bút rất mượt, con mình học online dùng rất hợp.',
      ],
      mid: [
        'Tablet dùng tốt cho học và xem phim, nhưng làm việc nặng đa nhiệm thì hơi chậm.',
        'Màn hình đẹp, loa hơi nhỏ, gắn tai nghe ngoài mới đã tai.',
      ],
      neg: [
        'Màn hình bị hở sáng ở viền và cảm ứng hơi lỗi ở góc, đang chờ shop đổi máy.',
        'Pin tụt rất nhanh, sạc cả đêm mà dùng chưa tới nửa ngày.',
      ],
    },
  },
  'may-tinh-thiet-bi-dien-tu': {
    laptop: {
      pos: [
        'Laptop chạy nhanh, khởi động vài giây, làm văn phòng và code đều rất mượt.',
        'Máy đóng hộp nguyên vẹn, đủ phụ kiện, bảo hành chính hãng 24 tháng.',
        'Quạt tản nhiệt chạy êm, chơi game vài tiếng nhiệt độ vẫn ổn định.',
        'Pin laptop dùng được gần 8 tiếng làm việc, mỏng nhẹ mang đi cà phê rất tiện.',
      ],
      mid: [
        'Máy chạy tốt trong tầm giá, nhưng loa ngoài hơi nhỏ và quạt ồn khi chạy nặng.',
        'Cấu hình mạnh nhưng máy hơi nặng, mang đi lại cả ngày hơi mỏi vai.',
      ],
      neg: [
        'Laptop nhận về bị chết điểm ảnh ở góc màn hình, shop hẹn đổi nhưng phải chờ lâu.',
        'Máy nóng và quạt kêu to bất thường, mở vài ứng dụng đã giật lag, thất vọng.',
        'Hộp bị móp méo, phụ kiện thiếu dây nguồn, phải nhắn shop gửi bù.',
      ],
    },
    'chuot-ban-phim': {
      pos: [
        'Bàn phím cơ gõ sướng tay, tiếng gõ êm, đèn led đẹp, đáng đồng tiền.',
        'Chuột cầm vừa tay, click êm, pin dùng cả tháng chưa phải thay.',
        'Bàn phím layout gọn, gõ văn bản cả ngày không mỏi tay, kết nối không dây rất ổn định.',
        'Chuột không dây nhạy, chỉnh DPI dễ, kết nối nhanh, chơi game không bị trễ.',
      ],
      mid: [
        'Bàn phím gõ ổn, nhưng đèn led hơi chói và phải chỉnh lại phần mềm mới đẹp.',
        'Chuột dùng tốt, chỉ có điều nút cuộn hơi cứng, chắc cần thời gian làm quen.',
      ],
      neg: [
        'Bàn phím bị liệt vài phím sau hai tuần, gõ không ăn, đang chờ bảo hành.',
        'Chuột bị double click sau hơn một tuần dùng, mở file cũng nhầm liên tục.',
      ],
    },
    'tai-nghe-loa': {
      pos: [
        'Loa nghe trong trẻo, bass đầy, kết nối bluetooth ổn định trong phòng khá rộng.',
        'Tai nghe gaming đeo thoải mái, mic thu rõ, đồng đội nghe không bị rè.',
        'Tai nghe pin trâu, chống ồn khá tốt, đeo đi tàu xe vẫn nghe rõ nhạc.',
      ],
      mid: [
        'Loa âm thanh ổn so với giá, bass chưa sâu như quảng cáo lắm.',
        'Tai nghe âm thanh sáng, đeo lâu thì hơi nóng tai.',
      ],
      neg: [
        'Tai nghe bị rè và mất tiếng một bên, mic thu cũng không rõ như quảng cáo.',
        'Loa kết nối bluetooth hay đứt quãng, bass bị vỡ khi mở âm lượng lớn.',
      ],
    },
    'man-hinh-linh-kien': {
      pos: [
        'Màn hình đẹp, màu chuẩn, viền mỏng, làm đồ họa cơ bản thoải mái.',
        'SSD gắn vào máy cũ mà nhanh hẳn, mở máy chưa tới 10 giây.',
        'RAM đúng dung lượng như mô tả, nâng cấp xong đa nhiệm khác hẳn.',
      ],
      mid: [
        'Màn hình sắc nét nhưng độ sáng chưa cao lắm, dùng gần cửa sổ hơi khó nhìn.',
        'SSD chạy nhanh thật, chỉ tiếc là phần mềm đi kèm hơi khó dùng.',
      ],
      neg: [
        'Ổ cứng báo lỗi sau vài ngày sử dụng, phải cài lại máy mất cả buổi.',
        'Màn hình bị hở sáng góc dưới và có một điểm chết nhỏ, hơi tiếc.',
      ],
    },
  },
  'nha-cua-doi-song': {
    'do-dung-nha-bep': {
      pos: [
        'Bộ nồi chảo chống dính thật, chiên trứng không dính chút nào, tay cầm cách nhiệt tốt.',
        'Hộp đựng đồ chắc chắn, nắp đóng kín, xếp gọn tủ bếp rất hợp lý.',
        'Máy xay chạy êm, xay nhuyễn cả đá, lưỡi dao sắc, nhà mình dùng hằng ngày.',
        'Bình giữ nhiệt giữ nóng cả buổi, nắp kín không rỉ nước, bỏ balo rất yên tâm.',
      ],
      mid: [
        'Dụng cụ nấu ăn dùng tốt, tay cầm hơi nóng nếu để gần bếp lâu.',
        'Kích thước nhỏ hơn mình tưởng một chút, nhưng chất lượng thì không có gì chê.',
      ],
      neg: [
        'Nồi bị bong lớp chống dính sau vài lần chiên, chưa thấy ai bán hàng như vậy.',
        'Nắp hộp bị cong, đậy không kín, đổ nước ra ngoài cả balo.',
        'Hộp ngoài bị rách, bên trong có vết nứt nhỏ, nhìn rất tiếc.',
      ],
    },
    'noi-that': {
      pos: [
        'Bàn ghế lắp ráp dễ, khung chắc chắn, màu gỗ thực tế đẹp như hình.',
        'Ghế ngồi cả ngày không mỏi lưng, lưới thoáng, chỉnh độ cao êm.',
        'Kệ chắc chắn, đóng gói kỹ từng tấm, lắp xong đứng rất vững.',
      ],
      mid: [
        'Sản phẩm đúng mô tả, chỉ là hướng dẫn lắp ráp hơi khó hiểu, mất gần một tiếng.',
        'Mặt bàn đẹp nhưng mùi gỗ công nghiệp hơi nồng, để thoáng vài hôm là hết.',
      ],
      neg: [
        'Nội thất nhận về bị trầy ở cạnh bàn và thiếu ốc vít, lắp không xong.',
        'Chân ghế bị lệch, ngồi chòng chành, phải nhắn shop xin đổi.',
      ],
    },
    'do-dien-gia-dung': {
      pos: [
        'Nồi chiên không dầu dùng rất tiện, đồ ăn giòn đều, dễ vệ sinh sau khi nấu.',
        'Robot hút bụi chạy tự động ổn, hút sạch tóc và bụi, nhớ được cả bản đồ phòng.',
        'Nồi cơm điện nấu cơm dẻo thơm, giữ ấm tốt cả buổi, nắp đậy kín.',
        'Bếp từ nóng nhanh, chỉnh nhiệt chính xác, hẹn giờ tắt rất an toàn.',
      ],
      mid: [
        'Dùng được, chạy ổn nhưng hơi ồn hơn mình nghĩ, ban đêm hơi khó chịu.',
        'Máy dùng tạm ổn, dây điện hơi ngắn nên phải mua thêm ổ nối.',
      ],
      neg: [
        'Máy chạy được vài lần thì có mùi khét, nghi động cơ yếu, hơi lo khi dùng tiếp.',
        'Robot hút bụi hay kẹt ở gầm ghế và báo lỗi liên tục, không tiện như quảng cáo.',
      ],
    },
    'trang-tri-nha-cua': {
      pos: [
        'Đèn ngủ ánh sáng vàng ấm, đặt đầu giường nhìn rất có không khí.',
        'Tranh treo tường in sắc nét, khung chắc, treo phòng khách lên rất có gu.',
        'Gương trang trí không bị méo hình, viền đẹp, chụp ảnh rất ưng.',
      ],
      mid: [
        'Chất liệu ổn trong tầm giá, màu thực tế nhạt hơn ảnh một chút.',
        'Rèm cửa đẹp nhưng vải hơi mỏng, cần lót thêm lớp nữa mới cản sáng tốt.',
      ],
      neg: [
        'Đèn bật lên có tiếng ù và nhấp nháy, đã nhắn shop xin đổi nhưng chưa phản hồi.',
        'Tranh nhận về bị trầy khung và màu in nhạt hơn ảnh nhiều, hơi thất vọng.',
      ],
    },
    'chan-ga-goi-nem': {
      pos: [
        'Chăn ga mềm mịn, thấm hút tốt, giặt máy vài lần không bị xù hay phai màu.',
        'Gối nệm nằm êm, không bị xẹp sau vài tuần dùng, ngủ ngon hơn hẳn.',
        'Bộ ga gối lên màu đẹp, vải mát, nằm điều hòa cả đêm vẫn dễ chịu.',
      ],
      mid: [
        'Chăn mềm và ấm nhưng hơi nặng với mình, mùa hè chắc sẽ nóng.',
        'Gối êm, cao hơn mình tưởng, kê một thời gian mới quen.',
      ],
      neg: [
        'Chăn ga màu ra khác ảnh nhiều, vải mỏng và bị ra màu khi giặt lần đầu.',
        'Nệm bị xẹp nhanh sau hai tuần, nằm bị lún hẳn một bên.',
      ],
    },
  },
  'sac-dep-suc-khoe': {
    'cham-soc-da': {
      pos: [
        'Kem dưỡng thấm nhanh, không bết dính, dùng một tuần da mềm mịn hẳn.',
        'Da mềm, không kích ứng, mình da nhạy cảm dùng vẫn ổn.',
        'Sữa rửa mặt tạo bọt nhẹ, rửa xong không bị khô căng, mùi thơm dễ chịu.',
        'Serum thấm nhanh, dùng đều vài tuần thấy da sáng và đều màu hơn.',
        'Mặt nạ cấp ẩm tốt, đắp xong da căng bóng, đáng mua với giá này.',
        'Kem chống nắng nhẹ, không để lại vệt trắng, đi nắng cả ngày không bị bí da.',
        'Hàng chính hãng, có tem phụ tiếng Việt, quét mã vạch ra đúng sản phẩm.',
      ],
      mid: [
        'Dùng được, da cải thiện nhẹ nhưng chưa thấy hiệu quả rõ như quảng cáo.',
        'Mùi hơi nồng với mình, nhưng thấm tốt và không gây nổi mụn.',
        'Sản phẩm ổn, chỉ là dung tích hơi ít so với giá, dùng nhanh hết.',
        'Hiệu quả vừa phải, dùng cả tháng mới thấy khác biệt nhẹ.',
      ],
      neg: [
        'Dùng xong bị nổi mẩn đỏ vùng má, chắc không hợp da mình, phải ngưng dùng.',
        'Hộp bị móp, nắp lỏng, kem có dấu hiệu bị tràn trong hộp, không dám dùng.',
        'Mùi lạ, kết cấu loãng hơn mình từng dùng, nghi không phải hàng chính hãng.',
        'Hạn sử dụng còn rất ngắn so với ngày nhận hàng, shop nên kiểm tra kỹ hơn.',
      ],
    },
    'trang-diem': {
      pos: [
        'Son lên màu chuẩn, mịn môi, lâu trôi, ăn uống xong vẫn còn màu.',
        'Phấn phủ mịn, kiềm dầu tốt, trang điểm từ sáng đến tối vẫn đều màu.',
        'Mascara không lem, không vón cục, chải lên mi dài và cong rất tự nhiên.',
      ],
      mid: [
        'Màu son lên hơi khác trong hình một chút, nhưng vẫn đẹp và dễ dùng.',
        'Kem nền che phủ tốt nhưng hơi khô với da mình, phải dưỡng ẩm kỹ trước khi dùng.',
      ],
      neg: [
        'Son lên màu khác hẳn hình, khô môi và nhanh trôi, thất vọng.',
        'Mascara bị vón cục và trôi sau vài giờ, mắt lem nhìn rất mệt.',
      ],
    },
    'cham-soc-toc': {
      pos: [
        'Dầu gội sạch gàu, mùi thơm dịu, gội xong tóc mềm mượt không bị khô.',
        'Dầu xả để vài phút là tóc suôn hẳn, dùng một tháng thấy tóc ít rối và đỡ gãy rụng.',
        'Serum tóc không bết, thơm lâu, tóc vào nếp rất dễ.',
      ],
      mid: [
        'Dầu gội sạch và thơm, nhưng tóc mình hơi khô nên phải dùng thêm dầu xả.',
        'Mùi hơi nồng lúc đầu, dùng quen thì thấy ổn, hiệu quả ở mức vừa phải.',
      ],
      neg: [
        'Gội xong da đầu bị ngứa và tóc xơ hơn trước, chắc không hợp với mình.',
        'Chai bị rò rỉ nắp, dầu gội chảy ướt cả hộp khi giao tới.',
      ],
    },
    'nuoc-hoa': {
      pos: [
        'Nước hoa lưu hương lâu, mùi dịu nhẹ, nhiều người hỏi mình dùng loại gì.',
        'Mùi hương sang, không gắt, xịt buổi sáng tối vẫn còn thoang thoảng.',
        'Chai đẹp, vòi xịt mịn, mua làm quà tặng rất ra dáng.',
      ],
      mid: [
        'Mùi thơm dịu nhưng lưu hương chỉ tầm 4–5 tiếng, mình mong lâu hơn.',
        'Hương hơi khác so với mô tả một chút, nhưng vẫn dễ chịu.',
      ],
      neg: [
        'Chai bị rò rỉ khi giao tới, nước hoa gần như mất một phần ba, rất tiếc.',
        'Mùi bay rất nhanh, chưa tới một tiếng đã hết, nghi không phải hàng chính hãng.',
      ],
    },
    'thuc-pham-chuc-nang': {
      pos: [
        'Vitamin dễ uống, không bị cồn ruột, dùng đều thấy người khỏe hơn.',
        'Collagen dễ pha, vị dễ uống, dùng đều hơn tháng thấy da đỡ khô.',
        'Hộp còn niêm phong, date xa, có tem chính hãng và hướng dẫn tiếng Việt đầy đủ.',
      ],
      mid: [
        'Viên uống dễ nuốt, nhưng là thực phẩm chức năng nên mình chưa thấy hiệu quả rõ ràng.',
        'Dùng được, giá hơi cao so với dung lượng trong hộp.',
      ],
      neg: [
        'Uống xong bị đầy bụng và buồn nôn, chắc không hợp cơ địa, đã phải ngưng.',
        'Hộp bị móp, niêm phong có dấu hiệu từng mở, mình không dám dùng.',
      ],
    },
  },
  'giay-dep-tui-xach': {
    'giay-the-thao': {
      pos: [
        'Giày đi êm chân, đế mềm, đi cả ngày không đau gót.',
        'Form giày chuẩn, ôm chân, đường may chắc chắn, nhìn cao cấp hơn giá.',
        'Size chuẩn, mình đi 39 đặt 39 vừa in, không phải đổi.',
        'Màu giày thực tế đẹp, đúng như ảnh, phối đồ dễ.',
        'Giày chạy bộ nhẹ, thoáng khí, chạy 5km không bị phồng chân.',
      ],
      mid: [
        'Giày đẹp nhưng size hơi chật với bàn chân bè, nên chọn lên một size.',
        'Đế giày hơi cứng lúc mới đi, chắc cần vài hôm cho mềm.',
      ],
      neg: [
        'Giày đi được hai tuần đã bong keo ở mũi, hơi tiếc vì mua cho đợt đi làm.',
        'Size lệch so với bảng size, đi bị chật đau ngón, đổi trả hơi mất công.',
        'Giày hôi keo và thoáng khí kém, đi buổi trưa bí chân khó chịu.',
      ],
    },
    'sandal-dep': {
      pos: [
        'Sandal đi nhẹ, quai mềm không cọ chân, đi mưa vẫn bám tốt.',
        'Dép đi trong nhà êm, đế không trơn trượt, đi trên sàn gạch rất an tâm.',
        'Quai dép mềm ôm chân, đi cả ngày không bị cọ hay phồng rộp.',
      ],
      mid: [
        'Dép đẹp nhưng quai hơi cứng lúc đầu, đi vài hôm mới thật êm chân.',
        'Size hơi rộng một chút, chắc nên chọn nhỏ hơn nửa size.',
      ],
      neg: [
        'Quai dép bị bung keo chỉ sau hai tuần đi mưa, nhìn xuống cấp rất nhanh.',
        'Đế mòn rất nhanh, đi một tháng đã trơn trượt nguy hiểm.',
      ],
    },
    'tui-xach': {
      pos: [
        'Túi xách da đẹp, đường chỉ đều, ngăn bên trong chia hợp lý, đựng vừa laptop 14 inch.',
        'Khóa kéo mượt, da không có mùi hắc, giao kèm túi vải bảo quản rất kỹ.',
        'Túi nhẹ, ngăn gọn gàng, đi làm hay đi chơi đều phối được.',
      ],
      mid: [
        'Túi đẹp, chất ổn, chỉ là quai hơi cứng, mang lâu hơi cấn vai.',
        'Màu thực tế hơi đậm hơn ảnh, nhưng nhìn vẫn sang.',
      ],
      neg: [
        'Túi nhận về có vết xước dài ở mặt trước và chỉ thừa nhiều chỗ, nhìn rất ẩu.',
        'Khóa túi bị kẹt và đường chỉ ở quai bị bung sau vài lần dùng.',
      ],
    },
    'balo-vali': {
      pos: [
        'Balo chống nước tốt, dây đeo êm vai, đi học đi làm đều tiện.',
        'Vali kéo trơn tru, bánh xe êm, khóa số chắc chắn, đi chuyến bay dài vẫn nguyên vẹn.',
        'Balo nhiều ngăn, ngăn laptop có đệm êm, đi học đi làm rất gọn.',
      ],
      mid: [
        'Balo đủ rộng, đựng được nhiều đồ, nhưng chống nước chưa hoàn hảo, mưa to vẫn thấm nhẹ.',
        'Mẫu đẹp như hình, nhưng mùi keo hơi nồng lúc mới mở hộp, phơi vài ngày thì hết.',
      ],
      neg: [
        'Khóa vali kẹt ngay lần đầu sử dụng, bánh xe cũng hơi lệch.',
        'Dây balo bị đứt chỉ sau vài lần đeo đồ nặng, chất lượng không như quảng cáo.',
        'Màu thực tế tối và xỉn hơn trong ảnh nhiều, chất liệu cũng mỏng.',
      ],
    },
  },
  'dong-ho-phu-kien': {
    'dong-ho-nam': {
      pos: [
        'Đồng hồ chạy chuẩn giờ, mặt kính trong, dây da mềm đeo không bị cấn tay.',
        'Hộp và thẻ bảo hành đầy đủ, nhìn rất sang, mua làm quà tặng cực hợp.',
        'Mặt đồng hồ ngoài đời đẹp hơn trong ảnh, kim dạ quang sáng rõ buổi tối.',
        'Chống nước tốt, mình đeo đi bơi nhẹ vẫn không vào hơi.',
      ],
      mid: [
        'Đồng hồ đẹp nhưng mặt hơi to với cổ tay nhỏ, đeo lên hơi nặng tay.',
        'Máy chạy đúng, dây hơi cứng lúc mới đeo, cần vài ngày cho mềm.',
      ],
      neg: [
        'Đồng hồ chạy chậm mất vài phút mỗi ngày, mặt kính có vết xước nhỏ ngay khi mở hộp.',
        'Dây da bị bong mép sau ba tuần đeo, nhìn xuống cấp rất nhanh.',
        'Đồng hồ không có thẻ bảo hành như shop cam kết, hỏi mãi mới chịu gửi bù.',
        'Pin đồng hồ hết chỉ sau một tháng, thay pin ở tiệm thấy lắp ráp khá ẩu.',
      ],
    },
    'dong-ho-nu': {
      pos: [
        'Đồng hồ nữ mặt nhỏ xinh, dây kim loại đeo êm, phối đồ nào cũng hợp.',
        'Dây đồng hồ chỉnh dễ, mình tự cắt bớt mắt xích vừa tay luôn.',
        'Đồng hồ mảnh nhẹ, đeo đi làm cả ngày không vướng tay áo.',
      ],
      mid: [
        'Chất liệu ổn, nhưng hộp đựng đơn giản hơn mình nghĩ.',
        'Mặt đẹp, dây hơi lỏng với cổ tay nhỏ, phải cắt bớt mắt xích.',
      ],
      neg: [
        'Kim giây chạy giật và có hơi nước bám bên trong mặt kính sau lần rửa tay đầu tiên.',
        'Dây kim loại bị xỉn màu sau hai tuần, nhìn không giống hình quảng cáo.',
      ],
    },
    'kinh-mat': {
      pos: [
        'Kính mắt gọng nhẹ, tròng chống chói tốt, đeo lái xe rất thoải mái.',
        'Gọng kính chắc chắn, bản lề êm, có kèm hộp và khăn lau đẹp.',
        'Kính cắt tia UV tốt, đi nắng không còn chói mắt, mặt kính trong và không méo hình.',
      ],
      mid: [
        'Kính đẹp, tròng ổn, chỉ có điều gọng hơi rộng so với mặt mình.',
        'Kính nhẹ, kiểu dáng đẹp, nhưng tròng dễ bám vân tay, phải lau thường xuyên.',
      ],
      neg: [
        'Kính mắt gọng lỏng, tròng bị xước nhẹ, không giống mô tả chống trầy.',
        'Tròng kính bị lóa và nhìn lâu hơi chóng mặt, nghi không đúng thông số.',
      ],
    },
    'trang-suc': {
      pos: [
        'Trang sức bạc sáng bóng, thiết kế tinh tế, đeo cả tuần chưa bị xỉn màu.',
        'Vòng tay mảnh, sáng, tặng bạn gái cô ấy rất thích.',
        'Dây chuyền thanh mảnh, mặt đính đá lấp lánh, tặng mẹ mẹ rất thích.',
      ],
      mid: [
        'Trang sức đẹp, mình thấy mặt đá hơi nhỏ hơn trong ảnh một chút.',
        'Sản phẩm đẹp, chỉ là móc khóa hơi khó cài một mình.',
      ],
      neg: [
        'Trang sức bạc bị xỉn đen sau vài hôm, hơi nghi chất liệu không phải bạc thật.',
        'Mặt đá bị rơi ra chỉ sau vài lần đeo, nhìn xuống cấp nhanh.',
      ],
    },
  },
  'the-thao-da-ngoai': {
    'dung-cu-gym-yoga': {
      pos: [
        'Thảm yoga dày dặn, bám sàn tốt, tập đổ mồ hôi vẫn không trơn trượt.',
        'Tạ tay chắc chắn, lớp bọc cao su không có mùi, cầm vừa tay.',
        'Dây kháng lực co giãn tốt, đàn hồi đều, mang đi du lịch tập vẫn gọn.',
        'Con lăn tập bụng chắc chắn, bánh êm, giao kèm tấm lót gối rất chu đáo.',
      ],
      mid: [
        'Dùng tốt nhưng lúc mới mở có mùi cao su khá nồng, để thoáng vài hôm mới hết.',
        'Thảm đẹp, hơi nặng khi mang đi tập xa, ở nhà thì không có gì chê.',
      ],
      neg: [
        'Thảm yoga bị bong lớp mặt sau vài tuần, trơn hơn hẳn lúc đầu.',
        'Dây kháng lực bị đứt giữa lúc tập, may mà không bị thương, shop nên kiểm tra chất lượng.',
      ],
    },
    'xe-dap-phu-kien': {
      pos: [
        'Xe đạp lắp xong chạy êm, phanh ăn, khung nhôm nhẹ đi phố rất thích.',
        'Mũ bảo hiểm xe đạp nhẹ, thoáng, chỉnh size dễ, đội cả buổi không nặng đầu.',
        'Đèn xe đạp sáng rõ, sạc USB tiện, pin dùng được nhiều buổi tối.',
      ],
      mid: [
        'Xe đạp chạy ổn, lắp ráp mất hơn một tiếng và cần chỉnh lại phanh.',
        'Khóa xe chắc nhưng hơi nặng khi mang theo, chắc phải làm quen.',
      ],
      neg: [
        'Xe đạp nhận về bị cong niềng, ốc lỏng nhiều chỗ, tự chỉnh mới đi được.',
        'Phanh kêu rít và ăn không đều, phải mang ra tiệm chỉnh lại mới dám đi.',
      ],
    },
    'do-da-ngoai-cam-trai': {
      pos: [
        'Lều dựng nhanh, chống thấm ổn, mình đi cắm trại gặp mưa đêm vẫn khô ráo.',
        'Balo dã ngoại nhiều ngăn, lưng thoáng, đi trek hai ngày vẫn không đau vai.',
        'Túi ngủ ấm, bông nhồi đều, đi Sa Pa mùa lạnh ngủ rất ngon.',
      ],
      mid: [
        'Lều đủ cho 2 người, hơi chật nếu mang nhiều đồ, bù lại rất nhẹ.',
        'Túi ngủ ấm nhưng hơi cồng kềnh khi gấp lại, balo phải để dư chỗ.',
      ],
      neg: [
        'Lều bị thấm nước ở đường may khi gặp mưa, ngủ không yên, hơi thất vọng.',
        'Khóa kéo lều bị kẹt và cọc lều hơi cong, dựng mất cả tiếng mới xong.',
      ],
    },
    'do-the-thao-ngoai-troi': {
      pos: [
        'Áo thể thao thấm hút mồ hôi nhanh khô, chạy bộ không bị bí.',
        'Quần chạy bộ nhẹ, co giãn tốt, có túi khóa kéo để chìa khóa rất tiện.',
        'Giày trail bám đường tốt, đế êm, chạy địa hình ướt không bị trượt.',
      ],
      mid: [
        'Áo thoáng nhưng form hơi ngắn với người cao, nên cân nhắc lên một size.',
        'Đồ đẹp, thoáng, nhưng mặc vài lần thì hơi xù nhẹ ở vùng nách.',
      ],
      neg: [
        'Giày thể thao nhỏ hơn size thường, bị phồng chân sau buổi chạy đầu tiên.',
        'Hàng không giống ảnh, chất liệu mỏng và có vài chỗ chỉ thừa, khá tiếc.',
      ],
    },
  },
  'me-be': {
    'sua-ta-be': {
      pos: [
        'Sữa mới, date xa, bé uống hợp, không bị táo hay đầy hơi.',
        'Tã mềm, thấm hút tốt, bé ngủ cả đêm mà mông vẫn khô thoáng.',
        'Hàng chính hãng, tem phụ rõ ràng, mẹ bỉm như mình mua rất yên tâm.',
        'Giao nhanh đúng lúc nhà hết tã, đóng gói kỹ, shop còn tặng kèm bộ khăn sữa.',
        'Núm ty mềm, bé bú dễ, không sặc, nhiều mẹ trong nhóm cũng khen.',
      ],
      mid: [
        'Tã thấm hút ổn, chỉ là size hơi nhỏ so với bảng, bé cứng cân nên phải lên size.',
        'Sữa ổn, bé uống được, nhưng hộp hơi móp một góc lúc nhận.',
      ],
      neg: [
        'Bé bị hăm sau vài ngày dùng tã này, đã phải đổi sang loại khác, hơi tiếc.',
        'Hộp sữa bị móp, nắp có dấu hiệu đã mở, mình không dám cho bé dùng.',
        'Hàng gần hết hạn sử dụng, mua cho bé mà thế này mẹ rất lo, mong shop kiểm tra kỹ.',
      ],
    },
    'do-choi-tre-em': {
      pos: [
        'Đồ chơi chất liệu an toàn, không mùi, màu sắc tươi nên bé thích lắm.',
        'Bé nhà mình mê cuốn sách vải này, vừa chơi vừa học màu sắc, giặt cũng dễ.',
        'Bộ xếp hình chắc, các chi tiết khớp nhau vừa vặn, bé chơi cả buổi không chán.',
      ],
      mid: [
        'Đồ chơi đẹp, bé thích, nhưng sơn hơi bóng, mẹ phải lau kỹ trước khi cho bé chơi.',
        'Đồ chơi ổn nhưng hơi ồn khi bật nhạc, mẹ phải chỉnh âm lượng.',
      ],
      neg: [
        'Đồ chơi có mùi nhựa nồng, mình không dám cho bé chơi, đang xin shop đổi.',
        'Đồ chơi bị bung một chi tiết nhỏ ngay lần đầu chơi, rất nguy hiểm cho bé.',
      ],
    },
    'xe-day-ghe-an-di-choi': {
      pos: [
        'Xe đẩy nhẹ, gấp gọn một tay, đi du lịch bỏ cốp xe vẫn dư chỗ.',
        'Ghế ăn chắc chắn, dây an toàn đầy đủ, dễ lau rửa sau mỗi bữa ăn dặm.',
        'Xe đẩy bánh êm, mái che rộng, bé ngồi ngủ ngon giấc suốt chuyến đi dạo.',
      ],
      mid: [
        'Xe đẩy chắc, đi êm nhưng hơi nặng, xách lên xuống cầu thang hơi mệt.',
        'Ghế ăn tiện nhưng khay hơi khó tháo, mẹ phải làm quen mới nhanh.',
      ],
      neg: [
        'Ghế ăn bị lỏng bánh xe, mình phải tự siết lại, nguy hiểm nếu không để ý.',
        'Xe đẩy gấp lại bị kẹt chốt, phải vật lộn mãi mới gấp được.',
      ],
    },
    'quan-ao-so-sinh': {
      pos: [
        'Quần áo sơ sinh cotton mềm, đường may phẳng, bé mặc không bị hăm.',
        'Bộ body suit co giãn tốt, cài cúc dưới tiện thay tã, bé mặc ngủ rất thoải mái.',
        'Set đồ sơ sinh nhỏ xinh, vải xô thoáng, giặt vài lần vẫn mềm không xù.',
      ],
      mid: [
        'Quần áo mềm, nhưng giặt xong hơi co, mẹ nên mua lớn hơn một size.',
        'Đồ đẹp nhưng đường may cổ hơi cộm, mẹ phải lộn trái khi mặc cho bé.',
      ],
      neg: [
        'Quần áo bị ra màu khi giặt lần đầu, ố cả đồ khác, rất bực mình.',
        'Vải mỏng và hơi thô, mình lo da bé nhạy cảm nên không cho mặc.',
      ],
    },
  },
  'sach-van-phong-pham': {
    'sach-van-hoc-ky-nang': {
      pos: [
        'Sách in đẹp, giấy dày trắng, chữ rõ, bìa chắc không bị cong.',
        'Nội dung sách hay, dễ đọc, mình đọc một mạch hết trong hai buổi tối.',
        'Giao kèm bookmark dễ thương, sách được bọc kỹ, không trầy xước chút nào.',
      ],
      mid: [
        'Sách hay nhưng giấy hơi mỏng so với giá, đọc cẩn thận kẻo bị nhăn.',
        'Bìa sách hơi cong nhẹ ở góc khi nhận, nội dung thì không có gì chê.',
      ],
      neg: [
        'Sách nhận về bị rách bìa và ố vàng vài trang, rõ ràng là hàng tồn kho.',
        'Thiếu một cuốn trong bộ sách nhưng vẫn tính đủ tiền, nhắn shop mới biết hết hàng.',
        'Bọc sách ẩu, hộp không chèn gì nên sách bị móp góc, tiếc vì mua làm quà.',
      ],
    },
    'sach-thieu-nhi': {
      pos: [
        'Sách thiếu nhi tranh minh họa đẹp, chữ to, bé nhà mình ngồi đọc cả buổi.',
        'Sách giấy dày, góc bo tròn nên bé cầm không bị xước, nội dung dễ hiểu.',
        'Bé mê bộ truyện này, tối nào cũng đòi đọc, có nhiều bài học nhẹ nhàng.',
      ],
      mid: [
        'Sách đẹp nhưng chữ hơi nhỏ với bé mới tập đọc, ba mẹ phải đọc cùng.',
        'Nội dung hay, bìa mỏng hơn mình nghĩ nên sợ bé làm rách.',
      ],
      neg: [
        'Sách in bị lệch màu và có trang bị dính, bé cầm lên là rách.',
        'Giao thiếu một cuốn trong bộ và bìa bị móp, hơi buồn vì mua làm quà cho bé.',
      ],
    },
    'van-phong-pham': {
      pos: [
        'Sổ tay giấy mịn, viết bút bi hay bút gel đều không lem, thích lắm.',
        'Bút viết trơn, mực đều, cầm êm tay, viết nhiều không mỏi.',
        'Giấy A4 trắng mịn, in hai mặt không bị lem, đóng gói gọn gàng.',
      ],
      mid: [
        'Bút viết ổn nhưng nét hơi đậm, ai thích nét mảnh nên cân nhắc.',
        'Sổ đẹp, bìa chắc, tiếc là gáy hơi cứng nên mở phẳng không dễ.',
        'Văn phòng phẩm đúng như mô tả, chỉ là đóng gói đơn giản, hơi lỏng lẻo.',
      ],
      neg: [
        'Bút bị tắc mực ngay lần đầu dùng, mua 5 cây thì 2 cây không viết được.',
        'Sổ giấy mỏng, viết bút gel bị lem sang mặt sau, không như quảng cáo.',
      ],
    },
    'dung-cu-hoc-tap': {
      pos: [
        'Hộp bút đựng được nhiều đồ, đường may chắc, hợp cho học sinh đi học hằng ngày.',
        'Bộ dụng cụ học tập đủ món, chất lượng tốt hơn mình nghĩ, giá hợp lý.',
        'Máy tính cầm tay bấm nhạy, màn hình rõ, đáp ứng tốt cho kỳ thi.',
      ],
      mid: [
        'Dụng cụ dùng ổn, nhưng thước hơi cong nhẹ, bù lại giá rất mềm.',
        'Bộ compa chắc tay, tiếc là hộp đựng hơi mỏng.',
      ],
      neg: [
        'Hộp bút bị lỗi khóa kéo, dùng một tuần thì bung chỉ.',
        'Máy tính bấm hay bị đơ phím, phải bấm mạnh mới ăn, đang xin shop đổi.',
      ],
    },
  },
  'thuc-pham-do-uong': {
    'do-an-vat': {
      pos: [
        'Bánh giòn tan, vị vừa miệng, không quá ngọt, cả nhà ăn hết sạch trong hai ngày.',
        'Hạt dinh dưỡng giòn, không bị dầu hay hôi, ăn sáng cùng sữa chua rất ngon.',
        'Mứt trái cây dẻo thơm, không ngọt gắt, cả nhà khen ngon, sẽ mua thêm dịp Tết.',
        'Hàng mới, hạn sử dụng còn dài, hộp giao tới không bị móp.',
      ],
      mid: [
        'Vị ngon nhưng hơi ngọt với khẩu vị mình, lần sau sẽ chọn loại ít đường.',
        'Hạt ăn ổn, có vài hạt bị mềm, chắc do độ ẩm khi vận chuyển.',
      ],
      neg: [
        'Bánh bị mốc nhẹ khi mở hộp, ngày sản xuất cũ hơn nhiều so với mô tả, rất lo.',
        'Đồ ăn vặt bị ỉu, bao bì rách, bên trong ẩm, chắc để lâu hoặc vận chuyển ẩu.',
        'Hàng cận date, nhận về chỉ còn vài hôm là hết hạn, rất khó tiêu thụ.',
      ],
    },
    'ca-phe-tra': {
      pos: [
        'Cà phê thơm đậm, pha phin ra màu đẹp, vị đắng nhẹ hậu ngọt, rất hợp gu mình.',
        'Trà thơm dịu, đóng gói kín nên giữ được mùi, uống buổi tối rất dễ ngủ.',
        'Nước ép thơm tự nhiên, uống thấy vị trái cây thật, không bị gắt hương liệu.',
      ],
      mid: [
        'Cà phê thơm, mình thấy hơi chua so với gu, nhưng pha sữa thì rất hợp.',
        'Trà thơm nhưng túi lọc hơi nhỏ, hãm hơi nhạt nên mình hãm hai túi.',
      ],
      neg: [
        'Cà phê lẫn nhiều hạt lép, pha lên chua gắt và loãng, hơi thất vọng.',
        'Trà có mùi ẩm nhẹ, nghi để lâu hoặc bảo quản không kín.',
      ],
    },
    'dac-san-viet-nam': {
      pos: [
        'Đặc sản hút chân không kỹ, có date rõ ràng, mua làm quà biếu rất ổn.',
        'Mực khô sấy thơm, dai vừa, nướng lên ăn nhậu hết sạch.',
        'Đặc sản đóng hộp đẹp, thơm ngon đúng vị quê, biếu cả nhà ai cũng khen.',
      ],
      mid: [
        'Đặc sản ngon, tiếc là gói hơi ít so với giá, ăn một lần là hết.',
        'Hương vị ngon nhưng hơi mặn so với khẩu vị gia đình mình.',
      ],
      neg: [
        'Mực khô mặn gắt và cứng, không giống ảnh, ăn không hết phải bỏ.',
        'Hộp bị móp vỡ, đồ bên trong nát vụn, mua làm quà biếu mà thế này thì tiếc quá.',
      ],
    },
    'ngu-coc-hat-dinh-duong': {
      pos: [
        'Ngũ cốc ăn sáng vị nhẹ, uống với sữa ngon, ít đường nên mình rất thích.',
        'Hạt óc chó tươi, giòn, vỏ mỏng, không bị đắng hay ôi dầu.',
        'Bột ngũ cốc pha nhanh, uống sáng no lâu và không bị vón cục.',
      ],
      mid: [
        'Ngũ cốc ngon nhưng hơi nhạt với mình, thêm mật ong mới vừa miệng.',
        'Hạt tươi, giòn, chỉ tiếc gói hơi ít so với giá.',
      ],
      neg: [
        'Hạt bị ôi, có mùi hắc dầu, ăn không nổi, đã bỏ cả gói.',
        'Gói ngũ cốc bị rách, vụn nhiều hơn nguyên hạt, hơi tiếc.',
      ],
    },
  },
  'thu-cung': {
    'thuc-an-thu-cung': {
      pos: [
        'Bé mèo nhà mình ăn rất ngon miệng, hạt thơm, ít mùi hôi và phân đẹp hơn trước.',
        'Chó nhà mình mê món này, ăn hết sạch bát trong vài phút, lông bóng lên thấy rõ.',
        'Bao bì hạt kín, còn hạn dài, giao nhanh trong ngày đúng lúc nhà sắp hết.',
      ],
      mid: [
        'Bé ăn được nhưng hơi kén, phải trộn thêm với loại cũ mới chịu ăn hết.',
        'Hạt thơm, bé thích, nhưng giá hơi cao hơn loại cũ mình mua.',
      ],
      neg: [
        'Bé mèo nhà mình ăn xong bị nôn và tiêu chảy, đã phải ngưng cho ăn loại này.',
        'Hạt nhận về có mùi lạ, bé ngửi rồi bỏ đi, nghi hàng để lâu hoặc bảo quản không tốt.',
        'Hộp bị rách, hạt rơi vãi trong thùng, gói bên trong cũng bị thủng.',
      ],
    },
    'phu-kien-do-choi-thu-cung': {
      pos: [
        'Đồ chơi bền, bé chó cắn mạnh cả tuần vẫn chưa hỏng, giúp bé xả bớt năng lượng.',
        'Vòng cổ êm, khóa chắc, size vừa đẹp, nhìn bé xinh hẳn.',
        'Nhà cho mèo chắc chắn, êm ái, bé mới nhận về đã chui vào ngủ ngay.',
        'Đệm nằm êm và dễ giặt, bé nằm cả ngày không chịu rời đi.',
        'Xương gặm sạch, không có mùi lạ, bé chó thích lắm, lại giúp sạch răng.',
      ],
      mid: [
        'Đồ chơi đẹp, bé thích, chỉ có điều lớp ngoài hơi mỏng, sợ bé cắn rách.',
        'Vòng cổ đẹp, nhưng khóa hơi cứng, đeo cho bé phải hơi mất công.',
      ],
      neg: [
        'Đồ chơi bị bung chỉ chỉ sau một buổi chơi, may mà bé chưa nuốt phải.',
        'Vòng cổ nhỏ hơn size mô tả nhiều, đeo không vừa, đổi trả hơi phiền.',
      ],
    },
    've-sinh-cham-soc-thu-cung': {
      pos: [
        'Cát vệ sinh vón cục tốt, ít bụi, khử mùi hiệu quả, nhà mình dùng thường xuyên.',
        'Dầu gội dịu nhẹ, tắm xong lông mềm mượt, không làm bé bị ngứa hay khô da.',
        'Lược chải lông gỡ rối nhẹ nhàng, bé không bị đau, lông rụng bám vào lược rất ít.',
      ],
      mid: [
        'Cát vón tốt nhưng vẫn bám khá nhiều vào chân bé, phải quét dọn thường xuyên.',
        'Dầu gội thơm, tắm tạm ổn, nhưng mình thấy lông bé hơi khô một chút.',
      ],
      neg: [
        'Cát vệ sinh vón kém, bụi bay nhiều, mèo nhà mình hắt hơi liên tục.',
        'Dầu gội mùi hơi nồng, bé tắm xong gãi nhiều, mình phải tắm lại bằng loại cũ.',
      ],
    },
  },
  'o-to-xe-may': {
    'phu-kien-o-to': {
      pos: [
        'Camera hành trình quay rõ ban ngày, ban đêm vẫn chấp nhận được, lắp đặt dễ.',
        'Tấm che nắng ô tô vừa kính, bảo vệ nội thất tốt, xe đỗ ngoài trời vẫn mát.',
        'Thảm lót sàn vừa form xe, dày dặn, dễ vệ sinh, không có mùi cao su hắc.',
        'Giá đỡ điện thoại kẹp chắc, xoay linh hoạt, đi đường xóc không bị rơi.',
      ],
      mid: [
        'Camera quay ổn, ban đêm hơi nhiễu, hy vọng cập nhật firmware sẽ cải thiện.',
        'Giá đỡ chắc, hơi to với điện thoại nhỏ, phải chỉnh mới vừa.',
      ],
      neg: [
        'Camera hành trình hay tự tắt giữa chừng, thẻ nhớ báo lỗi, phải xin bảo hành.',
        'Thảm lót sàn không vừa form xe, phải cắt viền mới lắp được, rất mất công.',
      ],
    },
    'phu-kien-xe-may': {
      pos: [
        'Gương chiếu hậu lắp vừa khít, nhìn rõ, không bị rung khi chạy tốc độ cao.',
        'Đèn LED sáng trắng, lắp dễ, có hướng dẫn kèm theo, đi đêm nhìn rõ hơn hẳn.',
        'Bơm lốp mini dùng tiện, bơm nhanh, mang theo xe rất gọn.',
      ],
      mid: [
        'Sản phẩm dùng tốt, nhưng hướng dẫn lắp bằng tiếng Anh nên phải xem thêm video.',
        'Gương đẹp, rộng, nhưng chân gương hơi dài nên phải chỉnh lại mới vừa tay lái.',
      ],
      neg: [
        'Gương chiếu hậu bị rung và nhìn không rõ, chân gương hơi lỏng ngay lần đầu lắp.',
        'Đèn LED sáng nhưng chớp tắt liên tục, nghi lỗi nguồn, đã nhắn shop chờ xử lý.',
        'Hộp giao bị nén, sản phẩm bên trong cong vênh, trầy sơn một mảng.',
      ],
    },
    'mu-bao-hiem': {
      pos: [
        'Mũ bảo hiểm nhẹ, lớp lót êm, quai cài chắc, đội đi đường xa không bị nóng đầu.',
        'Mũ có kính chắn gió chống tia UV, đội đi phượt cả ngày không bị nóng đầu.',
        'Mũ đạt chuẩn, mút lót tháo giặt được, đội lên ôm đầu và không bị lỏng.',
      ],
      mid: [
        'Mũ đẹp, chất ổn, nhưng kính chắn gió hơi dễ bám hơi nước vào sáng sớm.',
        'Mũ nhẹ, nhưng size hơi rộng, mình phải lót thêm miếng mút mới vừa.',
      ],
      neg: [
        'Mũ bảo hiểm size lệch, đội chật ở thái dương, quai cứng, đội đau cằm.',
        'Kính mũ bị xước ngay khi mở hộp và chốt cài bị lỏng, không an tâm khi đội.',
      ],
    },
    'cham-soc-xe': {
      pos: [
        'Dầu nhớt đúng loại, máy chạy êm hẳn sau khi thay, tay ga nhẹ hơn.',
        'Nước rửa xe ít bọt, lau xong bóng loáng, không để lại vệt nước.',
        'Dung dịch đánh bóng lên màu rất đẹp, xóa được nhiều vết xước nhỏ trên sơn.',
      ],
      mid: [
        'Dầu nhớt đúng loại, giá hơi cao hơn tiệm một chút, nhưng chính hãng nên yên tâm.',
        'Nước rửa xe sạch tốt nhưng mùi hơi nồng, phải rửa ở chỗ thoáng.',
      ],
      neg: [
        'Chai bị rò rỉ nắp, dầu nhớt chảy ướt cả thùng hàng, hao mất một phần.',
        'Dung dịch đánh bóng không hiệu quả như quảng cáo, còn để lại vệt trắng trên sơn.',
      ],
    },
  },
  'thoi-trang': {
    'ao-thun': {
      pos: [
        'Áo thun cotton dày dặn, không xuyên thấu, cổ áo không bị bai sau khi giặt.',
        'Vải mềm, mặc mát, form chuẩn như mô tả, không bị xù sau lần giặt đầu.',
        'Size chuẩn, mình 55kg mặc size M vừa vặn, lên dáng đẹp.',
        'Áo thun form rộng nhìn trẻ trung, mặc đi chơi hay ở nhà đều thoải mái.',
      ],
      mid: [
        'Form đẹp, màu hơi đậm hơn ảnh xíu, nhìn chung vẫn hài lòng.',
        'Size hơi rộng so với bảng size, bạn nào vừa người nên chọn nhỏ hơn một size.',
      ],
      neg: [
        'Vải mỏng và hơi thô, giặt một lần đã bị co lại, mặc không còn vừa.',
        'Màu thực tế khác ảnh khá nhiều, nhìn xỉn và rẻ tiền, hơi thất vọng.',
      ],
    },
    'ao-so-mi': {
      pos: [
        'Áo sơ mi ít nhăn, đi làm cả ngày vẫn phẳng phiu, mặc mát.',
        'Sơ mi vải linen mát, mặc đi làm văn phòng điều hòa hay ngoài trời đều dễ chịu.',
        'Cổ áo đứng form, cúc may chắc, nhìn lịch sự hơn mức giá.',
      ],
      mid: [
        'Vải mềm nhưng dễ nhăn, mặc đi làm phải ủi lại mới phẳng.',
        'Đường may ổn, có vài chỗ chỉ thừa nhẹ, cắt đi là xong, tổng thể vẫn ưng.',
      ],
      neg: [
        'Đường chỉ lỏng ở gấu và nách áo, mặc vài lần là bung, shop nên kiểm hàng kỹ hơn.',
        'Cổ áo bị bai và nhăn ngay sau lần giặt đầu, mặc đi làm không còn lịch sự.',
      ],
    },
    'quan-jean': {
      pos: [
        'Quần jean co giãn nhẹ, mặc thoải mái, đứng form, ngồi cả ngày không bị hằn eo.',
        'Quần jean wash màu đẹp, dáng ống đứng tôn chân, mặc cả ngày không bị bí.',
        'Đường may chắc chắn, không có chỉ thừa, nhìn cao cấp hơn mức giá.',
      ],
      mid: [
        'Quần đẹp, chất jean dày dặn, mới mặc hơi cứng nên cần giặt vài lần cho mềm.',
        'Form đứng đẹp nhưng dài hơn mình mong đợi, phải sửa lai thêm.',
      ],
      neg: [
        'Quần mặc lên hơi ngắn so với số đo trong bảng, form cũng không đứng như ảnh.',
        'Jean ra màu rất nhiều khi giặt, ố cả đồ trắng giặt chung.',
      ],
    },
    'quan-short': {
      pos: [
        'Quần short co giãn, lưng chun thoải mái, mặc ở nhà hay đi biển đều hợp.',
        'Short kaki dày vừa phải, đứng form, có túi sâu để điện thoại không bị rơi.',
        'Short jean cạp cao tôn dáng, phối với áo thun nào cũng đẹp.',
      ],
      mid: [
        'Quần đẹp nhưng cạp hơi rộng, phải thắt dây lưng mới vừa.',
        'Chất vải ổn, ngắn hơn một chút so với mình tưởng.',
      ],
      neg: [
        'Quần bị phai màu và sờn mép sau vài lần giặt, mới mặc đã thấy cũ.',
        'Size lệch nhiều so với bảng size, mặc chật eo, hết hàng nên không đổi được.',
      ],
    },
    vay: {
      pos: [
        'Chân váy xếp ly đều, xoay vòng đẹp, có lớp lót nên không lo lộ.',
        'Váy jean dáng chữ A tôn eo, vải dày vừa phải, không bị xuyên thấu khi đi nắng.',
        'Chân váy dài nhẹ, đi phố hay đi làm đều xinh, không bị nhàu.',
      ],
      mid: [
        'Váy xinh nhưng lớp lót hơi mỏng, mặc dưới nắng phải phối quần ngắn bên trong.',
        'Dáng váy đẹp, cạp hơi chật với người eo to, nên chọn lên một size.',
      ],
      neg: [
        'Chân váy bị lệch đường may bên hông và chỉ thừa nhiều, nhìn rất ẩu.',
        'Váy mỏng, lộ đồ bên trong, mặc ra đường không dám tự tin.',
      ],
    },
    dam: {
      pos: [
        'Đầm xinh, vải rủ nhẹ, đi tiệc hay đi chơi đều hợp, mọi người khen mãi.',
        'Đầm dự tiệc lên dáng cực kỳ, đường may tinh tế, khóa kéo mượt không bị kẹt.',
        'Đầm suông mặc mát, không nhăn nhiều, đi làm hay đi chơi đều hợp.',
      ],
      mid: [
        'Đầm đẹp nhưng vải hơi nhăn, phải ủi hơi nước trước khi mặc đi tiệc.',
        'Đầm đẹp, hơi dài hơn mình mong đợi, mình phải lên lai lại.',
      ],
      neg: [
        'Đầm nhận về bị bung chỉ ở eo và khóa kéo kẹt, không kịp mặc đi tiệc, rất tiếc.',
        'Màu đầm khác ảnh nhiều, nhìn xỉn và rẻ hơn mong đợi.',
      ],
    },
    'ao-khoac': {
      pos: [
        'Áo khoác dày vừa phải, giữ ấm tốt, khóa kéo mượt, đứng form nhìn rất đẹp.',
        'Áo khoác dù nhẹ, chống gió chống mưa nhẹ tốt, gấp gọn bỏ balo được.',
        'Blazer đứng form, vai chuẩn, mặc đi làm hay đi chơi đều rất lịch sự.',
      ],
      mid: [
        'Áo khoác đẹp, ấm vừa phải nhưng khóa kéo hơi cứng, kéo phải cẩn thận.',
        'Form đẹp, tay áo hơi dài một chút so với số đo của mình.',
      ],
      neg: [
        'Áo khoác mỏng hơn mô tả nhiều, mặc đi lạnh vẫn thấy buốt, không giữ ấm.',
        'Khóa kéo bị tuột răng ngay lần đầu mặc, hơi thất vọng.',
      ],
    },
  },
};

/* Kho gộp cả ngành gốc — dự phòng khi ngành lá chưa có kho riêng. */
function mergeCorpora(list: readonly Corpus[]): Corpus {
  return { pos: list.flatMap((c) => c.pos), mid: list.flatMap((c) => c.mid), neg: list.flatMap((c) => c.neg) };
}
const DEPT_UNION = Object.fromEntries(Object.entries(CORPUS).map(([dept, leaves]) => [dept, mergeCorpora(Object.values(leaves))])) as Record<Exclude<DeptKey, 'chung'>, Corpus>;

function corpusFor(dept: DeptKey, leaf: string): Corpus {
  if (dept === 'chung') return CORPUS_CHUNG;
  return CORPUS[dept][leaf] ?? DEPT_UNION[dept];
}

/* Câu chung — dùng cho mọi ngành (và là kho dự phòng khi không suy ra được ngành gốc). */
const SHIP_POS = [
  'Giao nhanh, đóng gói kỹ.',
  'Shop giao nhanh hơn dự kiến, hộp cẩn thận có lót chống sốc.',
  'Đóng gói chắc chắn, hàng đến tay còn nguyên vẹn.',
  'Shop tư vấn nhiệt tình, trả lời tin nhắn rất nhanh.',
  'Nhận hàng sau hai ngày, shipper gọi trước khi giao rất lịch sự.',
  'Đóng hộp gọn gàng, có kèm thiệp cảm ơn dễ thương.',
  'Giao hỏa tốc trong ngày, đúng lúc mình đang cần.',
  'Shop hỗ trợ nhanh, hỏi gì cũng giải đáp tận tình.',
  'Hàng được kiểm tra kỹ trước khi gửi, nhận về không có lỗi gì.',
  'Gói hàng cẩn thận, tem niêm phong còn nguyên.',
] as const;

const GEN_POS = [
  'Sản phẩm đúng như mô tả, giá hợp lý, sẽ ủng hộ shop tiếp.',
  'Chất lượng tốt hơn mong đợi so với tầm giá.',
  'Mua lần hai rồi, chất lượng vẫn ổn định, rất tin tưởng shop.',
  'Hài lòng, sẽ giới thiệu cho bạn bè.',
  'Rất ưng, đáng tiền, 5 sao cho shop.',
  'Hàng đẹp y như hình, không có gì để chê.',
  'Dùng thích lắm, giá này quá hợp lý.',
  'Mình mua theo review và không thất vọng, chất lượng đúng như mọi người nói.',
  'Hàng chính hãng, tem mác đầy đủ, yên tâm mua lại.',
  'Mua tặng người thân, họ rất thích, cảm ơn shop nhiều.',
  'Đáng đồng tiền bát gạo, sẽ quay lại mua thêm.',
  'Shop uy tín, hàng chuẩn, sẽ mua tiếp.',
] as const;

const GEN_MID = [
  'Tạm ổn so với giá tiền, chưa có gì đặc biệt.',
  'Nhìn chung dùng được, nhưng chưa được như kỳ vọng ban đầu.',
  'Bình thường, đúng giá tiền, ai cần thì mua được.',
  'Hàng đúng mô tả nhưng chất lượng ở mức trung bình.',
  'Giao hơi lâu nhưng sản phẩm ok, nên mình chấm 3 sao.',
  'Dùng tạm được, nếu giá rẻ hơn chút nữa thì mình đã cho 4 sao.',
  'Không tệ nhưng cũng không quá nổi bật, có thể cân nhắc.',
  'Cũng được, nhưng đóng gói hơi sơ sài, mong shop cải thiện.',
] as const;

const SHIP_MID = [
  'Giao hơi lâu (4 ngày) nhưng sản phẩm ok.',
  'Shop giao chậm hơn dự kiến một ngày, hàng thì ổn.',
  'Đóng gói hơi sơ sài, may là hàng không bị sao.',
  'Hộp ngoài hơi móp nhẹ, bên trong vẫn nguyên vẹn.',
  'Phải nhắn shop hai lần mới được phản hồi, nhưng cuối cùng xử lý ổn.',
] as const;

const GEN_NEG = [
  'Giao chậm hơn hẹn gần một tuần, gọi hỏi mới biết hàng bị kẹt kho.',
  'Hàng không giống hình quảng cáo, chất lượng kém hơn nhiều so với giá.',
  'Đóng gói ẩu, hộp bị móp, bên trong không có chèn xốp gì cả.',
  'Nhắn tin hỏi shop mãi không ai trả lời, hỗ trợ sau bán hàng rất kém.',
  'Thất vọng vì chất lượng, không đáng với số tiền bỏ ra.',
  'Nhận hàng thấy thiếu phụ kiện kèm theo, phải nhắn qua lại nhiều lần mới được bù.',
  'Hàng có lỗi ngay lần đầu sử dụng, đang chờ shop xử lý đổi trả.',
  'Màu sắc và kích cỡ khác mô tả, đổi trả thì quá nhiêu khê.',
  'Mô tả một đằng hàng nhận một nẻo, mình rất tiếc.',
  'Giao nhầm mẫu so với đơn đặt, shop phải gửi lại nên mất thêm cả tuần.',
] as const;

const SHIP_NEG = [
  'Shipper giao hàng lúc nửa đêm, không gọi trước, hộp ướt hết một góc.',
  'Đặt từ đầu tuần mà gần 8 ngày sau mới nhận được, trễ hơn ngày hứa nhiều.',
  'Bưu kiện bị bóc ra rồi dán lại, nghi bị mất một phần đồ bên trong.',
  'Đơn vị vận chuyển để hàng ngoài trời mưa, hộp ướt nhẹp, may mà đồ bên trong còn bọc nilon.',
  'Hàng đến tay thì hộp rách, phải đòi hãng vận chuyển bồi thường.',
  'Shop báo giao 2 ngày nhưng tận 6 ngày mới nhận, không báo gì cả.',
] as const;

const NEG_STRONG = [
  'Rất thất vọng, không bao giờ mua lại.',
  'Không nên mua, mọi người cân nhắc kỹ trước khi đặt.',
  'Tiền mất tật mang, mua về chỉ để cất đó.',
  'Quá tệ so với kỳ vọng, hy vọng shop xử lý thỏa đáng.',
  'Trải nghiệm tồi tệ, mình đã yêu cầu hoàn tiền.',
  'Cho 1 sao vì không có lựa chọn nào thấp hơn.',
] as const;

const NEG_SOFT = [
  'Hy vọng shop kiểm hàng kỹ hơn để khách đỡ phiền.',
  'Mong shop cải thiện chất lượng ở những lô sau.',
  'Cho 2 sao vì shop còn hỗ trợ đổi trả, chứ sản phẩm thì chưa ổn.',
  'Nếu khắc phục được thì mình sẽ cân nhắc mua lại.',
  'Tạm chấp nhận được, nhưng chắc chắn không phải lựa chọn đáng tiền.',
] as const;

/* Nhận xét ngắn 1 câu — dùng hiếm (~10% ở 4–5★) cho giống người mua gõ nhanh */
const SHORT_POS = ['Hàng đẹp, giao nhanh.', 'Rất tốt, đáng mua.', 'Chất lượng tốt, sẽ mua lại.', 'Ok, đúng mô tả.', 'Hài lòng với sản phẩm.', 'Shop đóng gói cẩn thận, hàng đẹp.'] as const;
const EMOJI_POS = [' 👍', ' ❤️', ' 😍', ' :)', ' ^^'] as const;
const EMOJI_NEG = [' :(', ' 😔', ' 😞'] as const;

const CORPUS_CHUNG: Corpus = { pos: GEN_POS, mid: GEN_MID, neg: GEN_NEG };

/* Ghép nội dung 1–2 mảnh theo điểm; mọi nhánh đều rút từ PRNG của dòng đơn nên tất định. */
function compose(rng: Rng, c: Corpus, rating: number): string {
  let parts: string[];
  const r = rng();
  if (rating >= 5 || rating === 4) {
    if (rating === 5 && r < 0.1) parts = [pick(rng, SHORT_POS)];
    else if (rating === 4) {
      const rr = rng();
      if (rr < 0.4) parts = [pick(rng, c.mid)];
      else if (rr < 0.75) parts = [pick(rng, c.pos), pick(rng, c.mid)];
      else parts = [pick(rng, c.pos), pick(rng, SHIP_POS)];
    } else {
      const main = pick(rng, c.pos);
      const rr = rng();
      if (rr < 0.3) parts = [main];
      else if (rr < 0.55) parts = [main, pick(rng, SHIP_POS)];
      else if (rr < 0.75) parts = [main, pick(rng, GEN_POS)];
      else if (rr < 0.87) parts = [pick(rng, SHIP_POS), main];
      else parts = [main, pickOther(rng, c.pos, main)];
    }
  } else if (rating === 3) {
    if (r < 0.5) parts = [pick(rng, c.mid)];
    else if (r < 0.8) parts = [pick(rng, c.mid), pick(rng, GEN_MID)];
    else parts = [pick(rng, c.mid), pick(rng, SHIP_MID)];
  } else if (rating === 2) {
    if (r < 0.15) parts = [pick(rng, SHIP_NEG), pick(rng, c.mid)];
    else if (r < 0.55) parts = [pick(rng, c.neg)];
    else if (r < 0.85) parts = [pick(rng, c.neg), pick(rng, NEG_SOFT)];
    else parts = [pick(rng, GEN_NEG), pick(rng, NEG_SOFT)];
  } else if (r < 0.15) parts = [pick(rng, SHIP_NEG), pick(rng, NEG_STRONG)];
  else if (r < 0.6) parts = [pick(rng, c.neg), pick(rng, NEG_STRONG)];
  else if (r < 0.85) parts = [pick(rng, c.neg), pick(rng, GEN_NEG)];
  else parts = [pick(rng, c.neg)];

  let text = parts.join(' ');
  if (chance(rng, 0.08)) text = text.replace(/\.$/, ''); // người gõ nhanh hay bỏ dấu chấm cuối
  if (rating >= 4 && chance(rng, 0.12)) text += pick(rng, EMOJI_POS);
  else if (rating <= 2 && chance(rng, 0.08)) text += pick(rng, EMOJI_NEG);
  return text.slice(0, MAX_CONTENT);
}

/* Tránh trùng nguyên văn trong cả lần chạy: thử lại vài lần, hết lượt thì chấp nhận bản cuối. */
function composeUnique(rng: Rng, c: Corpus, rating: number, used: Set<string>): string {
  let text = compose(rng, c, rating);
  for (let attempt = 0; attempt < 8 && used.has(text); attempt += 1) text = compose(rng, c, rating);
  used.add(text);
  return text;
}

/* Đánh giá vi phạm để demo kiểm duyệt: bị ẩn + nhãn đề xuất AI (ai.moderation_flags). */
interface Violation {
  rating: number;
  content: string;
  label: 'spam' | 'toxic' | 'off_topic';
  score: string;
  reason: string;
  note: string;
}
const VIOLATIONS: readonly Violation[] = [
  { rating: 1, content: 'Hàng như rác, shop lừa đảo!!! Ai muốn mua hàng thật giá rẻ hơn thì inbox zalo 09xx.xxx.xxx, mình bán rẻ hơn nhiều.', label: 'spam', score: '0.870', reason: 'Có lời mời liên hệ ngoài sàn (zalo), dẫn khách mua nơi khác', note: 'Ẩn: chèn thông tin liên hệ ngoài sàn để quảng cáo' },
  { rating: 5, content: 'Sản phẩm tốt. Bạn nào cần mua sỉ số lượng lớn giá rẻ nhất thị trường liên hệ ngay mình qua telegram nhé, ib mình giảm thêm 20%.', label: 'spam', score: '0.910', reason: 'Quảng cáo mua sỉ, mời liên hệ ngoài sàn', note: 'Ẩn: quảng cáo, chèo kéo khách ngoài sàn' },
  { rating: 1, content: 'Mua ở đây làm gì cho phí tiền, qua shop khác rẻ và tốt hơn nhiều: https://bit.ly/xxxxxx', label: 'spam', score: '0.930', reason: 'Chứa đường link dẫn sang nơi bán khác', note: 'Ẩn: chứa link ngoài sàn' },
  { rating: 1, content: 'Shop lừa đảo, nhân viên thô lỗ vô học, hàng như cc. Đừng ai dại mua!', label: 'toxic', score: '0.840', reason: 'Có từ ngữ thô tục, xúc phạm', note: 'Ẩn: ngôn từ thô tục, xúc phạm người bán' },
  { rating: 1, content: 'Đơn vị vận chuyển giao hàng quá tệ, shipper cộc cằn quát khách. Không liên quan shop nhưng mình đánh 1 sao cho bõ tức.', label: 'off_topic', score: '0.710', reason: 'Phản ánh đơn vị vận chuyển, không đánh giá sản phẩm', note: 'Ẩn: nội dung không liên quan đến sản phẩm' },
  { rating: 5, content: 'ok ok ok ok ok ok ok ok ok ok ok ok', label: 'spam', score: '0.760', reason: 'Nội dung lặp vô nghĩa nhằm lấy điểm', note: 'Ẩn: nội dung vô nghĩa, lặp lại' },
  { rating: 5, content: 'Chưa nhận được hàng nhưng cứ đánh giá 5 sao trước để nhận xu, shop nhớ giao nhanh nhé.', label: 'off_topic', score: '0.640', reason: 'Đánh giá khi chưa nhận/dùng sản phẩm', note: 'Ẩn: đánh giá chưa dựa trên trải nghiệm thực tế' },
  { rating: 2, content: 'Mình đã khiếu nại nhưng shop không giải quyết, bạn nào bị giống mình thì gọi gấp số 09xx.xxx.xxx để cùng tố cáo. Mọi người cẩn thận.', label: 'spam', score: '0.690', reason: 'Có số điện thoại cá nhân, kêu gọi liên hệ ngoài sàn', note: 'Ẩn: chứa số điện thoại cá nhân' },
];

// ---------------------------------------------------------------- lời shop trả lời
const REPLY_THANKS = [
  'Cảm ơn bạn {name} đã tin tưởng và ủng hộ shop! Chúc bạn dùng sản phẩm thật ưng ý. — {shop}',
  '{shop} cảm ơn bạn rất nhiều vì đánh giá đẹp ạ. Hẹn gặp lại bạn ở những đơn hàng sau nhé!',
  'Cảm ơn {name} đã dành thời gian đánh giá. Shop sẽ luôn cố gắng giữ chất lượng như thế này. Thân, {shop}',
  'Shop rất vui khi bạn hài lòng! Có gì cần hỗ trợ thêm, bạn cứ nhắn tin cho {shop} bất cứ lúc nào nhé.',
  'Cảm ơn bạn đã mua hàng và để lại nhận xét. Mong bạn tiếp tục đồng hành cùng {shop}!',
  'Cảm ơn {name}! Những lời nhận xét của bạn là động lực để {shop} làm việc tốt hơn mỗi ngày. Chúc bạn nhiều niềm vui!',
  'Dạ cảm ơn bạn đã ủng hộ shop ạ. Nếu thấy ổn, bạn ghé lại {shop} xem thêm sản phẩm mới nhé. Trân trọng!',
  '{shop} xin cảm ơn bạn {name}. Đơn {code} đã giao thành công, chúc bạn sử dụng thật bền và tiện lợi!',
  'Cảm ơn bạn đã tin tưởng lựa chọn shop. Mọi thắc mắc trong quá trình sử dụng, bạn nhắn {shop} để được hỗ trợ ngay nhé.',
  'Shop cảm ơn bạn nhiều lắm! Chúc {name} luôn nhiều niềm vui và sức khỏe. Thân mến, {shop}',
] as const;

const REPLY_FOUR = [
  'Cảm ơn {name} đã góp ý. {shop} sẽ lưu ý để lần sau phục vụ bạn tốt hơn. Rất mong được gặp lại bạn!',
  'Shop cảm ơn bạn đã ủng hộ và chia sẻ trải nghiệm. {shop} sẽ tiếp tục cải thiện những điểm bạn góp ý nhé!',
  'Cảm ơn bạn {name}! Những góp ý nhỏ của bạn giúp {shop} hoàn thiện hơn từng ngày. Chúc bạn dùng sản phẩm thật vui.',
] as const;

const REPLY_MID = [
  'Cảm ơn bạn {name} đã góp ý chân thành. {shop} sẽ ghi nhận để cải thiện chất lượng và dịch vụ. Nếu cần hỗ trợ đơn {code}, bạn nhắn shop nhé.',
  '{shop} cảm ơn phản hồi của bạn. Rất tiếc sản phẩm chưa hoàn toàn như kỳ vọng — bạn liên hệ shop kèm mã đơn {code} để được tư vấn hướng xử lý phù hợp nhé.',
  'Cảm ơn bạn đã dành thời gian đánh giá. Shop sẽ rà soát lại khâu kiểm hàng và đóng gói để lần sau tốt hơn. Thân, {shop}',
  'Dạ shop xin ghi nhận ý kiến của bạn {name}. Nếu bạn còn băn khoăn về sản phẩm, {shop} luôn sẵn sàng hỗ trợ qua tin nhắn ạ.',
  'Cảm ơn bạn {name}. {shop} rất mong có cơ hội phục vụ bạn tốt hơn ở lần sau, bạn cần đổi trả cứ nhắn shop trong 7 ngày nhé.',
  'Shop cảm ơn góp ý của bạn và sẽ chuyển ngay cho bộ phận chất lượng. Có vấn đề gì với đơn {code}, bạn nhắn {shop} để được hỗ trợ nhé.',
] as const;

const REPLY_SORRY = [
  '{shop} thành thật xin lỗi bạn {name} vì trải nghiệm chưa tốt. Bạn vui lòng nhắn tin kèm mã đơn {code} và ảnh/video sản phẩm, shop sẽ đổi mới hoặc hoàn tiền trong 24 giờ.',
  'Shop rất tiếc và xin lỗi bạn vì sự bất tiện này. Đơn {code} sẽ được bộ phận CSKH liên hệ trong hôm nay để hỗ trợ đổi trả. — {shop}',
  'Xin lỗi bạn {name} nhiều ạ! {shop} đã ghi nhận phản ánh và làm việc lại với bộ phận kiểm hàng và đơn vị vận chuyển. Bạn gửi giúp shop thêm hình ảnh để được hỗ trợ nhanh nhất nhé.',
  'Cảm ơn bạn đã phản hồi thẳng thắn. {shop} xin lỗi vì lô hàng này chưa đạt chất lượng, shop sẵn sàng đổi sản phẩm khác hoặc hoàn tiền theo chính sách đổi trả, bạn nhắn shop giúp mình nhé.',
  'Dạ shop xin lỗi bạn {name} vì đã làm bạn chưa hài lòng. Mong bạn cho {shop} cơ hội khắc phục: nhắn tin kèm mã đơn {code}, shop xử lý ngay trong ngày ạ.',
  '{shop} rất tiếc về trải nghiệm của bạn. Shop sẽ kiểm tra lại toàn bộ lô hàng và hỗ trợ bạn đổi trả miễn phí cho đơn {code}. Chân thành xin lỗi bạn!',
  'Xin lỗi bạn {name}, đây là sơ suất của shop. {shop} sẽ gửi bù/đổi mới sản phẩm cho đơn {code}, bạn vui lòng để lại thông tin nhận hàng trong tin nhắn nhé.',
  'Shop thật sự xin lỗi vì sự cố này và đã nhắc nhở bộ phận đóng gói/vận chuyển. Bạn liên hệ {shop} để được hoàn tiền hoặc đổi hàng cho đơn {code} nhé. Mong được bạn thông cảm!',
] as const;

function composeReply(rng: Rng, rating: number, shopName: string, authorName: string, orderCode: string): string {
  const pool: readonly string[] = rating >= 5 ? REPLY_THANKS : rating === 4 ? [...REPLY_FOUR, ...REPLY_THANKS] : rating === 3 ? REPLY_MID : REPLY_SORRY;
  const given = authorName.trim().split(/\s+/).pop() ?? 'bạn';
  return pick(rng, pool).replaceAll('{name}', given).replaceAll('{shop}', shopName).replaceAll('{code}', orderCode);
}

// ---------------------------------------------------------------- điểm sao
function drawRating(rng: Rng, quality: Quality): number {
  const w = RATING_WEIGHTS[quality];
  const u = rng();
  let acc = 0;
  for (let i = 0; i < w.length; i += 1) {
    acc += w[i];
    if (u < acc) return 5 - i;
  }
  return 5;
}

/* "Độ tốt" cố định theo slug sản phẩm: 15% kém, 15% tốt, còn lại bình thường. */
function productQuality(slug: string): Quality {
  const u = mulberry32(hashString(`${SEED_KEY}|quality|${slug}`))();
  return u < 0.15 ? 'low' : u > 0.85 ? 'high' : 'normal';
}

function helpfulFor(rng: Rng, rating: number, hasText: boolean): number {
  if (!hasText) return 0;
  const u = rng();
  if (rating >= 4) return Math.floor(u ** 3 * 12);
  if (rating <= 2) return Math.floor(u ** 2 * 9);
  return Math.floor(u ** 3 * 5);
}

// ---------------------------------------------------------------- tính lại rating (như syncStats + ShopEventListeners)
async function recountRatings(prisma: PrismaClient): Promise<{ products: number; shops: number }> {
  const perProduct = await prisma.review.groupBy({ by: ['productId'], where: { status: 'approved', isDeleted: false }, _avg: { rating: true }, _sum: { rating: true }, _count: true });
  for (const part of chunked(perProduct, 100)) {
    await prisma.$transaction(
      part.map((a) =>
        prisma.product.updateMany({ where: { id: a.productId }, data: { avgRating: (Math.round((a._avg.rating ?? 0) * 100) / 100).toFixed(2), reviewCount: a._count } }),
      ),
    );
  }

  // Shop.ratingAvg = trung bình review approved của MỌI sản phẩm thuộc shop (gộp theo tổng điểm/số review).
  const productShop = new Map<string, string>();
  for (const part of chunked(perProduct.map((a) => a.productId), 500)) {
    const rows = await prisma.product.findMany({ where: { id: { in: part } }, select: { id: true, shopId: true } });
    for (const p of rows) productShop.set(p.id, p.shopId);
  }
  const perShop = new Map<string, { sum: number; count: number }>();
  for (const a of perProduct) {
    const shopId = productShop.get(a.productId);
    if (!shopId) continue;
    const cur = perShop.get(shopId) ?? { sum: 0, count: 0 };
    cur.sum += a._sum.rating ?? 0;
    cur.count += a._count;
    perShop.set(shopId, cur);
  }
  const shopEntries = [...perShop.entries()].filter(([, v]) => v.count > 0);
  for (const part of chunked(shopEntries, 100)) {
    await prisma.$transaction(part.map(([shopId, v]) => prisma.shop.updateMany({ where: { id: shopId }, data: { ratingAvg: (v.sum / v.count).toFixed(2) } })));
  }
  return { products: perProduct.length, shops: shopEntries.length };
}

// ---------------------------------------------------------------- seed
interface PlannedReview {
  review: Prisma.ReviewCreateManyInput;
  reply: Prisma.ReviewReplyCreateManyInput | null;
  flag: Prisma.ModerationFlagCreateManyInput | null;
  orderItemId: string;
  dept: DeptKey;
}

export async function seed(prisma: PrismaClient): Promise<void> {
  const orders = await prisma.order.findMany({
    where: { code: { startsWith: ORDER_PREFIX }, status: { in: ['completed', 'delivered'] }, isDeleted: false },
    orderBy: [{ createdAt: 'asc' }, { code: 'asc' }],
    include: { items: true },
  });
  if (orders.length === 0) {
    console.warn(`   ! chưa có đơn ${ORDER_PREFIX}* đã giao/hoàn tất — chạy activity.seed trước; bỏ qua đánh giá sàn`);
    return;
  }

  // Dữ liệu tra cứu: khách, shop, sản phẩm → ngành gốc, người kiểm duyệt.
  const userIds = [...new Set(orders.map((o) => o.userId))];
  const users = new Map<string, { fullName: string; avatarUrl: string | null }>();
  for (const part of chunked(userIds, 500)) {
    for (const u of await prisma.user.findMany({ where: { id: { in: part } }, select: { id: true, fullName: true, avatarUrl: true } })) users.set(u.id, u);
  }
  const shopIds = [...new Set(orders.flatMap((o) => o.items.map((i) => i.shopId)))];
  const shops = new Map((await prisma.shop.findMany({ where: { id: { in: shopIds } }, select: { id: true, name: true, ownerUserId: true } })).map((s) => [s.id, s]));
  const productIds = [...new Set(orders.flatMap((o) => o.items.map((i) => i.productId)))];
  const categories = new Map((await prisma.category.findMany({ select: { id: true, slug: true, parentId: true } })).map((c) => [c.id, c]));
  const rootSlugOf = (categoryId: string): string | undefined => {
    let cur = categories.get(categoryId);
    for (let depth = 0; cur && depth < 6; depth += 1) {
      const parent: typeof cur | undefined = cur.parentId ? categories.get(cur.parentId) : undefined;
      if (!parent) return cur.slug;
      cur = parent;
    }
    return cur?.slug;
  };
  const deptOfProduct = new Map<string, { dept: DeptKey; leaf: string }>();
  for (const part of chunked(productIds, 500)) {
    for (const p of await prisma.product.findMany({ where: { id: { in: part } }, select: { id: true, categoryId: true, categorySlug: true } })) {
      const root = rootSlugOf(p.categoryId) ?? p.categorySlug;
      const dept: DeptKey = (MARKETPLACE_ROOTS as readonly string[]).includes(root) ? (root as DeptKey) : FASHION_ROOTS.has(root) ? 'thoi-trang' : 'chung';
      deptOfProduct.set(p.id, { dept, leaf: p.categorySlug });
    }
  }
  const moderators = await prisma.user.findMany({ where: { email: { in: ['sales@ecofashion.vn', 'admin@ecofashion.vn'] }, isDeleted: false }, select: { id: true, email: true } });
  const moderatorId = (moderators.find((m) => m.email === 'sales@ecofashion.vn') ?? moderators[0])?.id ?? null;

  // Review đã có của các khách này (mọi đơn): bỏ qua dòng đã đánh giá, mỗi (khách, sản phẩm) chỉ một review, tránh trùng nội dung.
  const existing = await prisma.review.findMany({ where: { userId: { in: userIds } }, select: { orderItemId: true, userId: true, productId: true, content: true } });
  const existingItems = new Set(existing.flatMap((r) => (r.orderItemId ? [r.orderItemId] : [])));
  const reviewedPairs = new Set(existing.map((r) => `${r.userId}|${r.productId}`));
  const usedContents = new Set(existing.map((r) => r.content));

  // Sửa cờ reviewed cho dòng đơn đã có review mà cờ chưa bật (lần chạy dở trước đó).
  const fixIds = orders.flatMap((o) => o.items.filter((i) => existingItems.has(i.id) && !i.reviewed).map((i) => i.id));
  for (const part of chunked(fixIds, 500)) await prisma.orderItem.updateMany({ where: { id: { in: part } }, data: { reviewed: true } });

  // Dòng đã bị yêu cầu đổi trả (chưa bị từ chối) thì khách không viết đánh giá khen/chê như đơn bình thường.
  const returnedItems = await prisma.returnRequestItem.findMany({ where: { request: { orderId: { in: orders.map((o) => o.id) }, status: { not: 'rejected' } } }, select: { orderItemId: true } });
  const returnedItemIds = new Set(returnedItems.map((r) => r.orderItemId));

  // ---- Lập kế hoạch (thuần bộ nhớ, tất định) ----
  const nowMs = Date.now();
  const capMs = nowMs - HOUR; // review/trả lời không vượt hiện tại
  const planned: PlannedReview[] = [];
  let alreadyReviewed = 0;
  let skippedPair = 0;
  let skippedTooRecent = 0;
  let skippedReturned = 0;

  for (const o of orders) {
    const baseMs = (o.status === 'completed' ? (o.completedAt ?? o.deliveredAt ?? o.updatedAt) : (o.deliveredAt ?? o.updatedAt)).getTime();
    const user = users.get(o.userId);
    for (const item of o.items) {
      if (existingItems.has(item.id)) {
        alreadyReviewed += 1;
        continue;
      }
      if (returnedItemIds.has(item.id)) {
        skippedReturned += 1;
        continue;
      }
      const rng = mulberry32(hashString(`${SEED_KEY}|${o.code}|${item.slug}|${item.sku}`));
      if (rng() >= (o.status === 'completed' ? RATE_COMPLETED : RATE_DELIVERED)) continue;
      const pairKey = `${o.userId}|${item.productId}`;
      if (reviewedPairs.has(pairKey)) {
        skippedPair += 1;
        continue;
      }
      if (baseMs >= capMs) {
        skippedTooRecent += 1;
        continue;
      }

      // Ngày review = mốc giao/hoàn tất + 1–10 ngày (kẹp trong (mốc, hiện tại - 1h]).
      let createdMs = baseMs + (1 + Math.floor(rng() * 10)) * DAY + Math.floor(rng() * 14 * HOUR);
      if (createdMs > capMs) createdMs = baseMs + Math.floor((capMs - baseMs) * (0.35 + 0.6 * rng()));
      const createdAt = new Date(createdMs);

      const { dept, leaf } = deptOfProduct.get(item.productId) ?? { dept: 'chung' as const, leaf: '' };
      const corpus = corpusFor(dept, leaf);
      const shop = shops.get(item.shopId);
      const authorName = (user?.fullName ?? 'Khách hàng').slice(0, 120);
      const variantLabel = [item.color, item.size].filter((s) => s.trim() !== '').join(' / ').slice(0, 160) || null;
      const id = randomUUID();
      const base = {
        id,
        productId: item.productId,
        productSlug: item.slug,
        productName: item.name,
        shopId: item.shopId,
        userId: o.userId,
        authorName,
        avatarUrl: user?.avatarUrl ?? null,
        orderCode: o.code,
        orderItemId: item.id,
        variantLabel,
        media: [],
        createdAt,
        updatedAt: createdAt,
      } satisfies Partial<Prisma.ReviewCreateManyInput>;

      if (rng() < HIDDEN_RATE) {
        // Đánh giá vi phạm → ẩn kiểm duyệt kèm nhãn AI đề xuất; không có trả lời.
        const v = pick(rng, VIOLATIONS);
        const moderatedAt = new Date(Math.min(createdMs + 3 * HOUR + Math.floor(rng() * 2 * DAY), nowMs - 60_000));
        planned.push({
          review: { ...base, rating: v.rating, content: v.content, status: 'hidden', moderationNote: v.note, moderatedBy: moderatorId, moderatedAt, helpfulCount: 0 },
          reply: null,
          flag: { reviewId: id, label: v.label, score: v.score, reason: v.reason, model: 'rule', createdAt: new Date(Math.min(createdMs + HOUR, nowMs - 60_000)) },
          orderItemId: item.id,
          dept,
        });
        reviewedPairs.add(pairKey);
        continue;
      }

      const rating = drawRating(rng, productQuality(item.slug));
      const content = rng() < STAR_ONLY_RATE[rating] ? '' : composeUnique(rng, corpus, rating, usedContents);
      const helpfulCount = helpfulFor(rng, rating, content !== '');
      let reply: Prisma.ReviewReplyCreateManyInput | null = null;
      if (shop && rng() < (rating <= 3 ? REPLY_RATE_LOW : REPLY_RATE_HIGH)) {
        const replyMs = Math.min(createdMs + Math.floor(rng() * 4) * DAY + HOUR + Math.floor(rng() * 10 * HOUR), nowMs - 60_000);
        const repliedAt = new Date(Math.max(replyMs, createdMs + 5 * 60_000));
        reply = { reviewId: id, staffUserId: shop.ownerUserId, staffName: shop.name.slice(0, 120), authorKind: 'shop', content: composeReply(rng, rating, shop.name, authorName, o.code), createdAt: repliedAt, updatedAt: repliedAt };
      }
      planned.push({ review: { ...base, rating, content, status: 'approved', moderationNote: null, moderatedBy: null, moderatedAt: null, helpfulCount }, reply, flag: null, orderItemId: item.id, dept });
      reviewedPairs.add(pairKey);
    }
  }

  // ---- Ghi theo lô: review → trả lời → nhãn AI → cờ reviewed của dòng đơn (cùng một transaction mỗi lô) ----
  for (const part of chunked(planned, CHUNK)) {
    await prisma.$transaction(
      async (tx) => {
        await tx.review.createMany({ data: part.map((p) => p.review) });
        const replies = part.flatMap((p) => (p.reply ? [p.reply] : []));
        if (replies.length > 0) await tx.reviewReply.createMany({ data: replies });
        const flags = part.flatMap((p) => (p.flag ? [p.flag] : []));
        if (flags.length > 0) await tx.moderationFlag.createMany({ data: flags });
        await tx.orderItem.updateMany({ where: { id: { in: part.map((p) => p.orderItemId) } }, data: { reviewed: true } });
      },
      { timeout: 120_000 },
    );
  }

  // ---- Tính lại rating sản phẩm + gian hàng (luôn chạy, kể cả khi không có review mới) ----
  const recount = await recountRatings(prisma);

  // ---- Tổng kết (đọc lại từ DB để lần chạy lại vẫn ra số tổng) ----
  const where = { orderCode: { startsWith: ORDER_PREFIX }, isDeleted: false } as const;
  const [visible, hidden, starOnly, replied, dist] = await Promise.all([
    prisma.review.count({ where: { ...where, status: 'approved' } }),
    prisma.review.count({ where: { ...where, status: 'hidden' } }),
    prisma.review.count({ where: { ...where, status: 'approved', content: '' } }),
    prisma.reviewReply.count({ where: { review: { ...where, status: 'approved' } } }),
    prisma.review.groupBy({ by: ['rating'], where: { ...where, status: 'approved' }, _count: true }),
  ]);
  const byStar = new Map(dist.map((d) => [d.rating, d._count]));
  const pct = (n: number, total: number): string => (total > 0 ? `${((n * 100) / total).toFixed(0)}%` : '0%');
  const byDept = new Map<DeptKey, number>();
  for (const p of planned) byDept.set(p.dept, (byDept.get(p.dept) ?? 0) + 1);

  console.log(`   đánh giá sàn (${ORDER_PREFIX}*): tổng ${visible + hidden} (hiển thị ${visible}, ẩn kiểm duyệt ${hidden}) — tạo mới ${planned.length}, đã có sẵn ${alreadyReviewed}`);
  console.log(`   phân bố sao (hiển thị): ${[5, 4, 3, 2, 1].map((s) => `${s}★ ${byStar.get(s) ?? 0} (${pct(byStar.get(s) ?? 0, visible)})`).join(' · ')}`);
  console.log(`   chỉ có sao (không chữ): ${starOnly} (${pct(starOnly, visible)}) · có trả lời shop: ${replied} (${pct(replied, visible)})`);
  console.log(`   bỏ qua: trùng (khách, sản phẩm) ${skippedPair}, dòng đã đổi trả ${skippedReturned}, đơn quá mới chưa thể đánh giá ${skippedTooRecent}`);
  if (planned.length > 0) console.log(`   mới tạo theo ngành gốc: ${[...byDept.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  console.log(`   rating đã tính lại: ${recount.products} sản phẩm (avgRating/reviewCount), ${recount.shops} gian hàng (ratingAvg)`);
}
