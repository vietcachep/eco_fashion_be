import type { PrismaClient } from '../../src/generated/prisma/client';

/*
 * Chỉ cấu hình điểm lấy demo khi người chạy chọn hãng fake rõ ràng. Không tạo vận đơn/quote/sổ tiền
 * mẫu, không bật giả lập ở production và không ghi đè pickup mà chủ shop đã cấu hình.
 */
export async function seed(prisma: PrismaClient): Promise<void> {
  if (process.env.SHIPPING_CARRIER !== 'fake' || process.env.NODE_ENV === 'production') {
    console.log('   shipping: bỏ qua cấu hình demo (chỉ bật khi SHIPPING_CARRIER=fake, ngoài production)');
    return;
  }
  const fixtures = [
    { slug: 'techzone-vn', provinceId: 202, provinceName: 'Hồ Chí Minh', districtId: 1442, districtName: 'Quận 1', wardCode: '20101', wardName: 'Phường Bến Nghé' },
    { slug: 'mobile-hub', provinceId: 201, provinceName: 'Hà Nội', districtId: 1485, districtName: 'Quận Ba Đình', wardCode: '10301', wardName: 'Phường Phúc Xá' },
  ];
  let configured = 0;
  for (const f of fixtures) {
    const shop = await prisma.shop.findUnique({ where: { slug: f.slug } });
    if (!shop || shop.status !== 'approved' || shop.shippingPickup) continue;
    const { slug: _slug, ...location } = f;
    const pickup = { ...location, name: shop.name, phone: '0901234567', street: '12 Đường cửa hàng demo', addressSystem: 'legacy_3level' };
    await prisma.shop.update({ where: { id: shop.id }, data: { shippingCarrierEnabled: true,
      shippingPickup: pickup, shippingReturn: pickup } });
    configured++;
  }
  console.log(`   shipping: ${configured} pickup demo mới, giữ nguyên cấu hình đã có`);
}
