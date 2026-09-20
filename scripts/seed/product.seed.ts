/*
 * SEED module product: 24 sản phẩm quần áo (trùng mock FE) — biến thể màu × size, ảnh theo màu (Pexels, chọn tay đúng tên,
 * scripts/seed/assets/product/<slug>/), tồn kho qua MỘT phiếu nhập đã duyệt `PN-SEED-0001` (có sổ kho), đăng bán ngay.
 * Idempotent: sản phẩm tồn tại theo slug → bỏ qua hoàn toàn (không đụng tồn/ảnh đã sửa tay). Cần catalog.seed chạy trước.
 */
import { makeSku } from '../../src/common/utils/slug';
import { loadEnv } from '../../src/config/env';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { COLORS } from './catalog.seed';
import { SeedImages } from './lib/seed-images';

const SIZE_AO = ['S', 'M', 'L', 'XL'];
const SIZE_QUAN = ['28', '29', '30', '31', '32'];
const SIZE_NU = ['S', 'M', 'L'];
const SIZE_QUAN_NU = ['26', '27', '28', '29', '30'];
const CARE = ['Giặt máy nước lạnh', 'Không dùng chất tẩy', 'Phơi trong bóng râm', 'Ủi nhiệt độ thấp'];

interface SeedProduct {
  slug: string;
  name: string;
  cat: string;
  gender: 'nam' | 'nu' | 'unisex';
  gia: number;
  giaGoc?: number;
  mau: string[];
  size: string[];
  rating: number;
  reviews: number;
  sold: number;
  moi?: boolean;
  moTaNgan: string;
  chatLieu: string;
}

export const PRODUCTS: SeedProduct[] = [
  { slug: 'ao-thun-cotton-nam-basic', name: 'Áo thun cotton nam basic', cat: 'ao-thun', gender: 'nam', gia: 159000, giaGoc: 199000, mau: ['trang', 'den', 'xam'], size: SIZE_AO, rating: 4.7, reviews: 128, sold: 940, moTaNgan: 'Cotton 100%, form regular, thoáng mát cho ngày dài.', chatLieu: '100% cotton' },
  { slug: 'ao-thun-oversize-nam', name: 'Áo thun oversize nam', cat: 'ao-thun', gender: 'nam', gia: 189000, mau: ['den', 'be'], size: SIZE_AO, rating: 4.5, reviews: 64, sold: 410, moi: true, moTaNgan: 'Form rộng thoải mái, vải dày dặn không xuyên thấu.', chatLieu: 'Cotton 2 chiều 220gsm' },
  { slug: 'ao-thun-polo-nam', name: 'Áo polo nam cổ bẻ', cat: 'ao-thun', gender: 'nam', gia: 249000, giaGoc: 299000, mau: ['xanh', 'trang', 'xanhla'], size: SIZE_AO, rating: 4.6, reviews: 87, sold: 520, moTaNgan: 'Vải cá sấu co giãn, đứng form, mặc đi làm hay đi chơi đều hợp.', chatLieu: 'Cotton pique' },
  { slug: 'ao-thun-croptop-nu', name: 'Áo thun croptop nữ', cat: 'ao-thun', gender: 'nu', gia: 139000, mau: ['trang', 'hong', 'den'], size: SIZE_NU, rating: 4.8, reviews: 203, sold: 1250, moi: true, moTaNgan: 'Dáng ngắn tôn eo, phối cùng quần cạp cao rất hợp.', chatLieu: 'Cotton spandex' },
  { slug: 'ao-thun-nu-form-rong', name: 'Áo thun nữ form rộng', cat: 'ao-thun', gender: 'nu', gia: 149000, giaGoc: 179000, mau: ['be', 'xam', 'trang'], size: SIZE_AO, rating: 4.4, reviews: 56, sold: 380, moTaNgan: 'Thoải mái cho ngày cuối tuần, vải mềm không bai.', chatLieu: '100% cotton' },
  { slug: 'ao-thun-in-hinh-unisex', name: 'Áo thun in hình unisex', cat: 'ao-thun', gender: 'unisex', gia: 169000, mau: ['trang', 'den'], size: SIZE_AO, rating: 4.3, reviews: 41, sold: 260, moTaNgan: 'Hình in bền màu, giặt máy không bong.', chatLieu: 'Cotton 2 chiều' },
  { slug: 'ao-so-mi-nam-cong-so', name: 'Áo sơ mi nam công sở', cat: 'ao-so-mi', gender: 'nam', gia: 329000, giaGoc: 399000, mau: ['trang', 'xanh'], size: SIZE_AO, rating: 4.7, reviews: 96, sold: 610, moTaNgan: 'Vải chống nhăn, dáng slim, mặc cả ngày vẫn phẳng.', chatLieu: 'Cotton pha polyester' },
  { slug: 'ao-so-mi-nam-linen', name: 'Áo sơ mi nam linen', cat: 'ao-so-mi', gender: 'nam', gia: 359000, mau: ['be', 'trang'], size: SIZE_AO, rating: 4.5, reviews: 38, sold: 190, moi: true, moTaNgan: 'Linen mát, hợp mùa hè, càng giặt càng mềm.', chatLieu: '100% linen' },
  { slug: 'ao-so-mi-nu-tay-phong', name: 'Áo sơ mi nữ tay phồng', cat: 'ao-so-mi', gender: 'nu', gia: 289000, mau: ['trang', 'hong'], size: SIZE_NU, rating: 4.6, reviews: 72, sold: 440, moTaNgan: 'Tay phồng nhẹ, cổ đức, nữ tính mà vẫn gọn gàng.', chatLieu: 'Cotton lụa' },
  { slug: 'ao-so-mi-nu-form-rong', name: 'Áo sơ mi nữ form rộng', cat: 'ao-so-mi', gender: 'nu', gia: 269000, giaGoc: 319000, mau: ['trang', 'xanh', 'be'], size: SIZE_AO, rating: 4.4, reviews: 51, sold: 300, moTaNgan: 'Dáng boyfriend, sơ vin hay thả đều đẹp.', chatLieu: 'Cotton' },
  { slug: 'quan-jean-nam-slim-fit', name: 'Quần jean nam slim fit', cat: 'quan-jean', gender: 'nam', gia: 449000, giaGoc: 549000, mau: ['denim', 'den'], size: SIZE_QUAN, rating: 4.6, reviews: 143, sold: 780, moTaNgan: 'Denim co giãn, ôm vừa phải, không bó gối.', chatLieu: 'Denim 98% cotton 2% spandex' },
  { slug: 'quan-jean-nam-straight', name: 'Quần jean nam ống đứng', cat: 'quan-jean', gender: 'nam', gia: 429000, mau: ['denim', 'xam'], size: SIZE_QUAN, rating: 4.5, reviews: 67, sold: 350, moTaNgan: 'Ống đứng cổ điển, phối được với mọi kiểu áo.', chatLieu: 'Denim 100% cotton' },
  { slug: 'quan-jean-nu-ong-rong', name: 'Quần jean nữ ống rộng', cat: 'quan-jean', gender: 'nu', gia: 399000, mau: ['denim', 'trang'], size: SIZE_QUAN_NU, rating: 4.8, reviews: 189, sold: 920, moi: true, moTaNgan: 'Cạp cao ống rộng, kéo dài chân, đang rất được ưa chuộng.', chatLieu: 'Denim co giãn' },
  { slug: 'quan-jean-nu-skinny', name: 'Quần jean nữ skinny', cat: 'quan-jean', gender: 'nu', gia: 379000, giaGoc: 429000, mau: ['denim', 'den'], size: SIZE_QUAN_NU, rating: 4.4, reviews: 84, sold: 460, moTaNgan: 'Ôm dáng, co giãn 4 chiều, ngồi lâu không cấn.', chatLieu: 'Denim 4 chiều' },
  { slug: 'quan-short-kaki-nam', name: 'Quần short kaki nam', cat: 'quan-short', gender: 'nam', gia: 219000, mau: ['be', 'xanh', 'xanhla'], size: SIZE_QUAN, rating: 4.5, reviews: 58, sold: 330, moTaNgan: 'Kaki mềm, dài ngang gối, hợp đi biển lẫn đi phố.', chatLieu: 'Kaki cotton' },
  { slug: 'quan-short-jean-nu', name: 'Quần short jean nữ', cat: 'quan-short', gender: 'nu', gia: 199000, giaGoc: 249000, mau: ['denim', 'trang'], size: ['26', '27', '28', '29'], rating: 4.6, reviews: 77, sold: 410, moTaNgan: 'Cạp cao, gấu tua nhẹ, mặc với áo thun là đủ đẹp.', chatLieu: 'Denim' },
  { slug: 'chan-vay-xep-ly', name: 'Chân váy xếp ly', cat: 'vay', gender: 'nu', gia: 259000, mau: ['den', 'be', 'xam'], size: SIZE_NU, rating: 4.7, reviews: 112, sold: 560, moTaNgan: 'Ly nhỏ đều, dáng chữ A, xoè nhẹ khi bước đi.', chatLieu: 'Vải tuyết mưa' },
  { slug: 'chan-vay-jean-ngan', name: 'Chân váy jean ngắn', cat: 'vay', gender: 'nu', gia: 229000, giaGoc: 279000, mau: ['denim'], size: SIZE_NU, rating: 4.3, reviews: 45, sold: 240, moi: true, moTaNgan: 'Denim dày, có túi thật, trẻ trung năng động.', chatLieu: 'Denim' },
  { slug: 'dam-suong-nu-basic', name: 'Đầm suông nữ basic', cat: 'dam', gender: 'nu', gia: 349000, giaGoc: 429000, mau: ['den', 'be', 'xanh'], size: SIZE_NU, rating: 4.8, reviews: 156, sold: 690, moTaNgan: 'Dáng suông che khuyết điểm, mặc đi làm hay đi chơi đều hợp.', chatLieu: 'Vải đũi' },
  { slug: 'dam-hoa-nhi-vintage', name: 'Đầm hoa nhí vintage', cat: 'dam', gender: 'nu', gia: 389000, mau: ['hong', 'xanhla'], size: SIZE_NU, rating: 4.6, reviews: 93, sold: 420, moi: true, moTaNgan: 'Hoạ tiết hoa nhí, tay bồng, chất vải mềm rủ.', chatLieu: 'Voan lót lụa' },
  { slug: 'dam-du-tiec-body', name: 'Đầm dự tiệc dáng ôm', cat: 'dam', gender: 'nu', gia: 549000, giaGoc: 699000, mau: ['den', 'do'], size: SIZE_NU, rating: 4.9, reviews: 61, sold: 210, moTaNgan: 'Ôm dáng tôn vóc, xẻ tà kín đáo, cho những buổi tối đặc biệt.', chatLieu: 'Thun lụa cao cấp' },
  { slug: 'ao-khoac-bomber-nam', name: 'Áo khoác bomber nam', cat: 'ao-khoac', gender: 'nam', gia: 499000, mau: ['den', 'xanhla'], size: SIZE_AO, rating: 4.6, reviews: 74, sold: 310, moTaNgan: 'Bo tay bo gấu, lót lưới thoáng, không quá nóng.', chatLieu: 'Vải dù 2 lớp' },
  { slug: 'ao-khoac-du-chong-nuoc', name: 'Áo khoác dù chống nước', cat: 'ao-khoac', gender: 'unisex', gia: 459000, giaGoc: 559000, mau: ['den', 'xanh', 'xam'], size: SIZE_AO, rating: 4.5, reviews: 88, sold: 470, moTaNgan: 'Chống nước nhẹ, có mũ, gấp gọn được bỏ túi.', chatLieu: 'Vải dù chống thấm' },
  { slug: 'ao-khoac-blazer-nu', name: 'Áo khoác blazer nữ', cat: 'ao-khoac', gender: 'nu', gia: 599000, mau: ['be', 'den', 'xam'], size: SIZE_NU, rating: 4.8, reviews: 67, sold: 280, moi: true, moTaNgan: 'Vai đệm nhẹ, dáng dài qua hông, sang mà không cứng.', chatLieu: 'Tuyết mưa dày' },
];

const colorByCode = new Map(COLORS.map((c) => [c.code, c]));

function moTaDai(p: SeedProduct): string {
  return `${p.moTaNgan}\n\nThiết kế tối giản, dễ phối đồ, phù hợp nhiều hoàn cảnh. Chất liệu ${p.chatLieu.toLowerCase()} được chọn kỹ để giữ form sau nhiều lần giặt. Sản phẩm có đủ size, tham khảo bảng size bên dưới để chọn đúng.`;
}

/* Tồn kho giả nhưng xác định (không random) — vài tổ hợp = 0 để màn chi tiết có ca "hết size". */
function tonKho(i: number, j: number): number {
  return (i + j) % 7 === 0 ? 0 : 5 + ((i * 3 + j * 5) % 20);
}

export async function seed(prisma: PrismaClient): Promise<void> {
  const images = new SeedImages(loadEnv());
  const categories = new Map((await prisma.category.findMany({ where: { isDeleted: false }, select: { id: true, slug: true } })).map((c) => [c.slug, c.id]));
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { ASSETS_DIR } = await import('./lib/seed-images');

  let created = 0;
  const receiptItems: Array<{ variantId: string; sku: string; quantity: number; unitCost: bigint; productId: string }> = [];
  for (const [i, p] of PRODUCTS.entries()) {
    const exists = await prisma.product.findFirst({ where: { slug: p.slug, isDeleted: false }, select: { id: true } });
    if (exists) continue;
    const categoryId = categories.get(p.cat);
    if (!categoryId) throw new Error(`Thiếu ngành hàng ${p.cat} — chạy catalog.seed trước`);

    // ảnh: main, hover, mau-<code> (nếu có file)
    const dir = path.join(ASSETS_DIR, 'product', p.slug);
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')) : [];
    const order = ['main.jpg', 'hover.jpg', ...files.filter((f) => f.startsWith('mau-')).sort()];
    const imageRows: Array<{ url: string; publicId: string | null; colorCode: string | null; alt: string; sortOrder: number; isPrimary: boolean }> = [];
    const mainColor = p.mau[0];
    for (const [k, f] of order.filter((f) => files.includes(f)).entries()) {
      const img = await images.resolve(`product/${p.slug}/${f}`);
      const colorCode = f.startsWith('mau-') ? f.slice(4, -4) : f === 'main.jpg' ? mainColor : null;
      imageRows.push({ url: img.url, publicId: img.publicId, colorCode: colorCode && p.mau.includes(colorCode) ? colorCode : null, alt: p.name, sortOrder: k, isPrimary: k === 0 });
    }
    const product = await prisma.product.create({
      data: {
        slug: p.slug,
        name: p.name,
        categoryId,
        categorySlug: p.cat,
        gender: p.gender,
        shortDescription: p.moTaNgan,
        description: moTaDai(p),
        material: p.chatLieu,
        care: CARE,
        basePrice: String(p.gia),
        listPrice: p.giaGoc ? String(p.giaGoc) : null,
        status: 'active',
        isNew: Boolean(p.moi),
        isFeatured: p.sold >= 600,
        tags: [...(p.moi ? ['new'] : []), ...(p.giaGoc ? ['sale'] : [])],
        soldCount: p.sold,
        reviewCount: 0, // review.seed sẽ tạo đánh giá thật và cập nhật avg/review_count
        avgRating: '0',
        publishedAt: new Date(Date.now() - (PRODUCTS.length - i) * 86_400_000),
        images: { create: imageRows },
        variants: {
          create: p.mau.flatMap((m) =>
            p.size.map((s) => {
              const color = colorByCode.get(m)!;
              return { sku: makeSku(p.slug, m, s), colorCode: m, colorName: color.name, colorHex: color.hex, sizeCode: s, isActive: true, stock: 0, reserved: 0 };
            }),
          ),
        },
      },
      select: { id: true, variants: { select: { id: true, sku: true, colorCode: true, sizeCode: true } } },
    });
    await prisma.category.update({ where: { id: categoryId }, data: { productCount: { increment: 1 } } });
    for (const v of product.variants) {
      const mi = p.mau.indexOf(v.colorCode);
      const si = p.size.indexOf(v.sizeCode);
      const qty = tonKho(i + 1, mi * 10 + si + 1);
      if (qty > 0) receiptItems.push({ variantId: v.id, sku: v.sku, quantity: qty, unitCost: BigInt(Math.round(p.gia * 0.55)), productId: product.id });
    }
    created += 1;
  }
  console.log(`   sản phẩm: ${PRODUCTS.length} (tạo mới ${created})`);

  if (receiptItems.length > 0) {
    const code = `PN-SEED-${String((await prisma.stockReceipt.count()) + 1).padStart(4, '0')}`;
    await prisma.$transaction(async (tx) => {
      const receipt = await tx.stockReceipt.create({
        data: {
          code,
          supplierName: 'Xưởng may Minh Anh (seed)',
          note: 'Nhập kho ban đầu — dữ liệu mẫu',
          status: 'posted',
          postedAt: new Date(),
          totalCost: receiptItems.reduce((s, it) => s + BigInt(it.quantity) * it.unitCost, 0n).toString(),
          items: { create: receiptItems.map((it) => ({ variantId: it.variantId, sku: it.sku, quantity: it.quantity, unitCost: it.unitCost.toString() })) },
        },
        select: { id: true },
      });
      for (const it of receiptItems) {
        await tx.productVariant.update({ where: { id: it.variantId }, data: { stock: it.quantity } });
        await tx.stockMovement.create({ data: { productId: it.productId, variantId: it.variantId, type: 'RECEIPT', quantity: it.quantity, stockAfter: it.quantity, refType: 'stock_receipt', refId: code, note: 'seed' } });
      }
      void receipt;
    });
    console.log(`   phiếu nhập ${code}: ${receiptItems.length} dòng (đã duyệt, có sổ kho)`);
  }
}
