/*
 * SEED nội dung cho sàn đa ngành hàng (PLAN-0017, D5) — bổ sung trên nền `system.seed.ts` / `ai.seed.ts` (KHÔNG sửa hai file đó):
 *   1. Banner: mỗi ngành gốc (data/dept) một banner `promo` trỏ tới trang ngành + 3 banner khuyến mãi chung `hero` (sortOrder tiếp nối banner cũ).
 *   2. FAQ: câu hỏi–đáp về sàn đa gian hàng/đa ngành (nhiều shop một đơn, voucher sàn/shop, PayOS/VNPay/COD, đổi trả, bảo hành, bán hàng…).
 *   3. Trang chính sách (bảng pages): người bán · hoa hồng & đối soát · đổi trả theo ngành hàng.
 *   4. Kho tri thức chatbot (ai.documents + ai.document_chunks): hướng dẫn mua sắm cho TỪNG ngành gốc + 4 tài liệu vận hành sàn
 *      + FAQ mới + 3 trang chính sách trên. Cắt đoạn sẵn bằng `chunkText` (không vector): worker nhúng khi có EF_OPENAI_API_KEY
 *      (status pending → ready), không có khoá thì tìm từ khoá — đúng cách `ai.seed.ts` đang làm.
 * Idempotent theo khoá tự nhiên: banner theo tiêu đề (ngành: hoặc theo link + vị trí), FAQ theo câu hỏi, trang theo slug,
 * tài liệu AI theo tiêu đề. Chạy lại không trùng và KHÔNG ghi đè phần quản trị đã sửa tay (chỉ đồng bộ ảnh banner).
 * Cần: `npm run seed:gen-images` đã sinh `assets/banners/*.jpg` (thiếu ảnh nào thì bỏ qua banner đó và báo trong log).
 */
import { loadEnv } from '../../src/config/env';
import type { Prisma, PrismaClient } from '../../src/generated/prisma/client';
import { chunkText } from '../../src/modules/ai/foundation/chunk';
import { DEPARTMENTS } from './data/dept';
import { SeedImages } from './lib/seed-images';

/* ================================================================== 1. BANNER */

/* Banner cũ (system.seed.ts): hero sortOrder 1–3, promo sortOrder 1 ⇒ banner mới nối tiếp: hero từ 4, promo từ 2. */
const FIRST_HERO_ORDER = 4;
const FIRST_PROMO_ORDER = 2;

interface BannerDef {
  title: string;
  subtitle: string;
  image: string;
  linkUrl: string;
  position: 'hero' | 'promo';
  sortOrder: number;
  /* true: ngoài tiêu đề, nhận diện thêm theo (link + vị trí) để khỏi tạo trùng khi quản trị đã đổi tiêu đề */
  matchByLink: boolean;
}

/* Banner khuyến mãi chung — thứ tự khớp ảnh `banners/home-N.jpg` do export-image-manifest.ts xuất. */
const HOME_BANNERS: Array<{ title: string; subtitle: string; linkUrl: string }> = [
  { title: 'Sàn FITLY — mua sắm đa ngành', subtitle: `Thời trang và ${DEPARTMENTS.length} ngành hàng khác từ nhiều gian hàng — một giỏ hàng, giao tận nơi`, linkUrl: '/products' },
  { title: 'Freeship toàn quốc', subtitle: 'Miễn phí vận chuyển cho đơn từ 500.000₫ của mỗi gian hàng — mua đủ, giao tận cửa', linkUrl: '/shipping' },
  { title: 'Voucher của từng gian hàng', subtitle: 'Săn mã riêng của mỗi shop và dùng kèm 1 mã giảm giá của sàn — tiết kiệm nhân đôi', linkUrl: '/products?sale=1' },
];

/* Tiêu đề/phụ đề banner theo ngành gốc (key = slug ngành). Ngành mới chưa khai ở đây thì dùng bản dự phòng từ tên + mô tả ngành. */
const DEPT_BANNER: Record<string, { title: string; subtitle: string }> = {
  'dien-thoai-phu-kien': { title: 'Điện thoại & Phụ kiện — chính hãng, bảo hành toàn quốc', subtitle: 'Smartphone mới về, ốp lưng, cáp sạc, sạc dự phòng, tai nghe — nhiều gian hàng, giá tốt mỗi ngày' },
  'may-tinh-thiet-bi-dien-tu': { title: 'Laptop & Thiết bị điện tử — nâng cấp góc làm việc', subtitle: 'Laptop, màn hình, chuột bàn phím, loa tai nghe — so giá nhiều gian hàng, bảo hành rõ ràng' },
  'nha-cua-doi-song': { title: 'Nhà cửa & Đời sống — tổ ấm tiện nghi hơn', subtitle: 'Nồi chiên, máy xay, robot hút bụi, nội thất và chăn ga gối nệm cho căn nhà của bạn' },
  'sac-dep-suc-khoe': { title: 'Sắc đẹp & Sức khoẻ — toả sáng mỗi ngày', subtitle: 'Chăm sóc da, trang điểm, chăm sóc tóc, nước hoa và thực phẩm chức năng từ các gian hàng chọn lọc' },
  'giay-dep-tui-xach': { title: 'Giày dép & Túi xách — bước đi tự tin', subtitle: 'Sneaker, sandal, túi xách, balo, vali — đổi size nhanh trong 7 ngày nếu không vừa' },
  'dong-ho-phu-kien': { title: 'Đồng hồ & Phụ kiện — điểm nhấn cho phong cách', subtitle: 'Đồng hồ nam nữ, kính mắt, trang sức bạc — chọn gian hàng uy tín, xem rõ chế độ bảo hành' },
  'the-thao-da-ngoai': { title: 'Thể thao & Dã ngoại — khoẻ hơn, vui hơn', subtitle: 'Dụng cụ gym, yoga, xe đạp, lều và đồ cắm trại — sẵn sàng cho mọi cuối tuần' },
  'me-be': { title: 'Mẹ & Bé — yêu thương trọn vẹn', subtitle: 'Sữa, tã, đồ chơi an toàn, xe đẩy, quần áo trẻ em — xem kỹ hạn dùng và độ tuổi phù hợp' },
  'sach-van-phong-pham': { title: 'Sách & Văn phòng phẩm — đọc nhiều, học giỏi', subtitle: 'Sách văn học, kỹ năng, thiếu nhi, bút vở và dụng cụ học tập cho cả nhà' },
  'thuc-pham-do-uong': { title: 'Thực phẩm & Đồ uống — ngon chuẩn vị Việt', subtitle: 'Đặc sản ba miền, cà phê, trà, các loại hạt và đồ ăn vặt — nguồn gốc rõ ràng, giao tận nhà' },
  'thu-cung': { title: 'Thú cưng — chăm bé bốn chân đúng cách', subtitle: 'Thức ăn, đồ chơi, cát vệ sinh và phụ kiện cho chó mèo — chọn đúng độ tuổi và kích cỡ' },
  'o-to-xe-may': { title: 'Ô tô & Xe máy — an toàn trên mọi hành trình', subtitle: 'Mũ bảo hiểm, phụ kiện, dầu nhớt, đồ chăm sóc xe — kiểm tra tương thích trước khi mua' },
};

function buildBanners(): BannerDef[] {
  const out: BannerDef[] = HOME_BANNERS.map((b, i) => ({
    title: b.title, subtitle: b.subtitle, image: `banners/home-${i + 1}.jpg`, linkUrl: b.linkUrl, position: 'hero' as const, sortOrder: FIRST_HERO_ORDER + i, matchByLink: false,
  }));
  for (const [i, d] of DEPARTMENTS.entries()) {
    const copy = DEPT_BANNER[d.slug] ?? { title: `${d.name} — giá tốt mỗi ngày`, subtitle: d.description };
    // Bộ lọc `category` của /products khớp đúng slug ngành LÁ (không gộp con của ngành gốc) ⇒ trỏ vào ngành lá đầu tiên, giống dải ngành ở FE.
    const leaf = d.categories[0]?.slug;
    out.push({
      title: copy.title.slice(0, 200), subtitle: copy.subtitle.slice(0, 300), image: `banners/${d.slug}.jpg`,
      linkUrl: leaf ? `/products?category=${leaf}` : '/products', position: 'promo', sortOrder: FIRST_PROMO_ORDER + i, matchByLink: Boolean(leaf),
    });
  }
  return out;
}

async function seedBanners(prisma: PrismaClient, images: SeedImages): Promise<void> {
  const defs = buildBanners();
  let created = 0;
  let skipped = 0;
  for (const b of defs) {
    if (!images.has(b.image)) {
      skipped += 1;
      console.log(`   ! thiếu ảnh ${b.image} — bỏ qua banner "${b.title}" (chạy "npm run seed:gen-images" rồi seed lại)`);
      continue;
    }
    const img = await images.resolve(b.image);
    const or: Prisma.BannerWhereInput[] = [{ title: b.title }];
    if (b.matchByLink) or.push({ linkUrl: b.linkUrl, position: b.position });
    const exists = await prisma.banner.findFirst({ where: { isDeleted: false, OR: or }, select: { id: true, imageUrl: true, imagePublicId: true } });
    if (exists) {
      // Chỉ đồng bộ ảnh (vd đổi giữa Cloudinary và /static/seed) — không đụng chữ/link quản trị có thể đã sửa.
      if (exists.imageUrl !== img.url || exists.imagePublicId !== img.publicId) {
        await prisma.banner.update({ where: { id: exists.id }, data: { imageUrl: img.url, imagePublicId: img.publicId } });
      }
      continue;
    }
    await prisma.banner.create({
      data: { title: b.title, subtitle: b.subtitle, imageUrl: img.url, imagePublicId: img.publicId, linkUrl: b.linkUrl, position: b.position, sortOrder: b.sortOrder, isActive: true },
    });
    created += 1;
  }
  console.log(`   banner mới: ${defs.length} (${HOME_BANNERS.length} chung + ${DEPARTMENTS.length} theo ngành; tạo mới ${created}${skipped ? `, thiếu ảnh ${skipped}` : ''})`);
}

/* ================================================================== 2. FAQ */

/* groupCode dùng đúng 4 nhóm FE đang có nhãn (shipping · returns · payment · general); sortOrder từ 10 để không đụng 6 câu cũ. */
interface FaqDef {
  q: string;
  a: string;
  g: 'payment' | 'shipping' | 'returns' | 'general';
  o: number;
}

function buildFaqs(): FaqDef[] {
  const departmentNames = DEPARTMENTS.map((d) => d.name).join(', ');
  return [
    /* ---- Đặt hàng & thanh toán */
    { g: 'payment', o: 10, q: 'Một đơn hàng có mua được sản phẩm của nhiều gian hàng không?', a: 'Có. FITLY là sàn nhiều gian hàng nên bạn cứ thêm sản phẩm của bất kỳ shop nào vào cùng một giỏ. Khi thanh toán, giỏ được nhóm theo từng gian hàng và hệ thống tạo một đơn riêng cho mỗi shop; các đơn này thuộc cùng một lần đặt hàng, bạn xem và theo dõi tất cả tại Tài khoản → Đơn hàng của tôi.' },
    { g: 'payment', o: 11, q: 'Vì sao một lần đặt hàng lại tách thành nhiều đơn?', a: 'Mỗi gian hàng tự đóng gói, bàn giao cho đơn vị vận chuyển và chịu trách nhiệm về hàng của mình, nên sàn tách thành một đơn riêng cho từng shop. Mỗi đơn có mã, trạng thái, phí vận chuyển và tiến trình giao riêng (Chờ xác nhận → Đã xác nhận → Đang đóng gói → Đang giao → Đã giao). Việc huỷ hay đổi trả ở shop này không ảnh hưởng đến đơn của shop khác.' },
    { g: 'payment', o: 12, q: 'Mã giảm giá của sàn và mã giảm giá của gian hàng khác nhau thế nào?', a: 'Mã của sàn do FITLY phát hành, áp dụng được cho cả giỏ hàng gồm nhiều shop (ví dụ mã miễn phí vận chuyển hoặc giảm theo %). Mã của gian hàng do từng shop phát hành và chỉ áp dụng cho phần hàng của chính shop đó. Phần giảm của mã sàn do sàn chịu, phần giảm của mã shop do shop chịu; giá bạn thanh toán luôn là số đã trừ phần giảm hiển thị ở bước thanh toán.' },
    { g: 'payment', o: 13, q: 'Tôi có dùng nhiều mã giảm giá trong cùng một lần đặt hàng được không?', a: 'Được, nhưng có giới hạn: tối đa 1 mã của sàn cho cả lần đặt hàng, cộng với tối đa 1 mã của gian hàng cho mỗi shop có trong giỏ. Ví dụ giỏ có hàng của 3 shop, bạn dùng được 1 mã sàn và tối đa 3 mã shop (mỗi shop 1 mã). Mã thứ hai cùng loại hoặc cùng shop sẽ bị từ chối kèm lý do ngay ở bước thanh toán.' },
    { g: 'payment', o: 14, q: 'Mã giảm giá của shop A có dùng được cho sản phẩm của shop B không?', a: 'Không. Mã của gian hàng chỉ có hiệu lực với sản phẩm của đúng gian hàng đó. Nếu nhập mã của shop không có trong giỏ, hệ thống báo "Mã này dành cho gian hàng không có trong giỏ hàng của bạn". Bạn có thể thêm sản phẩm của shop đó vào giỏ để dùng mã, hoặc dùng mã của sàn cho toàn giỏ.' },
    { g: 'payment', o: 15, q: 'Mã giảm giá của sàn được chia về từng đơn của từng shop như thế nào?', a: 'Mã sàn được tính trên cả giỏ hàng rồi phân bổ về các đơn của từng shop theo tỉ lệ giá trị hàng (riêng mã miễn phí vận chuyển phân bổ theo phí ship của từng shop). Mỗi đơn hiển thị phần giảm của riêng nó và tổng các đơn luôn bằng đúng số tiền bạn phải trả. Một đơn không bao giờ được giảm quá giá trị hàng cộng phí vận chuyển của chính nó.' },
    { g: 'payment', o: 16, q: 'Thanh toán PayOS (QR/chuyển khoản tự động) hoạt động thế nào?', a: 'Chọn PayOS ở bước thanh toán, hệ thống tạo liên kết và mã QR cho đơn; bạn quét QR bằng ứng dụng ngân hàng hoặc mở liên kết để thanh toán. Khi tiền về, đơn được xác nhận tự động trong ít phút, không cần gửi ảnh chuyển khoản. Liên kết giữ chỗ 30 phút, quá hạn đơn chưa thanh toán sẽ tự huỷ và nhả tồn kho. Nếu không thấy PayOS ở bước thanh toán, phương thức này tạm chưa được bật — hãy chọn VNPay hoặc chuyển khoản.' },
    { g: 'payment', o: 17, q: 'Tôi đã bị trừ tiền qua VNPay/PayOS nhưng đơn vẫn chưa được xác nhận, phải làm sao?', a: 'Hãy chờ vài phút rồi tải lại trang Đơn hàng của tôi vì ngân hàng đôi khi xác nhận chậm. Nếu đơn vẫn ở trạng thái chưa thanh toán, bạn chụp màn hình giao dịch (có mã giao dịch, thời gian, số tiền) rồi gửi qua mục Liên hệ hoặc chat với trợ lý để gặp nhân viên. Bộ phận kế toán sẽ đối chiếu giao dịch và xác nhận đơn, hoặc hoàn tiền cho bạn nếu giao dịch không được ghi nhận.' },
    { g: 'payment', o: 18, q: 'Vì sao tôi không chọn được thanh toán khi nhận hàng (COD) cho một gian hàng?', a: 'Có hai nguyên nhân thường gặp. Thứ nhất, gian hàng đó đang tạm ngừng nhận COD: sàn tự khoá COD khi quỹ COD của shop hết số dư (không còn đủ để trừ hoa hồng); các đơn COD đang giao dở dang vẫn được giao bình thường. Thứ hai, đơn của shop đó vượt hạn mức COD (mặc định 5.000.000₫ mỗi đơn). Bạn có thể chọn VNPay, PayOS hoặc chuyển khoản, hoặc bỏ sản phẩm của shop đó khỏi giỏ để đặt phần còn lại bằng COD.' },
    { g: 'payment', o: 19, q: 'Giỏ hàng có nhiều shop và chọn COD thì tôi trả tiền như thế nào?', a: 'Mỗi shop giao hàng riêng nên bạn trả tiền mặt cho từng kiện khi nhận, đúng bằng tổng của đơn shop đó. Hạn mức COD cũng được kiểm theo từng đơn của từng shop chứ không cộng gộp cả giỏ, và mọi shop trong giỏ đều phải đang bật COD thì bạn mới chọn được phương thức này cho toàn bộ giỏ.' },
    { g: 'payment', o: 20, q: 'Quá hạn mà tôi chưa thanh toán online thì đơn hàng ra sao?', a: 'Đơn VNPay/PayOS chưa thanh toán sau 30 phút và đơn chuyển khoản chưa được xác nhận sau 24 giờ sẽ tự huỷ, số lượng hàng được nhả về kho. Bạn vẫn có thể đặt lại bình thường nếu hàng còn.' },

    /* ---- Vận chuyển */
    { g: 'shipping', o: 10, q: 'Phí vận chuyển khi mua của nhiều gian hàng được tính thế nào?', a: 'Phí vận chuyển tính riêng cho từng shop vì mỗi shop gửi một kiện hàng riêng. Mức phí theo bảng phí chung của sàn dựa trên tỉnh/thành nhận hàng (TP.HCM 20.000₫, miền Nam 30.000₫, miền Trung 35.000₫, miền Bắc 40.000₫). Ở bước thanh toán bạn thấy phí và tiền giảm của từng shop, cùng tổng cộng phải trả.' },
    { g: 'shipping', o: 11, q: 'Tôi mua hai shop, mỗi shop 300.000₫ thì có được miễn phí vận chuyển không?', a: 'Chưa. Ngưỡng miễn phí vận chuyển 500.000₫ được xét riêng theo giá trị hàng của từng shop, không cộng gộp cả giỏ, nên cả hai đơn vẫn tính phí. Bạn có thể mua thêm sản phẩm cùng shop cho đủ 500.000₫ hoặc dùng mã miễn phí vận chuyển của sàn nếu đang có.' },
    { g: 'shipping', o: 12, q: 'Vì sao các sản phẩm trong cùng lần đặt hàng về vào những ngày khác nhau?', a: 'Mỗi gian hàng tự xác nhận, đóng gói và bàn giao cho đơn vị vận chuyển, còn kho của các shop nằm ở những nơi khác nhau nên các kiện hàng về lần lượt chứ không cùng lúc. Bạn theo dõi trạng thái từng đơn ở mục Đơn hàng của tôi và nhận thông báo mỗi khi shop cập nhật.' },
    { g: 'shipping', o: 13, q: 'Hàng cồng kềnh như nội thất, đồ gia dụng lớn, xe đạp được giao thế nào?', a: 'Những món này được shop đóng gói và giao riêng, thời gian có thể lâu hơn hàng nhỏ và shop sẽ liên hệ để hẹn lịch nhận. Phí vận chuyển vẫn theo bảng phí chung của sàn theo tỉnh/thành. Khi nhận hãy kiểm tra kiện hàng trước mặt người giao và quay video lúc mở kiện; nếu móp méo, vỡ hoặc thiếu phụ kiện, bạn gửi yêu cầu đổi trả kèm video trong 7 ngày kể từ khi nhận.' },
    { g: 'shipping', o: 14, q: 'Hàng dễ vỡ, mỹ phẩm, thực phẩm được đóng gói và giao ra sao?', a: 'Shop có trách nhiệm đóng gói chống sốc, chống rò rỉ phù hợp từng loại hàng (xốp bọc, thùng cứng, túi hút chân không cho thực phẩm…). Khi nhận hàng bạn nên kiểm tra bao bì, tem niêm phong và hạn dùng; nếu hàng đổ vỡ, rò rỉ hoặc hư hỏng, hãy chụp ảnh/quay video mở kiện và gửi yêu cầu đổi trả để được hỗ trợ.' },

    /* ---- Đổi trả & bảo hành */
    { g: 'returns', o: 10, q: 'Chính sách đổi trả được áp dụng theo từng gian hàng hay cả lần đặt hàng?', a: 'Theo từng đơn của từng gian hàng. Bạn gửi yêu cầu đổi trả riêng cho đơn của shop có hàng cần đổi (Đơn hàng → chọn đơn → Đổi trả) trong 7 ngày kể từ khi nhận đơn đó, kèm ảnh/video minh chứng. Yêu cầu của đơn này không ảnh hưởng đến các đơn khác trong cùng lần đặt. Nhân viên hỗ trợ của sàn xem xét và hướng dẫn bạn đến khi hoàn tất.' },
    { g: 'returns', o: 11, q: 'Ai chịu phí vận chuyển khi đổi trả?', a: 'Nếu lỗi thuộc về gian hàng (giao sai hàng, hàng lỗi, hư hỏng khi nhận) thì shop chịu phí vận chuyển đổi trả. Các trường hợp còn lại áp dụng theo chính sách đổi trả của sàn và quy định riêng của shop ghi trên trang sản phẩm (nếu có). Bạn nên giữ nguyên tem mác, hộp và phụ kiện để quá trình đổi trả nhanh gọn.' },
    { g: 'returns', o: 12, q: 'Hàng điện tử có được bảo hành không và bảo hành ở đâu?', a: 'Điện thoại, máy tính, đồ điện gia dụng… được bảo hành theo phiếu bảo hành kèm theo hàng; thời hạn và nơi bảo hành do nhà sản xuất hoặc gian hàng quy định, ghi ở trang sản phẩm. Hãy giữ hộp, hoá đơn và phiếu bảo hành. Nếu máy lỗi kỹ thuật ngay khi nhận (trong 7 ngày) bạn gửi yêu cầu đổi trả để được đổi mới hoặc hoàn tiền; sau thời gian đó sẽ chuyển sang quy trình bảo hành.' },
    { g: 'returns', o: 13, q: 'Điện thoại, laptop đã mở hộp hoặc kích hoạt thì còn đổi trả được không?', a: 'Bạn nên quay video mở hộp liền mạch từ lúc cắt niêm phong. Nếu máy có lỗi kỹ thuật, thiếu phụ kiện hoặc giao sai mẫu, bạn vẫn được đổi trả trong 7 ngày kể từ khi nhận. Trường hợp đổi ý sau khi đã bóc niêm phong hoặc kích hoạt, máy rơi vỡ, vào nước thì không thuộc diện đổi trả, trừ khi gian hàng có chính sách riêng ghi trên trang sản phẩm.' },
    { g: 'returns', o: 14, q: 'Mỹ phẩm, thực phẩm có hạn dùng thì kiểm tra và đổi trả thế nào?', a: 'Khi nhận hàng hãy kiểm tra ngày sản xuất, hạn dùng, tem phụ tiếng Việt và niêm phong. Hàng hết hạn, cận date bất thường, bao bì rách/rò rỉ hoặc sai sản phẩm được đổi trả hay hoàn tiền trong 7 ngày kèm ảnh/video. Hàng đã mở nắp, dùng thử hoặc đã bóc bao bì thực phẩm thì không đổi trả trừ khi có lỗi chất lượng. Nếu mỹ phẩm gây kích ứng, hãy ngừng dùng và liên hệ shop; thực phẩm chức năng không thay thế thuốc, cần hỏi bác sĩ khi có bệnh lý.' },
    { g: 'returns', o: 15, q: 'Sản phẩm cho mẹ và bé, đồ dùng thú cưng có được đổi trả không?', a: 'Có khi hàng lỗi, giao sai hoặc hư hỏng khi nhận. Các mặt hàng tiếp xúc trực tiếp như sữa, tã, đồ ăn dặm, thức ăn thú cưng, đồ vệ sinh chỉ đổi khi còn nguyên bao bì, chưa mở và còn hạn dùng; đã mở gói hoặc đã dùng chỉ xử lý khi có lỗi chất lượng. Với đồ chơi, xe đẩy và phụ kiện, bạn kiểm tra độ tuổi/kích cỡ phù hợp và các chi tiết nhỏ ngay khi nhận để yêu cầu đổi nếu có vấn đề.' },
    { g: 'returns', o: 16, q: 'Đơn dùng mã giảm giá được hoàn tiền như thế nào?', a: 'Số tiền hoàn là số tiền thực tế bạn đã thanh toán cho đơn hoặc phần hàng được duyệt trả, nghĩa là đã trừ phần giảm giá của mã áp dụng. Tiền hoàn về phương thức thanh toán ban đầu (VNPay, PayOS) hoặc chuyển khoản cho đơn COD/chuyển khoản, trong 3–5 ngày làm việc sau khi shop nhận lại hàng và yêu cầu được duyệt.' },
    { g: 'returns', o: 17, q: 'Mua của nhiều shop, tôi nhận tiền hoàn ở đâu và khi nào?', a: 'Tiền hoàn được xử lý riêng cho từng đơn của từng shop, nên nếu trả hàng ở hai shop bạn có thể nhận hai khoản hoàn vào hai thời điểm khác nhau. Thời gian là 3–5 ngày làm việc kể từ khi yêu cầu được duyệt, về đúng phương thức bạn đã dùng để thanh toán.' },
    { g: 'returns', o: 18, q: 'Mũ bảo hiểm và phụ kiện ô tô, xe máy chọn thế nào để không phải đổi trả?', a: 'Với mũ bảo hiểm hãy đo vòng đầu và đối chiếu bảng size của shop, ưu tiên mũ có tem/nhãn hợp quy ghi rõ trên sản phẩm. Với phụ kiện, dầu nhớt, camera… kiểm tra kỹ tương thích với dòng xe và đời xe trước khi đặt. Hàng đã lắp lên xe hoặc đã sử dụng không được đổi trả trừ khi có lỗi từ nhà sản xuất; một số shop hỗ trợ lắp đặt tại cửa hàng nội thành, thông tin ghi trong mô tả sản phẩm.' },

    /* ---- Chung: sàn đa ngành, mua sắm an tâm, bán hàng */
    { g: 'general', o: 10, q: 'FITLY bán những ngành hàng nào?', a: `FITLY là sàn đa ngành hàng: ngoài thời trang nam nữ, bạn có thể mua ${departmentNames}. Mỗi ngành do nhiều gian hàng khác nhau cung cấp; hãy dùng thanh Danh mục hoặc ô tìm kiếm để vào đúng ngành.` },
    { g: 'general', o: 11, q: 'Làm sao phân biệt hàng của sàn với hàng của gian hàng khác, và biết shop có uy tín không?', a: 'Mỗi sản phẩm ghi rõ tên gian hàng bán. "FITLY Official" là gian hàng chính chủ của sàn, các shop còn lại là đối tác bán hàng và tự chịu trách nhiệm về hàng của mình. Để chọn shop uy tín, hãy xem điểm đánh giá trung bình, số sản phẩm và lượt bán, đọc đánh giá có ảnh của khách đã nhận hàng. Shop vi phạm (bán hàng giả, giao sai cam kết) sẽ bị sàn ẩn sản phẩm hoặc khoá gian hàng.' },
    { g: 'general', o: 12, q: 'Đơn của một gian hàng gặp vấn đề, tôi liên hệ ai?', a: 'Bạn liên hệ trực tiếp FITLY qua mục Liên hệ, hotline 1900 6868 hoặc email hotro@ecofashion.vn, kèm mã đơn của shop liên quan; bạn cũng có thể chat với trợ lý FITLY và chọn gặp nhân viên. Sàn đứng giữa làm việc với gian hàng để xử lý giao chậm, giao sai, hàng lỗi hoặc yêu cầu đổi trả.' },
    { g: 'general', o: 13, q: 'Tôi muốn bán hàng trên FITLY thì đăng ký như thế nào?', a: 'Hiện việc mở gian hàng do sàn tiếp nhận và xét duyệt hồ sơ. Bạn gửi thông tin qua mục Liên hệ (hoặc hotline 1900 6868, email hotro@ecofashion.vn) gồm: tên gian hàng, ngành hàng dự kiến, thông tin người liên hệ và tài khoản ngân hàng nhận tiền. Sau khi sàn duyệt, bạn nhận tài khoản chủ shop để đăng nhập cổng người bán, đăng sản phẩm, quản lý kho, đơn hàng, voucher và theo dõi đối soát. Gian hàng chỉ hiển thị với khách khi đã được duyệt.' },
    { g: 'general', o: 14, q: 'Bán hàng trên FITLY thì sàn thu những khoản phí nào?', a: 'Sàn thu hoa hồng theo phần trăm doanh thu của mỗi đơn thành công. Mức hoa hồng được ghi trên hồ sơ của từng gian hàng và thoả thuận khi duyệt shop; mức này được chốt vào đơn tại thời điểm khách đặt hàng nên điều chỉnh sau đó chỉ áp dụng cho đơn mới. Chi tiết xem trang Chính sách hoa hồng & đối soát.' },
    { g: 'general', o: 15, q: 'Người bán nhận tiền hàng khi nào?', a: 'Với đơn thanh toán online (VNPay, PayOS, chuyển khoản), sàn giữ tiền hộ và đối soát theo kỳ: chỉ tính các đơn đã qua hạn đổi trả (7 ngày kể từ khi giao), trừ hoa hồng và các khoản hoàn tiền cho khách rồi chuyển phần còn lại cho shop qua PayOS hoặc chuyển khoản. Với đơn COD, shop trực tiếp thu tiền mặt và hoa hồng được trừ vào ví quỹ COD khi đơn hoàn tất.' },
    { g: 'general', o: 16, q: 'Ai trả lời đánh giá của tôi về sản phẩm?', a: 'Chỉ khách đã nhận hàng mới đánh giá được. Gian hàng bán sản phẩm đó có thể trả lời đánh giá của bạn trong cổng người bán, còn sàn kiểm duyệt các đánh giá vi phạm (lăng mạ, quảng cáo, lộ thông tin cá nhân). Đánh giá chân thật giúp những khách khác chọn shop và sản phẩm tốt hơn.' },
  ];
}

async function seedFaqs(prisma: PrismaClient, faqs: FaqDef[]): Promise<void> {
  let created = 0;
  for (const f of faqs) {
    const exists = await prisma.faq.findFirst({ where: { question: f.q, isDeleted: false }, select: { id: true } });
    if (exists) continue;
    await prisma.faq.create({ data: { question: f.q, answer: f.a, groupCode: f.g, sortOrder: f.o, isActive: true } });
    created += 1;
  }
  const byGroup = (['payment', 'shipping', 'returns', 'general'] as const).map((g) => `${g} ${faqs.filter((f) => f.g === g).length}`).join(' · ');
  console.log(`   FAQ mới: ${faqs.length} (tạo mới ${created}) — ${byGroup}`);
}

/* ================================================================== 3. TRANG CHÍNH SÁCH
 * Mỗi mục "## …" viết liền với nội dung bên dưới (không dòng trống) để `chunkText` (cắt theo đoạn trống) giữ tiêu đề cùng thân khi
 * trang này được nạp vào kho tri thức chatbot. Số liệu khớp luật hiện hành: hạn đổi trả 7 ngày, ví COD ≤ 0 thì khoá COD, voucher
 * tối đa 1 sàn + 1 shop/đơn con, doanh thu tính hoa hồng = khách trả + phần voucher SÀN chịu (shop-payout.service.ts).
 */
const VENDOR_POLICY = `# Chính sách người bán (vendor)

Chính sách này áp dụng cho mọi gian hàng bán trên sàn FITLY. Khi đăng ký và vận hành gian hàng, người bán đồng ý tuân thủ các quy định dưới đây để bảo vệ quyền lợi của khách hàng và uy tín chung của sàn.

## 1. Đăng ký và xét duyệt
- Người bán gửi hồ sơ gồm tên gian hàng, ngành hàng dự kiến, thông tin người liên hệ và tài khoản ngân hàng nhận tiền.
- Sàn xét duyệt hồ sơ; gian hàng có thể ở trạng thái chờ duyệt, đã duyệt, bị từ chối hoặc bị khoá. Chỉ gian hàng đã duyệt mới hiển thị sản phẩm với khách.
- Thông tin ngân hàng phải chính xác và đúng tên chủ tài khoản; người bán chịu trách nhiệm nếu khai sai dẫn đến chuyển nhầm tiền.

## 2. Tài khoản và phân quyền
- Mỗi gian hàng có chủ shop và có thể mời thêm nhân viên. Gian hàng luôn phải còn ít nhất một chủ shop.
- Mỗi tài khoản chỉ xem và thao tác được dữ liệu của gian hàng mình. Không chia sẻ mật khẩu và hãy thu hồi quyền nhân viên khi họ nghỉ việc.

## 3. Đăng bán sản phẩm
- Sản phẩm được gắn vào danh mục do sàn quản lý và khai đủ thuộc tính theo ngành hàng (màu sắc, dung lượng, kích thước, hạn dùng…). Mỗi sản phẩm có tối đa hai trục biến thể.
- Hình ảnh, mô tả, giá và tồn kho phải trung thực, cập nhật kịp thời; mã SKU không được trùng trong cùng gian hàng.
- Nghiêm cấm bán hàng giả, hàng nhái, hàng vi phạm sở hữu trí tuệ, hàng cấm hoặc hàng kinh doanh có điều kiện khi chưa đủ giấy phép theo quy định pháp luật hiện hành.

## 4. Xử lý đơn hàng
- Xác nhận, đóng gói và bàn giao đơn nhanh chóng; cập nhật đúng trạng thái Chờ xác nhận, Đã xác nhận, Đang đóng gói, Đang giao, Đã giao. Đơn đã giao không có khiếu nại sau 7 ngày được tự động hoàn tất.
- Đóng gói phù hợp từng loại hàng; hàng dễ vỡ, chất lỏng và thực phẩm cần được bảo vệ kỹ và ghi rõ hạn dùng.
- Phí vận chuyển áp dụng theo bảng phí chung của sàn; người bán không tự thu thêm phí ngoài hệ thống.

## 5. Khuyến mãi
- Người bán tự tạo voucher cho riêng gian hàng mình; phần giảm giá của voucher shop do shop chịu. Mỗi đơn của shop dùng tối đa một voucher shop và có thể kết hợp với một voucher của sàn.

## 6. Đổi trả, bảo hành và đánh giá
- Hợp tác xử lý yêu cầu đổi trả trong hạn 7 ngày; lỗi do gian hàng thì shop chịu phí vận chuyển đổi trả. Với hàng điện tử, cung cấp phiếu bảo hành hợp lệ.
- Trả lời đánh giá của khách lịch sự, trung thực; không gây áp lực để khách xoá hay sửa đánh giá.

## 7. Xử lý vi phạm
Tuỳ mức độ, sàn có thể nhắc nhở, ẩn sản phẩm, tạm khoá nhận COD, trừ khoản hoàn tiền cho khách vào kỳ đối soát hoặc khoá gian hàng. Người bán có quyền khiếu nại qua email hotro@ecofashion.vn hoặc hotline 1900 6868.`;

const COMMISSION_POLICY = `# Chính sách hoa hồng & đối soát

Trang này mô tả cách FITLY tính hoa hồng, đối soát và chi trả tiền hàng cho gian hàng; người bán tra cứu số liệu trong cổng người bán (mục Đối soát và Ví quỹ COD).

## 1. Hoa hồng
- Hoa hồng là tỉ lệ phần trăm sàn thu trên doanh thu của mỗi đơn thành công. Tỉ lệ ghi trên hồ sơ gian hàng, do sàn và người bán thoả thuận khi duyệt shop.
- Tỉ lệ được chốt vào đơn tại thời điểm khách đặt hàng. Nếu sàn điều chỉnh sau đó, mức mới chỉ áp dụng cho các đơn đặt sau thời điểm điều chỉnh.

## 2. Voucher và bên chịu chi phí
- Voucher của sàn do sàn chịu: khách được giảm giá nhưng gian hàng vẫn nhận đủ doanh thu như chưa giảm. Hoa hồng tính trên số tiền khách trả cộng phần sàn giảm.
- Voucher của gian hàng do gian hàng chịu: phần giảm làm giảm doanh thu của shop, hoa hồng tính trên số tiền khách thực trả.
- Ví dụ (chưa tính phí vận chuyển): đơn 1.000.000₫, hoa hồng 8%. Với voucher sàn 50.000₫, khách trả 950.000₫, hoa hồng 80.000₫, shop nhận 920.000₫. Với voucher shop 50.000₫, khách trả 950.000₫, hoa hồng 76.000₫, shop nhận 874.000₫.

## 3. Hai dòng tiền: đơn online và đơn COD
- Đơn thanh toán online (VNPay, PayOS, chuyển khoản): sàn thu tiền của khách, giữ hộ và chi trả cho shop theo kỳ đối soát.
- Đơn COD: shop trực tiếp thu tiền mặt từ khách; hoa hồng của đơn được trừ vào ví quỹ COD khi đơn hoàn tất. Hai dòng tiền này tách bạch, hệ thống không tự bù trừ giữa chúng.

## 4. Đối soát theo kỳ
- Mỗi kỳ, sàn gom các đơn online đã qua hạn đổi trả (hiện là 7 ngày kể từ khi giao) và chưa nằm trong kỳ nào trước đó. Đơn chưa qua hạn được dồn sang kỳ kế tiếp, không bị mất.
- Thực nhận = doanh thu − hoa hồng − tiền đã hoàn cho khách − khoản nợ mang sang từ kỳ trước.
- Nếu thực nhận âm (hoàn tiền lớn hơn doanh thu), kỳ này không chi tiền và số âm được trừ vào kỳ kế tiếp. Nếu bằng 0, kỳ được ghi nhận là đã quyết toán.

## 5. Chi trả
- Khi sàn đã cấu hình cổng chi tiền PayOS và gian hàng đã khai tài khoản ngân hàng, tiền được chuyển tự động. Lệnh chi lỗi có thể chạy lại mà không chi trùng.
- Nếu chưa cấu hình hoặc thiếu thông tin ngân hàng, kỳ ở trạng thái chờ; kế toán sàn chuyển khoản thủ công rồi đánh dấu đã trả.

## 6. Ví quỹ COD
- Mỗi đơn COD hoàn tất trừ đúng một lần hoa hồng của đơn đó khỏi ví quỹ COD của gian hàng.
- Khi số dư ví về 0 hoặc âm, sàn tự khoá COD cho các đơn mới của shop; đơn đang giao dở không bị huỷ.
- Để mở lại COD, shop gửi yêu cầu nộp quỹ kèm chứng từ chuyển khoản; sau khi sàn duyệt, số tiền được cộng vào ví. COD chỉ mở lại khi số dư sau khi cộng lớn hơn 0.

## 7. Tra soát
Người bán có thể gửi thắc mắc về kỳ đối soát hoặc ví quỹ COD đến kế toán sàn qua email hotro@ecofashion.vn, kèm mã kỳ hoặc mã đơn liên quan.`;

const CATEGORY_RETURNS_POLICY = `# Chính sách đổi trả theo ngành hàng

Nguyên tắc chung của FITLY: khách được gửi yêu cầu đổi trả trong 7 ngày kể từ khi nhận hàng khi hàng lỗi, giao sai hoặc hư hỏng khi nhận, kèm ảnh/video minh chứng. Yêu cầu được xử lý riêng cho từng đơn của từng gian hàng. Mỗi ngành hàng có thêm điều kiện đặc thù dưới đây; gian hàng có thể công bố chính sách rộng hơn ở trang sản phẩm.

## Điều kiện chung
- Hàng còn nguyên tem mác, hộp, phụ kiện và quà tặng kèm; chưa qua sử dụng.
- Lỗi do gian hàng (giao sai, hàng lỗi, hư hỏng khi nhận) thì shop chịu phí vận chuyển đổi trả.
- Tiền hoàn về phương thức thanh toán ban đầu trong 3–5 ngày làm việc sau khi shop nhận lại hàng và yêu cầu được duyệt.

## Theo từng ngành hàng
### Công nghệ và gia dụng
- Điện thoại & Phụ kiện: máy còn đủ hộp, phụ kiện, số IMEI khớp; lỗi kỹ thuật được đổi mới hoặc hoàn tiền; rơi vỡ, vào nước hay đổi ý sau khi kích hoạt không thuộc diện đổi trả.
- Máy tính & Thiết bị điện tử: giữ nguyên niêm phong, số serial; lỗi phần cứng báo trong 7 ngày được đổi hoặc hoàn, sau đó chuyển bảo hành; không tự tháo máy.
- Nhà cửa & Đời sống: kiểm tra hàng cồng kềnh trước mặt người giao; chưa lắp đặt, chưa sử dụng; shop phối hợp thu hồi.

### Làm đẹp, mẹ bé và thú cưng
- Sắc đẹp & Sức khoẻ: còn niêm phong, chưa mở nắp; hết hạn, cận date, rò rỉ hoặc sai hàng được đổi trả.
- Mẹ & Bé: sữa, tã, đồ ăn dặm, đồ vệ sinh chỉ đổi khi còn nguyên bao bì và hạn dùng; đồ chơi, xe đẩy kiểm tra chi tiết nhỏ, phanh, khoá khi nhận.
- Thú cưng: thức ăn, cát vệ sinh còn nguyên bao, chưa mở; phụ kiện đúng kích cỡ, chưa sử dụng.

### Thời trang, giày túi và phụ kiện
- Thời trang: còn tem mác, chưa giặt, chưa chỉnh sửa; đổi size khi không vừa.
- Giày dép & Túi xách: thử trong nhà, đế sạch, chưa mang ra đường, còn hộp; túi chưa dùng, không dính mùi hay vết bẩn.
- Đồng hồ & Phụ kiện: còn tem, niêm phong, hộp và thẻ bảo hành; không trầy xước do sử dụng; kính đã cắt tròng theo toa riêng không đổi trả.

### Thể thao, sách, thực phẩm và xe cộ
- Thể thao & Dã ngoại: dụng cụ chưa sử dụng, còn bao bì; hàng lắp ráp kiểm tra khi nhận.
- Sách & Văn phòng phẩm: sách lỗi in, thiếu trang, rách bìa hoặc giao sai được đổi; văn phòng phẩm đã mở hay sử dụng không đổi trừ khi có lỗi.
- Thực phẩm & Đồ uống: kiểm tra hạn dùng, bao bì và quay video mở kiện; hết hạn, đổ vỡ, hư hỏng được đổi trả; đã bóc hay dùng chỉ xử lý khi có lỗi chất lượng.
- Ô tô & Xe máy: kiểm tra tương thích dòng xe trước khi lắp; hàng đã lắp hay đã sử dụng không đổi trừ lỗi nhà sản xuất; mũ bảo hiểm còn nguyên tem có thể đổi size.

## Cách gửi yêu cầu
Vào Tài khoản → Đơn hàng của tôi → chọn đơn đã giao → Đổi trả, mô tả vấn đề và đính kèm ảnh/video. Nhân viên hỗ trợ của sàn xem xét, hướng dẫn gửi hàng và hoàn tiền.`;

/* slug ≤ 60 ký tự (cột pages.slug VarChar(60)); không đụng 5 slug cũ about · shipping · returns-policy · privacy · terms */
const NEW_PAGES: Array<{ slug: string; title: string; content: string }> = [
  { slug: 'vendor-policy', title: 'Chính sách người bán (vendor)', content: VENDOR_POLICY },
  { slug: 'commission-policy', title: 'Chính sách hoa hồng & đối soát', content: COMMISSION_POLICY },
  { slug: 'category-returns-policy', title: 'Chính sách đổi trả theo ngành hàng', content: CATEGORY_RETURNS_POLICY },
];

async function seedPages(prisma: PrismaClient): Promise<void> {
  let created = 0;
  for (const p of NEW_PAGES) {
    const exists = await prisma.page.findUnique({ where: { slug: p.slug }, select: { slug: true } });
    if (exists) continue; // giữ nội dung quản trị đã sửa
    await prisma.page.create({ data: { slug: p.slug, title: p.title, content: p.content, isActive: true } });
    created += 1;
  }
  console.log(`   trang chính sách mới: ${NEW_PAGES.length} (tạo mới ${created}; giữ nội dung đã sửa)`);
}

/* ================================================================== 4. KHO TRI THỨC CHATBOT */

interface DocDef {
  title: string;
  kind: 'policy' | 'faq' | 'guide';
  content: string;
}

/* Hướng dẫn mua sắm theo ngành gốc: 3 mục (chọn mua · bảo quản/bảo hành · đổi trả đặc thù & an toàn). Không nêu thương hiệu thật,
   không viện dẫn số hiệu quy chuẩn/pháp lý; mọi mốc thời gian (7 ngày đổi trả) khớp chính sách sàn. */
const DEPT_GUIDE: Record<string, { choose: string; care: string; returns: string }> = {
  'dien-thoai-phu-kien': {
    choose: 'Bắt đầu từ nhu cầu chính: chụp ảnh, chơi game, pin dùng cả ngày hay chỉ cần máy gọn nhẹ giá tốt. So sánh bộ nhớ trong và RAM, kích thước và chất lượng màn hình, dung lượng pin cùng công suất sạc nhanh được hỗ trợ. Chọn đúng phiên bản (màu, dung lượng) ở phần biến thể trước khi thêm vào giỏ. Với phụ kiện, ốp lưng và kính cường lực phải đúng dòng máy; cáp sạc cần đúng chuẩn cổng và công suất; sạc dự phòng nên xem dung lượng thực tế và số cổng ra; tai nghe không dây cần xem thời lượng pin và độ trễ khi xem video.',
    care: 'Giữ hộp, hoá đơn và phiếu bảo hành vì bảo hành do nhà sản xuất hoặc gian hàng đảm nhận theo thời hạn ghi ở trang sản phẩm. Dùng củ sạc và cáp đạt chuẩn, tránh để máy ở nơi nóng như trong xe dưới nắng, không vừa sạc vừa chơi game nặng quá lâu. Cập nhật phần mềm đều đặn và sao lưu dữ liệu trước khi gửi bảo hành hay đổi máy.',
    returns: 'Khi nhận máy hãy quay video mở hộp liền mạch, kiểm tra ngoại hình, số IMEI trên hộp có khớp với máy không (bấm *#06# để xem) và đủ phụ kiện. Máy lỗi kỹ thuật, thiếu phụ kiện hoặc giao sai mẫu được gửi yêu cầu đổi trả trong 7 ngày; máy rơi vỡ, vào nước hoặc đổi ý sau khi kích hoạt không thuộc diện đổi trả. Pin nóng bất thường, phồng hay có mùi lạ thì ngừng sử dụng ngay, không tự tháo và liên hệ gian hàng.',
  },
  'may-tinh-thiet-bi-dien-tu': {
    choose: 'Xác định mục đích: văn phòng, học tập, đồ hoạ hay chơi game để chọn cấu hình tương ứng. Với laptop, xem bộ xử lý, RAM, ổ cứng SSD, chất lượng màn hình, trọng lượng và thời lượng pin. Với màn hình, chú ý kích thước, độ phân giải, tần số quét và cổng kết nối. Linh kiện máy tính phải tương thích với bo mạch và nguồn hiện có. Chuột, bàn phím, tai nghe, loa nên chọn theo thói quen dùng (không dây hay có dây, kích thước tay, độ ồn của phím).',
    care: 'Vệ sinh quạt tản nhiệt định kỳ, không đặt laptop trên chăn nệm khi chạy nặng và dùng bộ sạc đúng công suất. Không tự tháo máy khi còn bảo hành vì có thể làm mất bảo hành; giữ tem, số serial và phiếu bảo hành. Sao lưu dữ liệu quan trọng trước khi mang đi bảo hành hay sửa chữa, và dùng ổ cắm có chống sét cho thiết bị đắt tiền.',
    returns: 'Kiểm tra niêm phong, số serial và phụ kiện ngay khi nhận, quay video mở hộp. Lỗi phần cứng, điểm chết màn hình vượt mức nhà sản xuất cho phép, thiếu phụ kiện hoặc giao sai cấu hình được đổi trả trong 7 ngày; sau thời hạn này chuyển sang quy trình bảo hành. Máy đã cài đặt tuỳ biến, trầy xước do sử dụng, rơi vỡ hay vào nước không thuộc diện đổi trả. Thiết bị phát nhiệt hoặc có mùi khét thì rút nguồn ngay và ngừng dùng.',
  },
  'nha-cua-doi-song': {
    choose: 'Đồ điện gia dụng: so sánh công suất, dung tích và mức tiêu thụ điện; nồi chiên không dầu nên chọn dung tích theo số người ăn, bếp từ cần dùng nồi có đáy nhiễm từ, robot hút bụi cần xem diện tích và loại sàn. Nội thất: đo kỹ không gian, cửa ra vào và thang máy trước khi đặt, xem chất liệu (gỗ công nghiệp, gỗ tự nhiên, kim loại) và tải trọng. Chăn ga gối nệm: chọn đúng kích thước giường, chất liệu thoáng mát hay giữ ấm tuỳ mùa.',
    care: 'Đọc hướng dẫn sử dụng trước khi vận hành, vệ sinh thiết bị định kỳ và không để nước vào phần động cơ hoặc mạch điện. Nồi chảo chống dính không dùng dụng cụ kim loại cứng. Nội thất đặt xa nguồn ẩm, lắp ráp đúng sơ đồ và siết lại ốc sau vài tuần dùng. Chăn ga giặt theo nhãn hướng dẫn, phơi khô trước khi cất để tránh mùi ẩm.',
    returns: 'Hàng cồng kềnh nên kiểm tra kiện hàng trước mặt người giao và quay video lúc mở kiện; móp méo, vỡ hay thiếu phụ kiện cần báo ngay trong 7 ngày. Hàng chưa lắp đặt, chưa sử dụng và còn nguyên bao bì mới đổi trả được, shop sẽ phối hợp thu hồi. Thiết bị điện lỗi kỹ thuật được đổi hoặc chuyển bảo hành. Không dùng thiết bị khi dây điện bị hở, phích cắm nóng bất thường; không cắm nhiều thiết bị công suất lớn vào cùng một ổ cắm.',
  },
  'sac-dep-suc-khoe': {
    choose: 'Xác định loại da (dầu, khô, hỗn hợp, nhạy cảm) và mối quan tâm chính (mụn, thâm, lão hoá, chống nắng) rồi đối chiếu với thành phần ghi trên bao bì. Người da nhạy cảm nên thử một ít ở vùng da nhỏ trước khi dùng cả mặt. Đồ trang điểm cần chọn đúng tông da và dưới tông; nước hoa xem nhóm hương và nồng độ; sản phẩm chăm sóc tóc chọn theo tình trạng tóc. Thực phẩm chức năng cần đọc kỹ thành phần, đối tượng sử dụng và liều dùng.',
    care: 'Bảo quản nơi khô mát, tránh ánh nắng và hơi ẩm phòng tắm, luôn đóng nắp kín. Chú ý hạn dùng sau khi mở nắp ghi trên bao bì (biểu tượng hũ mở nắp kèm số tháng). Không dùng chung đồ trang điểm, rửa tay sạch trước khi lấy kem. Thực phẩm chức năng dùng đúng liều hướng dẫn, không phải là thuốc và không thay thế thuốc.',
    returns: 'Khi nhận hàng, kiểm tra niêm phong, ngày sản xuất, hạn dùng và tem phụ tiếng Việt. Hàng hết hạn, cận date bất thường, rò rỉ hoặc sai sản phẩm được đổi trả trong 7 ngày kèm ảnh/video; hàng đã mở nắp hoặc dùng thử chỉ xử lý khi có lỗi chất lượng. Nếu da bị kích ứng (đỏ, ngứa, rát) hãy ngừng dùng, rửa sạch và liên hệ gian hàng; người đang mang thai, có bệnh lý hay đang điều trị nên hỏi ý kiến bác sĩ trước khi dùng thực phẩm chức năng.',
  },
  'giay-dep-tui-xach': {
    choose: 'Với giày, đo chiều dài bàn chân vào buổi chiều rồi đối chiếu bảng size của gian hàng; chân bè nên chọn lớn hơn nửa size hoặc form rộng. Chọn theo mục đích: chạy bộ, đi chơi, công sở hay đi mưa (đế bám tốt để tránh trơn trượt). Với túi xách, balo và vali, xem kích thước, dung tích, chất liệu (vải, da PU, da thật), số ngăn và chất lượng khoá kéo, bánh xe. Vali đi máy bay nên đối chiếu quy định kích thước của hãng bay.',
    care: 'Giày vệ sinh sau mỗi lần dùng, nhét giấy giữ form và phơi nơi thoáng, tránh nắng gắt làm bong keo; luân phiên giày để đế và lót có thời gian khô. Túi da và da PU tránh ngấm nước, cất trong túi vải; vali không nhồi quá tải để bánh xe và khoá bền. Nhiều gian hàng bảo hành đường may hoặc keo đế trong một thời gian nhất định, xem ở trang sản phẩm.',
    returns: 'Khi không vừa size, thử giày trong nhà trên bề mặt sạch, giữ đế sạch, còn hộp và tem rồi gửi yêu cầu đổi trong 7 ngày. Giày túi đã mang ra đường, dính bẩn hoặc có mùi lạ khó đổi trả; lỗi bong keo, đường may, khoá kéo ngay khi nhận thuộc diện đổi hoặc bảo hành. Mang vali và balo đúng tải trọng ghi trên sản phẩm để tránh hỏng hóc và chấn thương lưng vai.',
  },
  'dong-ho-phu-kien': {
    choose: 'Đồng hồ: chọn loại máy (pin quartz, cơ tự động hay thông minh), kích thước mặt phù hợp cổ tay, chất liệu dây (kim loại, da, silicone) và mức chống nước (chống nước sinh hoạt khác với đi bơi, lặn). Kính mắt: chú ý kiểu gọng hợp khuôn mặt, tròng chống tia UV khi đi nắng. Trang sức bạc: xem hàm lượng bạc ghi trên thẻ, kích thước nhẫn, lắc và kiểu khoá. Ưu tiên gian hàng có hộp, thẻ bảo hành và thông tin xuất xứ rõ ràng.',
    care: 'Lau đồng hồ khô sau khi tiếp xúc mồ hôi hoặc nước, không bấm núm khi đang ở dưới nước, tránh từ trường mạnh và thay pin tại nơi uy tín để giữ độ kín nước. Đồng hồ cơ nên lên dây đều đặn và bảo dưỡng định kỳ. Trang sức bạc hạn chế tiếp xúc nước hoa, hoá chất, cất kín trong túi zip để chậm xỉn. Kính mắt lau bằng khăn mềm chuyên dụng và để trong hộp cứng.',
    returns: 'Giữ nguyên tem, niêm phong, hộp và thẻ bảo hành khi chưa chắc chắn. Hàng giao sai mẫu, lỗi máy hoặc hư hỏng khi nhận được đổi trả trong 7 ngày kèm video mở hộp; đồng hồ đã đeo trầy xước, kính đã cắt tròng theo toa riêng không thuộc diện đổi trả. Hãy đối chiếu số seri trên thẻ bảo hành với sản phẩm và thận trọng với hàng có giá rẻ bất thường so với thị trường.',
  },
  'the-thao-da-ngoai': {
    choose: 'Chọn theo bộ môn và trình độ: dụng cụ gym nên bắt đầu ở mức tạ vừa sức rồi tăng dần; thảm yoga cần xem độ dày và độ bám; xe đạp chọn cỡ khung theo chiều cao và loại địa hình; đồ cắm trại như lều, túi ngủ cần xem số người, khả năng chống nước và mức nhiệt phù hợp. Giày và quần áo thể thao ưu tiên chất liệu thoáng, thấm hút mồ hôi và đúng size.',
    care: 'Lau khô dụng cụ sau khi dùng và cất nơi khô thoáng để tránh gỉ sét. Xe đạp kiểm tra phanh, lốp, tra dầu xích định kỳ. Lều và túi ngủ phơi thật khô trước khi cất để không bị mốc. Bình gas mini và bếp dã ngoại chỉ dùng nơi thoáng, tránh xa lửa và nhiệt độ cao. Khung sườn xe và dụng cụ lớn thường có bảo hành riêng theo gian hàng.',
    returns: 'Dụng cụ chưa sử dụng, còn bao bì và phụ kiện mới đổi trả được; hàng lắp ráp cần kiểm tra khi nhận và báo ngay nếu thiếu linh kiện hoặc cong vênh. Lỗi nhà sản xuất được đổi hoặc bảo hành. Về an toàn: khởi động kỹ trước khi tập, kiểm tra mối ghép trước mỗi lần dùng, không vượt tải trọng tối đa và luôn đội mũ bảo hiểm khi đạp xe.',
  },
  'me-be': {
    choose: 'Sữa và đồ ăn dặm phải đúng độ tuổi ghi trên bao bì và còn hạn dùng dài; tã chọn theo cân nặng của bé; quần áo sơ sinh ưu tiên cotton mềm, ít đường may thô và không có chi tiết nhỏ dễ bung. Đồ chơi cần đúng độ tuổi khuyến nghị, tránh chi tiết nhỏ có thể nuốt. Xe đẩy, ghế ăn, nôi cần xem kỹ phanh, khoá gấp, dây đai an toàn và tải trọng.',
    care: 'Sữa bột đậy kín sau khi mở, dùng muỗng sạch khô và dùng hết trong thời gian ghi trên bao bì. Bình sữa, núm vú và đồ chơi cho bé ngậm cần rửa sạch, tiệt trùng định kỳ. Giặt đồ sơ sinh riêng bằng nước giặt dịu nhẹ, phơi khô thoáng. Thông tin trên sàn chỉ mang tính tham khảo; về dinh dưỡng và sức khoẻ của bé hãy hỏi ý kiến bác sĩ nhi khoa.',
    returns: 'Hàng tiếp xúc trực tiếp như sữa, tã, đồ ăn dặm, đồ vệ sinh chỉ đổi khi còn nguyên bao bì, chưa mở và còn hạn dùng; đã mở chỉ xử lý khi có lỗi chất lượng. Khi nhận hãy kiểm tra hạn dùng, niêm phong, các chi tiết nhỏ của đồ chơi và hoạt động của phanh, khoá xe đẩy. Không để bé một mình trên xe đẩy hoặc ghế ăn, luôn cài dây đai an toàn.',
  },
  'sach-van-phong-pham': {
    choose: 'Sách: xem thể loại, tác giả, nhà xuất bản, năm tái bản, loại bìa và số trang; sách thiếu nhi chọn theo lứa tuổi và đọc đánh giá của người mua trước. Văn phòng phẩm: bút nên xem cỡ ngòi và loại mực, vở xem định lượng giấy, số trang và kiểu kẻ (ô li, kẻ ngang, chấm), dụng cụ học tập chọn theo cấp học. Mua combo hoặc sách giảm giá thường tiết kiệm hơn nếu bạn có đủ nhu cầu.',
    care: 'Bảo quản sách nơi khô ráo, tránh ánh nắng và ẩm mốc; bọc bìa nếu thường mang theo. Không gấp góc trang, không phơi sách ẩm ngoài nắng gắt. Bút dùng xong đậy nắp, mực nước và keo dán cất nơi thoáng, tránh xa tầm tay trẻ nhỏ. Hãy chọn sách của gian hàng uy tín và kiểm tra mã ISBN, tem phát hành để tránh sách in lậu.',
    returns: 'Sách lỗi in, thiếu trang, rách bìa hoặc giao sai tựa được đổi trả trong 7 ngày kèm ảnh/video. Sách đã bóc màng co hoặc có dấu hiệu đã đọc và văn phòng phẩm đã mở hộp/sử dụng không thuộc diện đổi trả trừ khi có lỗi chất lượng. Với đồ dùng cho trẻ như kéo, dao rọc giấy, keo, cần có người lớn hướng dẫn khi sử dụng.',
  },
  'thuc-pham-do-uong': {
    choose: 'Đọc kỹ nhãn: ngày sản xuất, hạn dùng, thành phần, xuất xứ và cảnh báo dị ứng (đậu phộng, sữa, hải sản…). Đặc sản ba miền nên chọn loại đóng gói hút chân không hoặc có tem truy xuất rõ ràng. Cà phê chọn theo mức rang và dạng hạt hay xay sẵn; trà xem loại lá và cách pha; các loại hạt ưu tiên gói nhỏ để dùng hết trước khi mất độ giòn. Đồ ăn liền xem hướng dẫn chế biến và khối lượng.',
    care: 'Bảo quản nơi khô ráo, thoáng mát, tránh ánh nắng; đóng kín túi sau khi mở và dùng trong thời gian khuyến nghị. Sản phẩm ghi "bảo quản lạnh" cần cho vào tủ lạnh ngay khi nhận. Cà phê và trà để hộp kín, tránh mùi mạnh. Không dùng thực phẩm khi có dấu hiệu mốc, mùi lạ, bao bì phồng hoặc rò rỉ.',
    returns: 'Nên kiểm tra hạn dùng và bao bì ngay lúc nhận và quay video mở kiện. Hàng hết hạn, cận date bất thường, đổ vỡ, hư hỏng hoặc giao sai được gửi yêu cầu đổi trả trong 7 ngày kèm ảnh/video; hàng đã bóc hoặc đã dùng chỉ được xử lý khi có lỗi chất lượng. Người có tiền sử dị ứng cần đọc kỹ thành phần, và hãy nhớ thực phẩm chức năng không phải là thuốc.',
  },
  'thu-cung': {
    choose: 'Chọn thức ăn theo loài (chó, mèo), độ tuổi (con non, trưởng thành, lớn tuổi), kích cỡ giống và nhu cầu đặc biệt như triệt sản hay tiêu hoá nhạy cảm. Khi đổi loại thức ăn, nên trộn dần trong khoảng một tuần để tránh rối loạn tiêu hoá. Đồ chơi chọn kích cỡ phù hợp để thú không nuốt phải; vòng cổ, dây dắt, lồng hay nhà chọn đúng kích thước thú cưng; cát vệ sinh xem khả năng vón và mùi hương.',
    care: 'Hạt khô đậy kín, để nơi khô mát và dùng hết trong thời gian khuyến nghị sau khi mở; pate hoặc đồ ăn ướt đã mở nên cho vào tủ lạnh và dùng sớm. Rửa bát ăn, bát nước hằng ngày, giặt đệm nằm định kỳ. Thú cưng có dấu hiệu bất thường sau khi đổi thức ăn hoặc dùng sản phẩm mới thì ngừng và hỏi bác sĩ thú y.',
    returns: 'Thức ăn, cát vệ sinh còn nguyên bao, chưa mở và còn hạn dùng mới đổi trả được; sản phẩm đã mở chỉ xử lý khi có lỗi chất lượng. Phụ kiện sai kích cỡ có thể đổi nếu chưa sử dụng. Về an toàn: không cho thú ăn socola, hành, tỏi, nho hay thức ăn của người nhiều gia vị, và giám sát khi chơi với đồ chơi có chi tiết nhỏ.',
  },
  'o-to-xe-may': {
    choose: 'Mũ bảo hiểm: đo vòng đầu, chọn kiểu (nửa đầu, 3/4, fullface) theo nhu cầu, ưu tiên mũ có tem hoặc nhãn hợp quy ghi rõ, lớp xốp dày và quai cài chắc chắn. Phụ kiện, camera hành trình, đèn: kiểm tra tương thích với dòng xe và đời xe. Dầu nhớt: chọn đúng cấp độ nhớt theo sổ tay xe và loại xe (xe số, tay ga, ô tô). Đồ chăm sóc xe: xem công dụng (rửa xe, đánh bóng, bảo dưỡng) và bề mặt phù hợp.',
    care: 'Mũ bảo hiểm cất nơi thoáng, vệ sinh lớp lót định kỳ bằng xà phòng nhẹ, không dùng dung môi và nên thay mũ sau va chạm mạnh hoặc khi lớp xốp bị biến dạng. Dầu nhớt bảo quản nơi mát, đóng kín nắp và thay theo khuyến nghị của hãng xe. Phụ kiện điện lắp lên xe nên làm tại cơ sở uy tín để tránh chập cháy; một số gian hàng hỗ trợ lắp đặt tại cửa hàng nội thành, xem ở mô tả sản phẩm.',
    returns: 'Hãy kiểm tra tương thích trước khi lắp; hàng đã lắp lên xe, đã sử dụng hoặc dầu nhớt đã mở nắp không thuộc diện đổi trả trừ lỗi nhà sản xuất. Hàng giao sai mẫu, hư hỏng khi nhận được đổi trả trong 7 ngày; mũ bảo hiểm chưa đội ra đường, còn nguyên tem có thể đổi size. Không tự ý thay đổi các chi tiết ảnh hưởng đến an toàn của xe và luôn đội mũ bảo hiểm cài quai đúng cách.',
  },
};

/* "# Tiêu đề" + câu giới thiệu viết liền một đoạn, mỗi mục "## …" cũng liền với thân — chunkText cắt theo dòng trống nên tiêu đề không bị tách khỏi nội dung. */
function deptGuideContent(name: string, description: string, g: { choose: string; care: string; returns: string }): string {
  return [
    `# Hướng dẫn mua sắm: ${name}\n${description}. Dưới đây là cách chọn mua, bảo quản/bảo hành và lưu ý đổi trả đặc thù của ngành hàng này trên sàn FITLY.`,
    `## Cách chọn mua\n${g.choose}`,
    `## Bảo quản, sử dụng và bảo hành\n${g.care}`,
    `## Đổi trả đặc thù và lưu ý an toàn\n${g.returns}`,
  ].join('\n\n');
}

const OPS_MULTI_SHOP = `# Mua hàng của nhiều gian hàng trong một giỏ

## Một giỏ, nhiều đơn
Trên FITLY bạn có thể thêm sản phẩm của nhiều gian hàng (shop) vào cùng một giỏ. Khi đặt hàng, hệ thống nhóm sản phẩm theo gian hàng và tạo một đơn riêng cho mỗi shop. Các đơn thuộc cùng một lần đặt hàng nhưng mỗi đơn có mã, trạng thái, phí vận chuyển và tiến trình giao riêng, vì mỗi shop tự đóng gói và bàn giao cho đơn vị vận chuyển. Theo dõi tất cả tại Tài khoản → Đơn hàng của tôi.

## Phí vận chuyển tính riêng từng shop
Phí ship theo bảng phí chung của sàn và tỉnh/thành nhận hàng (TP.HCM 20.000₫, miền Nam 30.000₫, miền Trung 35.000₫, miền Bắc 40.000₫), tính riêng cho từng shop. Ngưỡng miễn phí vận chuyển 500.000₫ cũng xét riêng theo giá trị hàng của từng shop, không cộng gộp cả giỏ. Ví dụ mua hai shop, mỗi shop 300.000₫ thì cả hai đơn vẫn tính phí; mua 520.000₫ ở một shop thì đơn của shop đó được miễn phí.

## Thanh toán và COD
Với thanh toán trực tuyến, bạn có thể được yêu cầu thanh toán cho từng đơn của từng shop. Với COD, bạn trả tiền mặt cho từng kiện khi nhận; hạn mức COD (mặc định 5.000.000₫) được kiểm theo từng đơn, và mọi shop trong giỏ phải đang bật COD. Shop nào tạm ngừng nhận COD thì bạn chọn phương thức khác hoặc bỏ sản phẩm của shop đó khỏi giỏ.

## Giao hàng, huỷ và đổi trả theo từng shop
Các kiện hàng có thể về vào những ngày khác nhau. Bạn có thể huỷ đơn khi còn "Chờ xác nhận"; huỷ hoặc đổi trả đơn của shop này không ảnh hưởng đơn của shop khác. Yêu cầu đổi trả gửi riêng cho từng đơn trong 7 ngày kể từ khi nhận hàng, kèm ảnh/video; tiền hoàn cũng được xử lý riêng theo từng đơn.

## Khi một gian hàng bị khoá lúc bạn đang mua
Nếu sàn khoá một gian hàng đúng lúc bạn đặt hàng, hệ thống sẽ không nhận phần hàng của shop đó và thông báo cho bạn; phần hàng của các shop còn lại vẫn đặt bình thường.`;

const OPS_VOUCHER = `# Mã giảm giá của sàn và của gian hàng

## Hai loại mã
Mã của sàn do FITLY phát hành, tính trên cả giỏ hàng gồm nhiều shop (ví dụ miễn phí vận chuyển, giảm theo %, giảm số tiền cố định) và do sàn chịu chi phí. Mã của gian hàng do từng shop tự tạo, chỉ áp dụng cho phần hàng của đúng shop đó và do shop chịu chi phí. Với khách, giá phải trả luôn là số đã trừ phần giảm hiển thị ở bước thanh toán.

## Quy tắc dùng cùng lúc
Mỗi lần đặt hàng dùng được tối đa 1 mã của sàn và tối đa 1 mã của gian hàng cho mỗi shop có trong giỏ. Ví dụ giỏ có hàng của 3 shop: tối đa 1 mã sàn cộng 3 mã shop (mỗi shop 1 mã). Nhập mã thứ hai cùng loại hoặc cùng shop sẽ bị từ chối kèm lý do. Mã của shop không có trong giỏ cũng bị từ chối.

## Cách phân bổ về từng đơn
Mã sàn được tính trên cả giỏ rồi chia về các đơn của từng shop theo tỉ lệ giá trị hàng (mã miễn phí vận chuyển chia theo phí ship của từng shop). Mã shop chỉ trừ vào đơn của shop đó. Mỗi đơn không bị giảm quá giá trị hàng cộng phí vận chuyển của chính nó, và tổng các đơn luôn khớp số tiền bạn phải trả.

## Vì sao mã không dùng được
Mã có thể bị từ chối vì chưa đạt giá trị đơn tối thiểu, đã hết hạn hoặc hết lượt dùng, không áp dụng cho ngành hàng trong giỏ, hoặc vi phạm quy tắc 1 mã sàn + 1 mã mỗi shop. Thông báo lỗi nêu rõ lý do và số tiền còn thiếu (nếu có) để bạn mua thêm cho đủ điều kiện.`;

const OPS_PAYMENT = `# Thanh toán PayOS, VNPay, chuyển khoản và COD

## Các phương thức
FITLY hỗ trợ thanh toán khi nhận hàng (COD), chuyển khoản ngân hàng qua mã VietQR, thẻ ATM/Visa/Mastercard/QR qua VNPay và PayOS (QR hoặc liên kết chuyển khoản tự động). Phương thức nào chưa được bật sẽ không hiện ở bước thanh toán.

## PayOS
Chọn PayOS, hệ thống tạo liên kết và mã QR cho đơn; bạn quét bằng ứng dụng ngân hàng hoặc mở liên kết. Khi tiền về, đơn được xác nhận tự động, không cần gửi ảnh chuyển khoản. Liên kết giữ chỗ 30 phút; quá hạn đơn chưa thanh toán sẽ tự huỷ và nhả tồn kho, bạn đặt lại bình thường.

## VNPay và chuyển khoản VietQR
VNPay giữ đơn 30 phút. Chuyển khoản VietQR giữ đơn 24 giờ — hãy nhập đúng số tiền và nội dung chuyển khoản là mã đơn để kế toán đối chiếu nhanh. Đơn chuyển khoản được xác nhận thủ công nên có thể chậm hơn PayOS.

## COD
Trả tiền mặt cho người giao khi nhận hàng, tối đa 5.000.000₫ mỗi đơn (xét theo từng shop). COD chỉ dùng được khi gian hàng đang bật COD: sàn tự khoá COD của shop khi quỹ COD của shop hết số dư. Bạn được báo rõ ở bước thanh toán và có thể chọn phương thức khác.

## Đã bị trừ tiền nhưng đơn chưa xác nhận
Chờ vài phút rồi tải lại trang đơn hàng. Nếu vẫn chưa xác nhận, gửi ảnh chụp giao dịch (mã giao dịch, thời gian, số tiền) qua mục Liên hệ hoặc chat với trợ lý để gặp nhân viên; kế toán sẽ đối chiếu và xác nhận đơn hoặc hoàn tiền.

## Hoàn tiền
Đơn VNPay được hoàn về thẻ/tài khoản đã thanh toán. Đơn PayOS, COD và chuyển khoản có thể cần kế toán chuyển khoản thủ công nên đôi khi cần bạn cung cấp số tài khoản nhận tiền. Thời gian xử lý 3–5 ngày làm việc sau khi yêu cầu được duyệt.`;

const OPS_SELLER = `# Hướng dẫn người bán: hoa hồng, ví quỹ COD và đối soát

## Hoa hồng
Sàn thu hoa hồng theo phần trăm doanh thu mỗi đơn thành công; tỉ lệ ghi trên hồ sơ gian hàng và được chốt vào đơn lúc khách đặt hàng (đổi tỉ lệ sau đó chỉ áp dụng cho đơn mới). Doanh thu tính hoa hồng bằng số tiền khách trả cộng phần giảm của voucher sàn. Voucher sàn do sàn chịu, voucher shop do shop chịu. Ví dụ đơn 1.000.000₫, hoa hồng 8% (chưa tính phí vận chuyển): voucher sàn 50.000₫ thì shop nhận 920.000₫; voucher shop 50.000₫ thì shop nhận 874.000₫.

## Ví quỹ COD
Đơn COD do shop trực tiếp thu tiền mặt nên hoa hồng được trừ vào ví quỹ COD khi đơn hoàn tất, đúng một lần cho mỗi đơn. Khi số dư ví về 0 hoặc âm, COD của shop tự khoá cho các đơn mới (đơn đang giao dở không bị huỷ). Để mở lại, shop gửi yêu cầu nộp quỹ kèm chứng từ chuyển khoản; khi sàn duyệt, số tiền được cộng vào ví và COD mở lại nếu số dư lớn hơn 0.

## Đối soát đơn online
Với đơn VNPay, PayOS, chuyển khoản, sàn giữ tiền hộ. Mỗi kỳ đối soát chỉ tính các đơn đã qua hạn đổi trả (7 ngày kể từ khi giao); đơn chưa qua hạn dồn sang kỳ sau. Thực nhận bằng doanh thu trừ hoa hồng, trừ tiền đã hoàn cho khách, trừ nợ mang sang. Nếu âm thì kỳ này không chi tiền và số âm trừ tiếp vào kỳ sau.

## Chi trả và tra soát
Khi sàn đã cấu hình chi tiền PayOS và shop khai đúng ngân hàng, số tài khoản, tên chủ tài khoản thì tiền được chuyển tự động; nếu chưa, kế toán chuyển khoản thủ công rồi đánh dấu đã trả. Lệnh lỗi có thể chạy lại và không bao giờ chi trùng. Thắc mắc về kỳ đối soát hoặc ví quỹ COD, gửi kế toán sàn qua hotro@ecofashion.vn kèm mã kỳ hoặc mã đơn.`;

function buildDocs(faqs: FaqDef[]): DocDef[] {
  const docs: DocDef[] = [];
  for (const d of DEPARTMENTS) {
    const g = DEPT_GUIDE[d.slug];
    if (!g) {
      console.log(`   ! chưa có hướng dẫn chatbot cho ngành ${d.slug} — bỏ qua (thêm vào DEPT_GUIDE)`);
      continue;
    }
    docs.push({ title: `Hướng dẫn mua sắm ngành ${d.name}`, kind: 'guide', content: deptGuideContent(d.name, d.description, g) });
  }
  docs.push(
    { title: 'Mua hàng của nhiều gian hàng trong một giỏ', kind: 'guide', content: OPS_MULTI_SHOP },
    { title: 'Mã giảm giá của sàn và của gian hàng', kind: 'guide', content: OPS_VOUCHER },
    { title: 'Thanh toán PayOS, VNPay, chuyển khoản và COD', kind: 'guide', content: OPS_PAYMENT },
    { title: 'Hướng dẫn người bán: hoa hồng, ví quỹ COD và đối soát', kind: 'policy', content: OPS_SELLER },
    { title: 'Câu hỏi thường gặp về sàn đa gian hàng', kind: 'faq', content: faqs.map((f) => `**${f.q}**\n${f.a}`).join('\n\n') },
    ...NEW_PAGES.map((p) => ({ title: p.title, kind: 'policy' as const, content: p.content })),
  );
  return docs;
}

async function seedAiDocs(prisma: PrismaClient, docs: DocDef[], embedPending: boolean): Promise<void> {
  const marketing = await prisma.user.findFirst({ where: { email: 'marketing@ecofashion.vn' }, select: { id: true } });
  let created = 0;
  let chunkCount = 0;
  for (const d of docs) {
    const exists = await prisma.aiDocument.findFirst({ where: { title: d.title, isDeleted: false }, select: { id: true } });
    if (exists) continue;
    const parts = chunkText(`${d.title}\n\n${d.content}`);
    // Tài liệu + các đoạn tạo trong MỘT transaction: lỡ dừng giữa chừng thì chạy lại không bỏ sót tài liệu "rỗng đoạn".
    await prisma.$transaction(async (tx) => {
      const doc = await tx.aiDocument.create({
        data: { title: d.title, kind: d.kind, content: d.content, isActive: true, status: embedPending ? 'pending' : 'ready', createdBy: marketing?.id ?? null, updatedBy: marketing?.id ?? null },
        select: { id: true },
      });
      await tx.aiDocumentChunk.createMany({ data: parts.map((content, i) => ({ documentId: doc.id, chunkIndex: i, content })) });
    });
    created += 1;
    chunkCount += parts.length;
  }
  const deptDocs = docs.filter((d) => DEPARTMENTS.some((x) => d.title === `Hướng dẫn mua sắm ngành ${x.name}`)).length;
  console.log(`   tài liệu chatbot mới: ${docs.length} (${deptDocs} theo ngành + ${docs.length - deptDocs} vận hành/FAQ/chính sách; tạo mới ${created}, ${chunkCount} đoạn; ${embedPending ? 'worker sẽ nhúng vector' : 'không có OpenAI key → tìm từ khoá'})`);
}

/* ================================================================== */

export async function seed(prisma: PrismaClient): Promise<void> {
  const env = loadEnv();
  const images = new SeedImages(env);
  console.log(`   ảnh banner: ${images.mode}`);

  await seedBanners(prisma, images);
  const faqs = buildFaqs();
  await seedFaqs(prisma, faqs);
  await seedPages(prisma);
  await seedAiDocs(prisma, buildDocs(faqs), Boolean(env.EF_OPENAI_API_KEY));
  images.saveManifest();
}
