import { Injectable } from '@nestjs/common';
import { BusinessException } from '@common/exception/business.exception';
import type { ShippingAddress, ShippingParcel, ShippingSnapshot } from '@common/gateway/order-shipping.gateway';
import { IdempotencyService } from '@common/idempotency/idempotency.service';
import { ProductQueryApi } from '@modules/product/queryapi/product.queryapi';
import { ShopQueryApi } from '@modules/shop/queryapi/shop.queryapi';
import { ShippingApplicationApi } from '@modules/shipping/applicationapi/shipping.applicationapi';
import { ShippingQueryApi } from '@modules/shipping/queryapi/shipping.queryapi';

export interface CarrierQuote {
  id: string; fingerprint: string; shippingFee: string; feeSource: string; expiresAt: string;
  provider: string; environment: string; snapshot: ShippingSnapshot;
}
export interface ShippingCheckoutAddress {
  recipientName: string; phone: string; provinceName: string; districtName: string | null; wardName: string | null; street: string;
  addressSystem?: string; ghnProvinceId?: number | null; ghnDistrictId?: number | null; ghnWardCode?: string | null;
}
export interface CarrierPricingContext {
  address: ShippingCheckoutAddress; methodCode: string; quoteIds?: string[];
  prepared?: Map<string, CarrierQuote | null>;
}

/*
 * Chốt báo phí và snapshot ngoài transaction đặt đơn. Lần đọc trong transaction chỉ kiểm fingerprint
 * với báo giá đã chuẩn bị; tuyệt đối không gọi HTTP hãng khi đang giữ khoá kho/voucher.
 */
@Injectable()
export class OrderShippingPricingService {
  constructor(private readonly shops: ShopQueryApi, private readonly products: ProductQueryApi,
    private readonly commands: ShippingApplicationApi, private readonly queries: ShippingQueryApi) {}

  static address(a: ShippingCheckoutAddress): ShippingAddress {
    if (!a.ghnProvinceId || !a.ghnDistrictId || !a.ghnWardCode || !a.districtName || !a.wardName) {
      throw new BusinessException('SHIPMENT_ADDRESS_REQUIRED', 'Vui lòng chọn tỉnh, quận và phường theo danh mục giao hàng cho địa chỉ nhận');
    }
    return { name: a.recipientName, phone: a.phone, street: a.street, provinceName: a.provinceName,
      districtName: a.districtName, wardName: a.wardName, provinceId: a.ghnProvinceId,
      districtId: a.ghnDistrictId, wardCode: a.ghnWardCode, addressSystem: 'legacy_3level' };
  }

  async resolve(userId: string, shopId: string, lines: Array<{ variantId: string; quantity: number; unitPrice: bigint }>,
    subtotal: bigint, fallbackFee: bigint, ctx: CarrierPricingContext): Promise<CarrierQuote | null> {
    const shop = await this.shops.findBrief(shopId);
    const previous = ctx.prepared?.get(shopId);
    if (!shop?.shippingCarrierEnabled) {
      if (previous) throw new BusinessException('ORDER_SHIPPING_QUOTE_CHANGED', 'Phương thức giao hàng vừa thay đổi, vui lòng xem lại báo giá', 409);
      return null;
    }
    if (!shop.shippingPickup) throw new BusinessException('SHIPMENT_PICKUP_REQUIRED', 'Gian hàng chưa cấu hình địa chỉ lấy hàng');
    const pickup = shop.shippingPickup as ShippingAddress;
    const destination = OrderShippingPricingService.address(ctx.address);
    const variants = await this.products.variantSnapshots(lines.map((l) => l.variantId));
    const parcel: ShippingParcel = { weightGram: 0, lengthCm: 0, widthCm: 0, heightCm: 0 };
    for (const line of lines) {
      const v = variants.get(line.variantId);
      parcel.weightGram += (v?.weightGram ?? 500) * line.quantity;
      parcel.lengthCm = Math.max(parcel.lengthCm, v?.lengthCm ?? 20);
      parcel.widthCm = Math.max(parcel.widthCm, v?.widthCm ?? 15);
      parcel.heightCm += (v?.heightCm ?? 10) * line.quantity;
    }
    if (parcel.weightGram <= 0 || parcel.weightGram >= 20_000 || Math.max(parcel.lengthCm, parcel.widthCm, parcel.heightCm) > 200) {
      throw new BusinessException('SHIPMENT_PARCEL_UNSUPPORTED', 'Kiện hàng vượt giới hạn giao hàng; vui lòng giảm số lượng hoặc tách lần đặt');
    }
    const fingerprint = IdempotencyService.hashRequest({ shopId, pickup, destination, returnAddress:shop.shippingReturn ?? pickup, parcel, method: ctx.methodCode, provider:process.env.SHIPPING_CARRIER ?? 'fake', environment:process.env.GHN_BASE_URL ?? 'staging',accountScope:process.env.GHN_SHOP_ID ?? 'demo', codValue:ctx.methodCode==='cod'?(subtotal+fallbackFee).toString():'0',
      lines: lines.map((l) => [l.variantId, l.quantity, l.unitPrice.toString()]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))) });
    if (ctx.prepared) {
      if (!previous || previous.fingerprint !== fingerprint || Date.parse(previous.expiresAt) <= Date.now()) {
        throw new BusinessException('ORDER_SHIPPING_QUOTE_CHANGED', 'Thông tin giao hàng vừa thay đổi, vui lòng xem lại báo giá', 409);
      }
      return previous;
    }
    for (const id of ctx.quoteIds ?? []) {
      const q = await this.queries.quote(id, userId);
      if (q && q.shopId === shopId && q.fingerprint === fingerprint && Date.parse(q.expiresAt) > Date.now()) return q;
    }
    return this.commands.quote({ userId, shopId, pickup, destination,
      returnAddress: (shop.shippingReturn ?? pickup) as ShippingAddress, parcel,
      codValue: ctx.methodCode === 'cod' ? (subtotal + fallbackFee).toString() : '0', fallbackFee: fallbackFee.toString(), fingerprint });
  }
}
