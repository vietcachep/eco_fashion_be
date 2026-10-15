/*
 * SEED module ai: kho tri thức chatbot (chính sách vận chuyển/đổi trả/thanh toán, FAQ, hướng dẫn chọn size, giới thiệu
 * shop) — cắt đoạn sẵn (không vector) để đường lùi tìm từ khoá chạy ngay; worker nhúng khi có EF_OPENAI_API_KEY
 * (status pending → ready). Thêm 1 phiên chat mẫu + 1 yêu cầu hỗ trợ mở + vài lượt xem sản phẩm cho gợi ý.
 * Idempotent: tài liệu theo tiêu đề; phiên/yêu cầu theo nội dung cố định. Cần system/product/identity.seed chạy trước.
 */
import { loadEnv } from '../../src/config/env';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { chunkText } from '../../src/modules/ai/foundation/chunk';
import { FAQS, PAGES } from './system.seed';

const SIZE_GUIDE = `# Hướng dẫn chọn size

## Áo (nam/nữ)
- S: ngực 84–88 cm, cao 1m55–1m62, nặng 45–52 kg
- M: ngực 88–94 cm, cao 1m60–1m68, nặng 52–60 kg
- L: ngực 94–100 cm, cao 1m65–1m73, nặng 60–68 kg
- XL: ngực 100–106 cm, cao 1m70–1m78, nặng 68–78 kg
- XXL: ngực 106–112 cm, nặng 78–88 kg

## Quần jean / short (size theo vòng eo inch)
- 26–27: eo 66–70 cm · 28–29: eo 71–76 cm · 30–31: eo 77–81 cm · 32–33: eo 82–86 cm · 34: eo 87–91 cm

## Váy / đầm (nữ)
- S: eo 62–66, mông 86–90 · M: eo 66–70, mông 90–94 · L: eo 70–74, mông 94–98 · XL: eo 74–78, mông 98–102 (cm)

Mẹo: giữa hai size thì chọn size lớn hơn với áo form ôm, size nhỏ hơn với áo form rộng/oversize. Đổi size miễn phí trong 7 ngày nếu không vừa.`;

const CARE = `# Bảo quản quần áo

- Cotton/thun: giặt máy nước lạnh, lộn trái, không sấy nhiệt cao để tránh co rút.
- Linen/đũi: giặt tay hoặc chế độ nhẹ, phơi bóng râm; ủi khi còn hơi ẩm.
- Denim/jean: giặt riêng 2–3 lần đầu vì có thể ra màu; hạn chế giặt thường xuyên.
- Voan/lụa: giặt tay nước lạnh, không vắt mạnh, ủi nhiệt thấp.
- Áo khoác dù: lau bằng khăn ẩm hoặc giặt máy chế độ nhẹ, không ủi trực tiếp.`;

const ORDER_GUIDE = `# Đặt hàng, thanh toán và theo dõi đơn

1. Chọn màu, size, số lượng → Thêm vào giỏ → Thanh toán.
2. Nhập địa chỉ nhận (hoặc chọn địa chỉ đã lưu), nhập mã khuyến mãi nếu có.
3. Chọn cách thanh toán: COD (trả cho shipper khi nhận, shipper thu hộ cho sàn, đơn dưới 5.000.000₫) hoặc PayOS (QR/chuyển khoản tự động, giữ 30 phút).
4. Sau khi đặt, đơn ở trạng thái Chờ xác nhận → Đã xác nhận → Đang đóng gói → Đang giao → Đã giao → Hoàn tất (tự động sau 7 ngày).
5. Khách có thể huỷ đơn khi còn Chờ xác nhận. Đơn chưa thanh toán online quá hạn sẽ tự huỷ.
6. Theo dõi tại Tài khoản → Đơn hàng của tôi; mọi thay đổi trạng thái đều có thông báo và email.`;

export async function seed(prisma: PrismaClient): Promise<void> {
  const env = loadEnv();
  const docs: Array<{ title: string; kind: string; content: string }> = [
    ...PAGES.filter((p) => p.slug !== 'privacy' && p.slug !== 'terms').map((p) => ({ title: p.title, kind: p.slug === 'about' ? 'guide' : 'policy', content: p.content })),
    { title: 'Câu hỏi thường gặp', kind: 'faq', content: FAQS.map((f) => `**${f.q}**\n${f.a}`).join('\n\n') },
    { title: 'Hướng dẫn chọn size', kind: 'guide', content: SIZE_GUIDE },
    { title: 'Bảo quản quần áo', kind: 'guide', content: CARE },
    { title: 'Đặt hàng, thanh toán và theo dõi đơn', kind: 'guide', content: ORDER_GUIDE },
  ];
  const marketing = await prisma.user.findFirst({ where: { email: 'marketing@ecofashion.vn' }, select: { id: true } });
  let created = 0;
  for (const d of docs) {
    const exists = await prisma.aiDocument.findFirst({ where: { title: d.title, isDeleted: false }, select: { id: true } });
    if (exists) continue;
    const doc = await prisma.aiDocument.create({ data: { title: d.title, kind: d.kind, content: d.content, isActive: true, status: env.EF_OPENAI_API_KEY ? 'pending' : 'ready', createdBy: marketing?.id ?? null, updatedBy: marketing?.id ?? null } });
    const chunks = chunkText(`${d.title}\n\n${d.content}`);
    await prisma.aiDocumentChunk.createMany({ data: chunks.map((c, i) => ({ documentId: doc.id, chunkIndex: i, content: c })) });
    created += 1;
  }
  console.log(`   tài liệu chatbot: ${docs.length} (tạo mới ${created}; ${env.EF_OPENAI_API_KEY ? 'worker sẽ nhúng vector' : 'không có OpenAI key → tìm từ khoá'})`);

  // Phiên chat mẫu của khách 1 + yêu cầu hỗ trợ mở (nhân viên thấy trong /admin/ai/support).
  const khach1 = await prisma.user.findFirst({ where: { email: 'khach1@ecofashion.vn' }, select: { id: true, email: true } });
  if (khach1) {
    const title = 'Có áo sơ mi nam linen size L không?';
    let session = await prisma.chatSession.findFirst({ where: { userId: khach1.id, title } });
    if (!session) {
      const product = await prisma.product.findFirst({ where: { slug: 'ao-so-mi-nam-linen', isDeleted: false }, select: { id: true } });
      const t0 = new Date(Date.now() - 2 * 86_400_000);
      session = await prisma.chatSession.create({ data: { userId: khach1.id, title, messageCount: 4, lastMessageAt: new Date(t0.getTime() + 3 * 60_000), createdAt: t0 } });
      await prisma.chatMessage.createMany({
        data: [
          { sessionId: session.id, role: 'user', content: title, source: 'rule', createdAt: t0 },
          { sessionId: session.id, role: 'assistant', content: 'Mình tìm được 1 sản phẩm hợp với bạn. Bấm vào để xem chi tiết nhé:', productIds: product ? [product.id] : [], source: 'rule', createdAt: new Date(t0.getTime() + 5_000) },
          { sessionId: session.id, role: 'user', content: 'Mình muốn gặp nhân viên để hỏi về đơn DHDEMO0010', source: 'rule', createdAt: new Date(t0.getTime() + 2 * 60_000) },
          { sessionId: session.id, role: 'assistant', content: 'Mình đã chuyển yêu cầu tới nhân viên. Bạn sẽ được liên hệ sớm qua email/điện thoại đã đăng ký.', source: 'rule', createdAt: new Date(t0.getTime() + 2 * 60_000 + 5_000) },
        ],
      });
      await prisma.supportRequest.create({ data: { sessionId: session.id, userId: khach1.id, email: khach1.email, summary: `${title} | Mình muốn gặp nhân viên để hỏi về đơn DHDEMO0010`, status: 'open', createdAt: new Date(t0.getTime() + 2 * 60_000) } });
      console.log('   phiên chat mẫu + yêu cầu hỗ trợ mở: khách 1');
    }
    // Lượt xem sản phẩm (gợi ý "có thể bạn thích").
    const viewed = await prisma.productViewEvent.count({ where: { userId: khach1.id } });
    if (viewed === 0) {
      const products = await prisma.product.findMany({ where: { slug: { in: ['ao-so-mi-nam-linen', 'quan-jean-nam-straight', 'ao-khoac-bomber-nam'] } }, select: { id: true } });
      await prisma.productViewEvent.createMany({ data: products.map((p, i) => ({ userId: khach1.id, productId: p.id, createdAt: new Date(Date.now() - (i + 1) * 3_600_000) })) });
    }
  }
}
