/*
 * SEED module system: tham số vận hành mặc định, 63 tỉnh/thành + phí ship theo vùng, banner trang chủ (ảnh bộ sưu tập),
 * FAQ, 5 trang chính sách, 6 tin nhắn liên hệ (mới + đã trả lời) cho màn quản trị. Idempotent: upsert theo khoá;
 * banner/FAQ theo tiêu đề, liên hệ theo email + nội dung (bỏ qua nếu có).
 */
import { loadEnv } from '../../src/config/env';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { SETTING_DEFAULTS } from '../../src/modules/system/foundation/system.constants';
import { SeedImages } from './lib/seed-images';

/* Mã GSO, vùng để tính phí: hcm 20k · mien-nam 30k · mien-trung 35k · mien-bac 40k. */
const PROVINCES: Array<[string, string, string]> = [
  ['79', 'TP. Hồ Chí Minh', 'hcm'],
  ['01', 'Hà Nội', 'mien-bac'], ['48', 'Đà Nẵng', 'mien-trung'], ['31', 'Hải Phòng', 'mien-bac'], ['92', 'Cần Thơ', 'mien-nam'],
  ['02', 'Hà Giang', 'mien-bac'], ['04', 'Cao Bằng', 'mien-bac'], ['06', 'Bắc Kạn', 'mien-bac'], ['08', 'Tuyên Quang', 'mien-bac'], ['10', 'Lào Cai', 'mien-bac'],
  ['11', 'Điện Biên', 'mien-bac'], ['12', 'Lai Châu', 'mien-bac'], ['14', 'Sơn La', 'mien-bac'], ['15', 'Yên Bái', 'mien-bac'], ['17', 'Hoà Bình', 'mien-bac'],
  ['19', 'Thái Nguyên', 'mien-bac'], ['20', 'Lạng Sơn', 'mien-bac'], ['22', 'Quảng Ninh', 'mien-bac'], ['24', 'Bắc Giang', 'mien-bac'], ['25', 'Phú Thọ', 'mien-bac'],
  ['26', 'Vĩnh Phúc', 'mien-bac'], ['27', 'Bắc Ninh', 'mien-bac'], ['30', 'Hải Dương', 'mien-bac'], ['33', 'Hưng Yên', 'mien-bac'], ['34', 'Thái Bình', 'mien-bac'],
  ['35', 'Hà Nam', 'mien-bac'], ['36', 'Nam Định', 'mien-bac'], ['37', 'Ninh Bình', 'mien-bac'], ['38', 'Thanh Hoá', 'mien-trung'], ['40', 'Nghệ An', 'mien-trung'],
  ['42', 'Hà Tĩnh', 'mien-trung'], ['44', 'Quảng Bình', 'mien-trung'], ['45', 'Quảng Trị', 'mien-trung'], ['46', 'Thừa Thiên Huế', 'mien-trung'], ['49', 'Quảng Nam', 'mien-trung'],
  ['51', 'Quảng Ngãi', 'mien-trung'], ['52', 'Bình Định', 'mien-trung'], ['54', 'Phú Yên', 'mien-trung'], ['56', 'Khánh Hoà', 'mien-trung'], ['58', 'Ninh Thuận', 'mien-trung'],
  ['60', 'Bình Thuận', 'mien-trung'], ['62', 'Kon Tum', 'mien-trung'], ['64', 'Gia Lai', 'mien-trung'], ['66', 'Đắk Lắk', 'mien-trung'], ['67', 'Đắk Nông', 'mien-trung'],
  ['68', 'Lâm Đồng', 'mien-trung'], ['70', 'Bình Phước', 'mien-nam'], ['72', 'Tây Ninh', 'mien-nam'], ['74', 'Bình Dương', 'mien-nam'], ['75', 'Đồng Nai', 'mien-nam'],
  ['77', 'Bà Rịa - Vũng Tàu', 'mien-nam'], ['80', 'Long An', 'mien-nam'], ['82', 'Tiền Giang', 'mien-nam'], ['83', 'Bến Tre', 'mien-nam'], ['84', 'Trà Vinh', 'mien-nam'],
  ['86', 'Vĩnh Long', 'mien-nam'], ['87', 'Đồng Tháp', 'mien-nam'], ['89', 'An Giang', 'mien-nam'], ['91', 'Kiên Giang', 'mien-nam'], ['93', 'Hậu Giang', 'mien-nam'],
  ['94', 'Sóc Trăng', 'mien-nam'], ['95', 'Bạc Liêu', 'mien-nam'], ['96', 'Cà Mau', 'mien-nam'],
];
const FEE: Record<string, number> = { hcm: 20000, 'mien-nam': 30000, 'mien-trung': 35000, 'mien-bac': 40000 };

const BANNERS = [
  { title: 'Bộ sưu tập mùa này', subtitle: 'Hàng mới về mỗi tuần — freeship đơn từ 500.000₫', image: 'catalog/collections/hang-moi.jpg', linkUrl: '/products?tag=new', position: 'hero', sortOrder: 1 },
  { title: 'Thời trang nữ', subtitle: 'Nhẹ nhàng cho ngày mới', image: 'catalog/collections/nu.jpg', linkUrl: '/products?gender=nu', position: 'hero', sortOrder: 2 },
  { title: 'Thời trang nam', subtitle: 'Đơn giản mà chỉn chu', image: 'catalog/collections/nam.jpg', linkUrl: '/products?gender=nam', position: 'hero', sortOrder: 3 },
  { title: 'Đầm dự tiệc', subtitle: 'Toả sáng mọi buổi tối', image: 'catalog/collections/dam-du-tiec.jpg', linkUrl: '/products?category=dam', position: 'promo', sortOrder: 1 },
];

export const FAQS = [
  { q: 'Phí vận chuyển bao nhiêu?', a: 'Nội thành TP.HCM 20.000₫, miền Nam 30.000₫, miền Trung 35.000₫, miền Bắc 40.000₫. Miễn phí cho đơn từ 500.000₫.', g: 'shipping', o: 1 },
  { q: 'Bao lâu thì nhận được hàng?', a: 'TP.HCM 1–2 ngày, các tỉnh 2–5 ngày làm việc kể từ khi đơn được xác nhận.', g: 'shipping', o: 2 },
  { q: 'Có được đổi trả không?', a: 'Đổi trả trong 7 ngày kể từ khi nhận hàng nếu hàng lỗi, giao sai hoặc không vừa size (còn tem mác, chưa qua sử dụng). Gửi yêu cầu ở mục Đơn hàng → Đổi trả kèm ảnh/video.', g: 'returns', o: 1 },
  { q: 'Bao giờ được hoàn tiền?', a: 'Sau khi shop nhận lại hàng và duyệt, hoàn tiền trong 3–5 ngày làm việc về phương thức thanh toán ban đầu (VNPay/chuyển khoản) hoặc chuyển khoản cho đơn COD.', g: 'returns', o: 2 },
  { q: 'Có những cách thanh toán nào?', a: 'Thanh toán khi nhận hàng (COD, đơn dưới 5.000.000₫), chuyển khoản ngân hàng (VietQR), thẻ ATM/Visa/Mastercard/QR qua VNPay.', g: 'payment', o: 1 },
  { q: 'Chọn size thế nào cho đúng?', a: 'Xem bảng size ở trang sản phẩm. Bạn cũng có thể dùng Thử đồ AI (tải ảnh toàn thân) hoặc chat với trợ lý để được gợi ý.', g: 'general', o: 1 },
];

export const PAGES: Array<{ slug: string; title: string; content: string }> = [
  { slug: 'about', title: 'Về FITLY', content: '# Về FITLY\n\nFITLY là sàn thương mại điện tử bán đa ngành hàng: thời trang nam nữ (áo thun, sơ mi, jean, váy, đầm, áo khoác…), điện thoại & phụ kiện, đồ dùng nhà bếp, nội thất, sắc đẹp & sức khoẻ — nhiều gian hàng, một nơi mua sắm.\n\nChúng tôi tin rằng mua sắm online nên nhanh, đáng tin cậy và có đủ thứ bạn cần.' },
  { slug: 'shipping', title: 'Chính sách vận chuyển', content: '# Chính sách vận chuyển\n\n- Nội thành TP.HCM: 20.000₫ (1–2 ngày)\n- Miền Nam: 30.000₫ · Miền Trung: 35.000₫ · Miền Bắc: 40.000₫ (2–5 ngày làm việc)\n- **Miễn phí vận chuyển** cho đơn từ 500.000₫\n\nĐơn được giao bởi đối tác vận chuyển; bạn theo dõi trạng thái trong mục Đơn hàng.' },
  { slug: 'returns-policy', title: 'Chính sách đổi trả', content: '# Chính sách đổi trả\n\nĐổi trả trong **7 ngày** kể từ khi nhận hàng khi:\n\n- Hàng bị hư hỏng khi nhận\n- Giao sai sản phẩm\n- Không vừa size / không giống mô tả\n\nĐiều kiện: còn tem mác, chưa giặt, kèm ảnh/video minh chứng. Gửi yêu cầu tại **Đơn hàng → Đổi trả**. Phí ship đổi trả do lỗi shop, shop chịu.' },
  { slug: 'privacy', title: 'Chính sách bảo mật', content: '# Chính sách bảo mật\n\nChúng tôi chỉ thu thập thông tin cần thiết để giao hàng và hỗ trợ (họ tên, số điện thoại, địa chỉ, email). Không bán, không chia sẻ cho bên thứ ba ngoài đối tác vận chuyển và thanh toán.\n\nKhông lưu số thẻ: thanh toán thẻ được thực hiện trên cổng VNPay. Ảnh bạn tải lên cho tính năng Thử đồ AI được xoá sau 24 giờ.' },
  { slug: 'terms', title: 'Điều khoản sử dụng', content: '# Điều khoản sử dụng\n\nKhi đặt hàng, bạn xác nhận thông tin giao hàng là chính xác. Giá và khuyến mãi áp dụng tại thời điểm đặt. Đơn chưa thanh toán online sau 30 phút sẽ tự huỷ.\n\nMọi tranh chấp được giải quyết trên tinh thần thiện chí; liên hệ hotline để được hỗ trợ.' },
];

/* Tin nhắn liên hệ từ form storefront — 2 đã được nhân viên bán hàng trả lời, 4 còn mới. */
const CONTACTS: Array<{ name: string; email: string; phone?: string; message: string; daysAgo: number; reply?: string }> = [
  { name: 'Nguyễn Văn An', email: 'khach1@ecofashion.vn', phone: '0912000001', message: 'Shop có size XXL cho áo thun cotton nam basic không ạ? Mình muốn đặt 3 cái cho nhóm.', daysAgo: 6, reply: 'Chào anh An, hiện áo thun cotton nam basic có tới size XL. Size XXL dự kiến về trong tuần sau, shop sẽ nhắn anh ngay khi có hàng ạ.' },
  { name: 'Trần Thị Bình', email: 'khach2@ecofashion.vn', phone: '0912000002', message: 'Đơn DHDEMO0004 mình dùng mã FREESHIP nhưng vẫn thấy dòng phí vận chuyển, nhờ shop kiểm tra giúp.', daysAgo: 5, reply: 'Chào chị Bình, shop đã kiểm tra: đơn DHDEMO0004 phí vận chuyển đã được giảm về 0 ₫ (dòng "Giảm giá" trong hoá đơn). Chị yên tâm nhé!' },
  { name: 'Lê Văn Cường', email: 'khach3@ecofashion.vn', phone: '0912000003', message: 'Mình gửi yêu cầu trả áo khoác dù (đơn DHDEMO0009) 2 ngày rồi, bao giờ được duyệt vậy?', daysAgo: 1 },
  { name: 'Phạm Thị Dung', email: 'khach4@ecofashion.vn', message: 'Đầm dự tiệc body có màu đỏ đô không shop? Trên web chỉ thấy đen với be.', daysAgo: 1 },
  { name: 'Hồ Minh Khoa', email: 'khoa.hm@gmail.com', phone: '0988123456', message: 'Bên mình là công ty muốn đặt 40 áo polo in logo làm đồng phục, shop có nhận đơn số lượng lớn và báo giá riêng không?', daysAgo: 0 },
  { name: 'Đặng Thu Hà', email: 'thuha.dang@outlook.com', message: 'Chương trình đổi trả 7 ngày có áp dụng cho hàng giảm giá không ạ?', daysAgo: 0 },
];

export async function seed(prisma: PrismaClient): Promise<void> {
  for (const [key, d] of Object.entries(SETTING_DEFAULTS)) {
    await prisma.setting.upsert({ where: { key }, create: { key, value: d.value as never, groupCode: d.group, description: d.description, isPublic: d.isPublic }, update: { groupCode: d.group, description: d.description, isPublic: d.isPublic } });
  }
  console.log(`   tham số: ${Object.keys(SETTING_DEFAULTS).length} (upsert, giữ giá trị đã sửa)`);

  for (const [i, [code, name, region]] of PROVINCES.entries()) {
    await prisma.province.upsert({ where: { code }, create: { code, name, region, shippingFee: String(FEE[region]), sortOrder: i, isActive: true }, update: { name, region, sortOrder: i } });
  }
  console.log(`   tỉnh/thành: ${PROVINCES.length} (upsert, giữ phí đã sửa)`);

  const images = new SeedImages(loadEnv());
  let created = 0;
  for (const b of BANNERS) {
    const img = await images.resolve(b.image);
    const exists = await prisma.banner.findFirst({ where: { title: b.title, isDeleted: false }, select: { id: true, imageUrl: true, imagePublicId: true } });
    if (exists) {
      if (exists.imageUrl !== img.url || exists.imagePublicId !== img.publicId) {
        await prisma.banner.update({ where: { id: exists.id }, data: { imageUrl: img.url, imagePublicId: img.publicId } });
      }
      continue;
    }
    await prisma.banner.create({ data: { title: b.title, subtitle: b.subtitle, imageUrl: img.url, imagePublicId: img.publicId, linkUrl: b.linkUrl, position: b.position, sortOrder: b.sortOrder, isActive: true } });
    created += 1;
  }
  console.log(`   banner: ${BANNERS.length} (tạo mới ${created})`);

  created = 0;
  for (const f of FAQS) {
    const exists = await prisma.faq.findFirst({ where: { question: f.q, isDeleted: false }, select: { id: true } });
    if (exists) continue;
    await prisma.faq.create({ data: { question: f.q, answer: f.a, groupCode: f.g, sortOrder: f.o, isActive: true } });
    created += 1;
  }
  console.log(`   FAQ: ${FAQS.length} (tạo mới ${created})`);

  for (const p of PAGES) {
    await prisma.page.upsert({ where: { slug: p.slug }, create: { slug: p.slug, title: p.title, content: p.content, isActive: true }, update: {} });
  }
  console.log(`   trang: ${PAGES.length} (upsert, giữ nội dung đã sửa)`);

  const sales = await prisma.user.findFirst({ where: { email: 'sales@ecofashion.vn', isDeleted: false }, select: { id: true } });
  created = 0;
  for (const c of CONTACTS) {
    const exists = await prisma.contactMessage.findFirst({ where: { email: c.email, message: c.message }, select: { id: true } });
    if (exists) continue;
    const createdAt = new Date(Date.now() - c.daysAgo * 86_400_000 - 3 * 3_600_000);
    await prisma.contactMessage.create({
      data: {
        name: c.name, email: c.email, phone: c.phone ?? null, message: c.message, createdAt,
        status: c.reply ? 'handled' : 'new', reply: c.reply ?? null,
        handledBy: c.reply ? (sales?.id ?? null) : null, handledAt: c.reply ? new Date(createdAt.getTime() + 5 * 3_600_000) : null,
      },
    });
    created += 1;
  }
  console.log(`   liên hệ: ${CONTACTS.length} (tạo mới ${created}; ${CONTACTS.filter((c) => c.reply).length} đã trả lời)`);
}
