/*
 * SEED module cart + order + payment (+ promotion_usages): giỏ/wishlist demo cho khách, 14 đơn đủ trạng thái
 * (pending COD, chờ PayOS, confirmed, packing, shipping, delivered, completed, cancelled, đổi trả đã hoàn),
 * kèm payment/giao dịch tương ứng (chỉ COD + PayOS; COD đã giao/hoàn tất có Payment `paid` + cod_collect vì sàn thu hộ qua shipper), sổ kho (RESERVE/SALE/RETURN) và soldCount. Idempotent: đơn tồn tại theo mã → bỏ qua.
 * Mã đơn seed `DHDEMO0001..` (khác dãy DHyymmdd của API). Cần identity/system/product/promotion.seed chạy trước.
 */
import type { PrismaClient } from '../../src/generated/prisma/client';
import { FITLY_OFFICIAL_SHOP_ID } from './lib/seed-shop';

type Status = 'pending' | 'confirmed' | 'packing' | 'shipping' | 'delivered' | 'completed' | 'cancelled';
type Method = 'cod' | 'payos';

interface Spec {
  code: string;
  customer: number; // khachN
  method: Method;
  status: Status;
  paid: boolean;
  daysAgo: number;
  items: Array<{ slug: string; qty: number }>;
  promotion?: string;
  note?: string;
  cancelReason?: string;
  returned?: 'requested' | 'approved' | 'refunded';
}

const SPECS: Spec[] = [
  { code: 'DHDEMO0001', customer: 1, method: 'cod', status: 'completed', paid: true, daysAgo: 22, items: [{ slug: 'ao-thun-cotton-nam-basic', qty: 2 }, { slug: 'ao-thun-in-hinh-unisex', qty: 1 }] },
  { code: 'DHDEMO0002', customer: 2, method: 'payos', status: 'completed', paid: true, daysAgo: 20, items: [{ slug: 'ao-so-mi-nu-tay-phong', qty: 1 }], promotion: 'GIAM10' },
  { code: 'DHDEMO0003', customer: 4, method: 'payos', status: 'completed', paid: true, daysAgo: 18, items: [{ slug: 'quan-jean-nu-ong-rong', qty: 1 }, { slug: 'ao-thun-croptop-nu', qty: 1 }] },
  { code: 'DHDEMO0004', customer: 2, method: 'cod', status: 'completed', paid: true, daysAgo: 16, items: [{ slug: 'quan-short-jean-nu', qty: 1 }, { slug: 'ao-thun-oversize-nam', qty: 2 }], promotion: 'FREESHIP' },
  { code: 'DHDEMO0005', customer: 1, method: 'payos', status: 'completed', paid: true, daysAgo: 14, items: [{ slug: 'dam-du-tiec-body', qty: 1 }] },
  { code: 'DHDEMO0006', customer: 3, method: 'payos', status: 'delivered', paid: true, daysAgo: 9, items: [{ slug: 'ao-so-mi-nam-linen', qty: 1 }, { slug: 'quan-jean-nam-slim-fit', qty: 1 }], returned: 'refunded' },
  { code: 'DHDEMO0007', customer: 4, method: 'cod', status: 'completed', paid: true, daysAgo: 8, items: [{ slug: 'ao-thun-polo-nam', qty: 1 }], note: 'Giao giờ hành chính' },
  { code: 'DHDEMO0008', customer: 5, method: 'payos', status: 'cancelled', paid: false, daysAgo: 6, items: [{ slug: 'dam-suong-nu-basic', qty: 1 }], cancelReason: 'Quá hạn thanh toán PayOS' },
  { code: 'DHDEMO0009', customer: 3, method: 'cod', status: 'delivered', paid: true, daysAgo: 3, items: [{ slug: 'ao-khoac-du-chong-nuoc', qty: 1 }, { slug: 'quan-short-kaki-nam', qty: 1 }], returned: 'requested' },
  { code: 'DHDEMO0010', customer: 1, method: 'cod', status: 'shipping', paid: false, daysAgo: 2, items: [{ slug: 'ao-so-mi-nam-cong-so', qty: 1 }] },
  { code: 'DHDEMO0011', customer: 2, method: 'payos', status: 'packing', paid: true, daysAgo: 1, items: [{ slug: 'dam-du-tiec-body', qty: 1 }, { slug: 'ao-thun-croptop-nu', qty: 1 }], promotion: 'DAM100K' },
  { code: 'DHDEMO0012', customer: 5, method: 'payos', status: 'confirmed', paid: true, daysAgo: 1, items: [{ slug: 'chan-vay-xep-ly', qty: 1 }, { slug: 'ao-thun-nu-form-rong', qty: 1 }] },
  { code: 'DHDEMO0013', customer: 4, method: 'cod', status: 'pending', paid: false, daysAgo: 0, items: [{ slug: 'ao-so-mi-nu-form-rong', qty: 1 }] },
  { code: 'DHDEMO0014', customer: 5, method: 'payos', status: 'pending', paid: false, daysAgo: 0, items: [{ slug: 'quan-jean-nu-skinny', qty: 1 }, { slug: 'dam-hoa-nhi-vintage', qty: 1 }] },
];

const STATUS_CHAIN: Status[] = ['pending', 'confirmed', 'packing', 'shipping', 'delivered', 'completed'];
const STAFF_EMAIL = { sales: 'sales@ecofashion.vn', warehouse: 'warehouse@ecofashion.vn', accountant: 'accountant@ecofashion.vn' };

function daysAgo(n: number, hourOffset = 0): Date {
  const d = new Date(Date.now() - n * 86_400_000 + hourOffset * 3_600_000);
  return d;
}

export async function seed(prisma: PrismaClient): Promise<void> {
  const customers = await prisma.user.findMany({ where: { email: { in: [1, 2, 3, 4, 5].map((i) => `khach${i}@ecofashion.vn`) }, isDeleted: false }, include: { addresses: { where: { isDefault: true } } } });
  const staff = await prisma.user.findMany({ where: { email: { in: Object.values(STAFF_EMAIL) } }, select: { id: true, email: true } });
  const staffId = (role: keyof typeof STAFF_EMAIL) => staff.find((s) => s.email === STAFF_EMAIL[role])?.id ?? null;
  const products = await prisma.product.findMany({ where: { isDeleted: false, status: 'active' }, orderBy: { name: 'asc' }, include: { variants: { where: { isDeleted: false, isActive: true }, orderBy: [{ colorCode: 'asc' }, { sizeCode: 'asc' }] }, images: { orderBy: { sortOrder: 'asc' } } } });
  const provinces = new Map((await prisma.province.findMany()).map((p) => [p.code, p]));
  const thresholdSetting = await prisma.setting.findUnique({ where: { key: 'shipping.free_threshold' } });
  const freeThreshold = BigInt(typeof thresholdSetting?.value === 'number' || typeof thresholdSetting?.value === 'string' ? thresholdSetting.value : 500000);
  /* PLAN-0014 bước 7: mọi Order thuộc đúng 1 shop + 1 OrderGroup (đơn seed đều single-shop, gói OrderGroup 1-đơn). */
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: FITLY_OFFICIAL_SHOP_ID }, select: { commissionRate: true } });
  const commissionRateSnapshot = shop.commissionRate.toString();
  if (customers.length < 5 || products.length < 24) throw new Error('Thiếu khách demo hoặc sản phẩm — chạy identity/product.seed trước');

  // Giỏ + wishlist demo (khách 1, 2) — idempotent theo unique.
  const bySlug = (slug: string) => {
    const p = products.find((x) => x.slug === slug);
    if (!p) throw new Error(`Thiếu sản phẩm ${slug} — chạy product.seed trước`);
    return p;
  };
  for (const [ci, lines] of [[1, [['ao-thun-cotton-nam-basic', 1], ['quan-jean-nam-slim-fit', 1]]], [2, [['dam-suong-nu-basic', 1]]]] as Array<[number, Array<[string, number]>]>) {
    const u = customers.find((c) => c.email === `khach${ci}@ecofashion.vn`)!;
    const cart = await prisma.cart.upsert({ where: { userId: u.id }, create: { userId: u.id }, update: {} });
    for (const [slug, qty] of lines) {
      const p = bySlug(slug);
      const v = p.variants.find((x) => x.stock - x.reserved > 0) ?? p.variants[0];
      await prisma.cartItem.upsert({ where: { cartId_variantId: { cartId: cart.id, variantId: v.id } }, create: { cartId: cart.id, variantId: v.id, productId: p.id, shopId: p.shopId, quantity: qty }, update: {} });
    }
    for (const slug of ['ao-khoac-blazer-nu', 'chan-vay-jean-ngan']) await prisma.wishlist.upsert({ where: { userId_productId: { userId: u.id, productId: bySlug(slug).id } }, create: { userId: u.id, productId: bySlug(slug).id }, update: {} });
  }
  console.log('   giỏ hàng + wishlist demo: khách 1, 2');

  let created = 0;
  for (const s of SPECS) {
    const exists = await prisma.order.findFirst({ where: { code: s.code }, select: { id: true } });
    if (exists) continue;
    const u = customers.find((c) => c.email === `khach${s.customer}@ecofashion.vn`)!;
    const addr = u.addresses[0];
    if (!addr) throw new Error(`Khách ${u.email} chưa có địa chỉ mặc định`);
    const createdAt = daysAgo(s.daysAgo, -3);

    // Dòng đơn: chọn biến thể còn hàng đủ số lượng (ưu tiên size M/L).
    const lines = s.items.map((it) => {
      const p = products.find((x) => x.slug === it.slug);
      if (!p) throw new Error(`Thiếu sản phẩm ${it.slug} — chạy product.seed trước`);
      const v = p.variants.find((x) => !!x.sizeCode && ['M', 'L', '30', '31'].includes(x.sizeCode) && x.stock - x.reserved >= it.qty) ?? p.variants.find((x) => x.stock - x.reserved >= it.qty) ?? p.variants[0];
      const img = p.images.find((i) => i.colorCode === v.colorCode) ?? p.images.find((i) => i.isPrimary) ?? p.images[0];
      const unit = BigInt((v.price ?? p.basePrice).toFixed(0));
      return { p, v, imageUrl: img?.url ?? null, unitPrice: unit, quantity: it.qty, lineTotal: unit * BigInt(it.qty) };
    });
    const subtotal = lines.reduce((a, l) => a + l.lineTotal, 0n);
    const province = provinces.get(addr.provinceCode ?? '');
    const shippingFee = subtotal >= freeThreshold ? 0n : BigInt(province?.shippingFee.toFixed(0) ?? '30000');
    let discount = 0n;
    let promotion: { id: string; code: string; name: string } | null = null;
    if (s.promotion) {
      const pr = await prisma.promotion.findFirst({ where: { code: s.promotion, isDeleted: false }, include: { targets: true } });
      // Cùng công thức PromotionService.discountOf: chỉ dòng thuộc ngành/sản phẩm mục tiêu; freeship = phí ship (giữ phí, ghi vào discount); % có trần; số tiền ≤ base.
      const base = pr ? lines.filter((l) => pr.appliesTo === 'all' || pr.targets.some((t) => (t.targetType === 'category' && t.targetRef === l.p.categorySlug) || (t.targetType === 'product' && t.targetRef === l.p.id))).reduce((a, l) => a + l.lineTotal, 0n) : 0n;
      if (pr && base > 0n) {
        promotion = { id: pr.id, code: pr.code, name: pr.name };
        if (pr.type === 'free_shipping') discount = shippingFee;
        else if (pr.type === 'percentage') discount = (base * BigInt(pr.value.toFixed(0))) / 100n;
        else discount = BigInt(pr.value.toFixed(0));
        if (pr.maxDiscount && discount > BigInt(pr.maxDiscount.toFixed(0))) discount = BigInt(pr.maxDiscount.toFixed(0));
        if (discount > base) discount = base;
      }
    }
    const total = subtotal + shippingFee - discount;
    const idx = STATUS_CHAIN.indexOf(s.status);
    const stamp = (step: number, hours: number) => (s.status !== 'cancelled' && idx >= step ? new Date(createdAt.getTime() + hours * 3_600_000) : null);
    const paymentStatus = s.returned === 'refunded' ? 'partially_refunded' : s.method === 'cod' ? (idx >= 4 ? 'paid' : 'unpaid') : s.paid ? 'paid' : 'unpaid';

    const order = await prisma.$transaction(async (tx) => {
      const shippingAddressStr = [addr.street, addr.wardName, addr.districtName, addr.provinceName].filter(Boolean).join(', ');
      const group = await tx.orderGroup.create({
        data: {
          code: `DHN${s.code.slice(2)}`,
          userId: u.id,
          recipientName: addr.recipientName,
          recipientPhone: addr.phone,
          shippingAddress: shippingAddressStr,
          subtotal: subtotal.toString(),
          shippingFee: shippingFee.toString(),
          discount: discount.toString(),
          total: total.toString(),
          createdAt,
          createdBy: u.id,
        },
      });
      const o = await tx.order.create({
        data: {
          code: s.code,
          userId: u.id,
          shopId: FITLY_OFFICIAL_SHOP_ID,
          orderGroupId: group.id,
          commissionRateSnapshot,
          status: s.status,
          paymentMethodCode: s.method,
          paymentStatus,
          recipientName: addr.recipientName,
          recipientPhone: addr.phone,
          provinceCode: addr.provinceCode,
          provinceName: addr.provinceName,
          districtName: addr.districtName,
          wardName: addr.wardName,
          street: addr.street,
          shippingAddress: shippingAddressStr,
          customerNote: s.note ?? null,
          subtotal: subtotal.toString(),
          shippingFee: shippingFee.toString(),
          discount: discount.toString(),
          promotionCode: promotion?.code ?? null,
          promotionName: promotion?.name ?? null,
          total: total.toString(),
          itemCount: lines.reduce((a, l) => a + l.quantity, 0),
          cancelReason: s.cancelReason ?? null,
          paymentExpiresAt: s.method === 'payos' && s.status === 'pending' && !s.paid ? new Date(createdAt.getTime() + 30 * 60_000) : null,
          confirmedAt: stamp(1, 2),
          packedAt: stamp(2, 6),
          shippedAt: stamp(3, 20),
          deliveredAt: stamp(4, 60),
          completedAt: stamp(5, 60 + 7 * 24),
          cancelledAt: s.status === 'cancelled' ? new Date(createdAt.getTime() + 30 * 60_000) : null,
          createdAt,
          updatedAt: createdAt,
          createdBy: u.id,
          items: { create: lines.map((l) => ({ variantId: l.v.id, productId: l.p.id, shopId: l.p.shopId, slug: l.p.slug, name: l.p.name, imageUrl: l.imageUrl, color: l.v.colorName ?? "", size: l.v.sizeCode ?? "", sku: l.v.sku, quantity: l.quantity, unitPrice: l.unitPrice.toString(), lineTotal: l.lineTotal.toString() })) },
        },
        include: { items: true },
      });
      // Lịch sử trạng thái
      const hist: Array<{ from: string | null; to: string; at: Date; actor: string | null; note?: string }> = [{ from: null, to: 'pending', at: createdAt, actor: u.id }];
      if (s.status === 'cancelled') hist.push({ from: 'pending', to: 'cancelled', at: o.cancelledAt!, actor: null, note: s.cancelReason });
      else for (let i = 1; i <= idx; i++) hist.push({ from: STATUS_CHAIN[i - 1], to: STATUS_CHAIN[i], at: [o.confirmedAt, o.packedAt, o.shippedAt, o.deliveredAt, o.completedAt][i - 1] ?? createdAt, actor: i === 1 ? staffId('sales') : i <= 3 ? staffId('warehouse') : null, note: i === 5 ? 'Tự động hoàn tất sau 7 ngày' : undefined });
      for (const h of hist) await tx.orderStatusHistory.create({ data: { orderId: o.id, fromStatus: h.from, toStatus: h.to, note: h.note ?? null, actorUserId: h.actor, createdAt: h.at } });

      // Kho: pending → giữ chỗ; confirmed+ → trừ tồn (SALE); cancelled → không đụng (coi như đã nhả).
      for (const l of lines) {
        if (s.status === 'pending') {
          await tx.productVariant.update({ where: { id: l.v.id }, data: { reserved: { increment: l.quantity } } });
          await tx.stockMovement.create({ data: { productId: l.p.id, variantId: l.v.id, type: 'RESERVE', quantity: -l.quantity, stockAfter: l.v.stock, refType: 'order', refId: s.code, note: 'seed', createdAt } });
        } else if (s.status !== 'cancelled') {
          const after = l.v.stock - l.quantity;
          await tx.productVariant.update({ where: { id: l.v.id }, data: { stock: after } });
          await tx.stockMovement.create({ data: { productId: l.p.id, variantId: l.v.id, type: 'SALE', quantity: -l.quantity, stockAfter: after, refType: 'order', refId: s.code, note: 'seed', createdAt: o.confirmedAt ?? createdAt } });
          l.v.stock = after;
          if (idx >= 4) await tx.product.update({ where: { id: l.p.id }, data: { soldCount: { increment: l.quantity } } });
        }
      }

      // Thanh toán
      // COD đã giao/hoàn tất: sàn (qua shipper) đã thu tiền → Payment `paid`; COD chưa giao giữ `pending`. PayOS paid → webhook.
      const codCollected = s.method === 'cod' && idx >= 4;
      const isPaid = s.method === 'cod' ? codCollected : s.paid;
      const paidAt = isPaid ? (s.method === 'cod' ? new Date(o.deliveredAt!.getTime() + 30 * 60_000) : new Date(createdAt.getTime() + 10 * 60_000)) : null;
      const payStatus = s.returned === 'refunded' ? 'partially_refunded' : isPaid ? 'paid' : s.status === 'cancelled' ? 'expired' : 'pending';
      const payosCode = `${Math.floor(createdAt.getTime() / 1000)}${s.code.slice(-3)}`; // mã đơn PayOS giả, tất định theo mốc tạo + mã đơn
      const payment = await tx.payment.create({
        data: {
          orderId: o.id, orderCode: s.code, userId: u.id, methodCode: s.method, amount: total.toString(), status: payStatus,
          transactionCode: isPaid && s.method === 'payos' ? payosCode : null,
          paidAt, expiresAt: s.method === 'payos' ? new Date(createdAt.getTime() + 30 * 60_000) : null,
          createdAt, createdBy: u.id,
        },
      });
      if (s.method === 'payos') {
        const linkId = `demo-link-${s.code.toLowerCase()}`;
        await tx.paymentTransaction.create({ data: { paymentId: payment.id, type: 'create_url', status: 'ok', amount: total.toString(), providerRef: payosCode, rawRequest: { payosOrderCode: payosCode, checkoutUrl: `https://pay.payos.vn/web/${linkId}`, paymentLinkId: linkId }, createdAt } });
        if (isPaid) await tx.paymentTransaction.create({ data: { paymentId: payment.id, type: 'payos_webhook', status: 'ok', amount: total.toString(), providerRef: payosCode, rawResponse: { code: '00', desc: 'success', orderCode: payosCode, amount: Number(total), description: s.code, paymentLinkId: linkId }, createdAt: paidAt! } });
      }
      if (codCollected) await tx.paymentTransaction.create({ data: { paymentId: payment.id, type: 'cod_collect', status: 'ok', amount: total.toString(), providerRef: `cod:${s.code}`, createdAt: paidAt! } });

      // Khuyến mãi đã dùng
      if (promotion) {
        await tx.promotionUsage.create({ data: { promotionId: promotion.id, userId: u.id, orderCode: s.code, discountAmount: discount.toString(), createdAt, releasedAt: s.status === 'cancelled' ? o.cancelledAt : null } });
        if (s.status !== 'cancelled') await tx.promotion.update({ where: { id: promotion.id }, data: { usedCount: { increment: 1 } } });
      }

      // Đổi trả (dòng đầu tiên, hoàn theo tỉ lệ giảm)
      if (s.returned) {
        const item = o.items[0];
        const ratio = subtotal > 0n ? Number(discount) / Number(subtotal) : 0;
        const refund = BigInt(Math.round(Number(item.lineTotal) * (1 - ratio)));
        const requestedAt = new Date(o.deliveredAt!.getTime() + 24 * 3_600_000);
        const processed = s.returned !== 'requested';
        const rr = await tx.returnRequest.create({
          data: {
            orderId: o.id, orderCode: s.code, userId: u.id, status: s.returned, reason: 'Không vừa size', detail: 'Mặc hơi rộng, muốn đổi sang size nhỏ hơn hoặc hoàn tiền.',
            refundAmount: refund.toString(), evidence: [{ type: 'image', url: item.imageUrl ?? '', name: 'anh-san-pham.jpg' }],
            processedBy: processed ? staffId('sales') : null, processedAt: processed ? new Date(requestedAt.getTime() + 6 * 3_600_000) : null,
            createdAt: requestedAt, updatedAt: requestedAt,
            items: { create: [{ orderItemId: item.id, variantId: item.variantId, name: item.name, color: item.color, size: item.size, quantity: item.quantity, imageUrl: item.imageUrl, unitPrice: item.unitPrice }] },
          },
        });
        if (s.returned === 'refunded') {
          const l = lines[0];
          await tx.productVariant.update({ where: { id: l.v.id }, data: { stock: { increment: l.quantity } } });
          await tx.stockMovement.create({ data: { productId: l.p.id, variantId: l.v.id, type: 'RETURN', quantity: l.quantity, stockAfter: l.v.stock + l.quantity, refType: 'order', refId: s.code, note: 'seed đổi trả', createdAt: rr.processedAt! } });
          const refundedAt = new Date(rr.processedAt!.getTime() + 24 * 3_600_000);
          await tx.refund.create({ data: { paymentId: payment.id, orderCode: s.code, returnRequestId: rr.id, amount: refund.toString(), status: 'done', method: 'manual_transfer', providerRef: `HT${refundedAt.getTime().toString().slice(-8)}`, reason: 'Đổi trả được duyệt', requestedBy: staffId('sales'), processedBy: staffId('accountant'), processedAt: refundedAt, createdAt: rr.processedAt! } });
          await tx.payment.update({ where: { id: payment.id }, data: { refundedAmount: refund.toString() } });
          await tx.paymentTransaction.create({ data: { paymentId: payment.id, type: 'refund', status: 'ok', amount: refund.toString(), providerRef: `HT${refundedAt.getTime().toString().slice(-8)}`, createdAt: refundedAt } });
        }
      }
      return o;
    });
    void order;
    created += 1;
  }
  console.log(`   đơn hàng: ${SPECS.length} (tạo mới ${created}) — pending/confirmed/packing/shipping/delivered/completed/cancelled + đổi trả`);
}
