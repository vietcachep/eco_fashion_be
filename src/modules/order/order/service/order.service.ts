import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { BusinessException, ForbiddenException, NotFoundException } from '@common/exception/business.exception';
import { CART_GATEWAY, CartGateway } from '@common/gateway/cart.gateway';
import { INVENTORY_GATEWAY, InsufficientStockError, InventoryGateway } from '@common/gateway/inventory.gateway';
import { NOTIFICATION_GATEWAY, NotificationGateway } from '@common/gateway/notification.gateway';
import { PAYMENT_GATEWAY, PaymentGateway } from '@common/gateway/payment.gateway';
import { PRODUCT_STATS_GATEWAY, ProductStatsGateway } from '@common/gateway/product-stats.gateway';
import { PROMOTION_GATEWAY, PromotionGateway, PromotionQuote } from '@common/gateway/promotion.gateway';
import { USER_DIRECTORY_GATEWAY, UserDirectoryGateway } from '@common/gateway/user-directory.gateway';
import { IdempotencyService } from '@common/idempotency/idempotency.service';
import { PrismaService } from '@common/prisma/prisma.service';
import { Prisma, Tx } from '@common/prisma/types';
import { RequestTraceContext } from '@common/request/request-trace.context';
import { PageResponse } from '@common/response/api-response';
import { money } from '@common/response/money-response';
import { vnd } from '@common/utils/money';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { Basket, CartQueryApi } from '../../../cart/queryapi/cart.queryapi';
import { AddressBrief, IdentityQueryApi } from '../../../identity/queryapi/identity.queryapi';
import { PaymentQueryApi } from '../../../payment/queryapi/payment.queryapi';
import { ShopBrief, ShopQueryApi } from '../../../shop/queryapi/shop.queryapi';
import { SETTING_KEY } from '../../../system/enums/setting-keys';
import { SystemQueryApi } from '../../../system/queryapi/system.queryapi';
import { OrderAuditLogService } from '../../audit/order-audit-log.service';
import { commissionBase } from '../../foundation/commission';
import { carrierName, resolveShippingProof } from '../../foundation/delivery.rules';
import { DELIVERY_FAILED_CUSTOMER_FAULT, GOODS_RETURN_WINDOW_DAYS } from '../../foundation/order.constants';
import { inferCancelSource, resolveCancelReason } from '../../foundation/cancel.rules';
import { CANCEL_REQUEST_STATUS, CANCEL_SOURCE, CANCEL_SOURCE_LABEL, type CancelRequestStatus, type CancelSource } from '../../foundation/order.constants';
import { DELIVERY_FAILED_LABEL, ORDER_AUDIT, ORDER_ERR, ORDER_EVENT, ORDER_STATUS, PAYMENT_METHOD, PAYMENT_STATUS, STAFF_TRANSITIONS, STATUS_LABEL, type DeliveryFailedReason } from '../../foundation/order.constants';
import { OrderOutboxService } from '../../outbox/order-outbox.service';
import { refundReason } from '../../return/return.rules';
import { CheckoutSummaryResponse, OrderGroupResponse, OrderResponse, OrderSummaryResponse } from '../dto/order.responses';
import { toOrderGroupResponse, toOrderResponse, toOrderSummary } from '../mapper/order.mapper';
import { OrderListFilter, OrderRepository, OrderRow } from '../repository/order.repository';

import { OrderShippingPricingService, type CarrierQuote, type CarrierPricingContext } from '../../shipping/order-shipping-pricing.service';
import { ShippingApplicationApi } from '@modules/shipping/applicationapi/shipping.applicationapi';
import { ShippingQueryApi } from '@modules/shipping/queryapi/shipping.queryapi';
import type { ShippingSnapshot, ShippingOrderSnapshot, CarrierOrderUpdate } from '@common/gateway/order-shipping.gateway';
import { CheckoutIntentRepository } from '../../checkout/checkout-intent.repository';
import { allocateLiveLines, type LiveLineAllocation } from '../../checkout/live-allocation';

export interface CheckoutAddress {
  addressSystem?: string; ghnProvinceId?: number | null; ghnDistrictId?: number | null; ghnWardCode?: string | null;
  recipientName: string;
  phone: string;
  provinceCode: string | null;
  provinceName: string;
  districtName: string | null;
  wardName: string | null;
  street: string;
}

export interface PlaceOrderInput {
  checkoutIntentId?: string;
  quoteIds?: string[];
  addressId?: string;
  address?: CheckoutAddress;
  paymentMethodCode: string;
  note?: string;
  /* Mã khách nhập: tối đa 1 mã SÀN + 1 mã GIAN HÀNG cho mỗi shop trong giỏ (voucherCode + voucherCodes gộp, bỏ trùng). */
  voucherCode?: string | null;
  voucherCodes?: string[];
  /* CK-05: tổng tiền cả lần đặt khách đã thấy (số nguyên VND dạng chuỗi). Chỉ để SO với số server tự tính lúc đặt — không bao giờ dùng làm số tiền thật. Bỏ trống ⇒ không kiểm. */
  expectedTotal?: string | null;
}

/*
 * CK-05 (PLAN-0032 §2.1) — tín hiệu nội bộ "giá đã đổi so với điều khách thấy", ném TRONG transaction đặt hàng để rollback sạch (không đơn, không giữ kho,
 * không voucher, không ghi idempotency) rồi được đổi thành 409 ORDER_PRICE_CHANGED NGOÀI transaction: báo giá mới cần thêm vài lượt đọc (tên shop, COD) và
 * không nên giữ kết nối + khoá DB trong lúc đó. `priced` rỗng ⇒ lỗi phát hiện muộn (chốt voucher hụt) nên phải tính lại báo giá cho đúng thực tế mới;
 * `fallback` là lỗi nghiệp vụ gốc sẽ ném nếu tính lại mà tổng vẫn khớp `expected` (không có "giá đổi" thật để báo).
 */
class PriceChangedSignal extends Error {
  constructor(
    readonly expected: bigint,
    readonly priced: Priced | null,
    readonly fallback: BusinessException | null = null,
  ) {
    super('ORDER_PRICE_CHANGED');
    this.name = 'PriceChangedSignal';
  }
}

/* Một gói hàng theo shop trong giỏ (PLAN-0014 bước 7) — 1 gói = 1 Order con sau này. Phí ship tính RIÊNG
   theo subtotal của gói này (bảng giá vẫn dùng chung toàn sàn — quyết định "shipping fee shared platform
   table" — nhưng SỐ TIỀN phải tính theo từng gói vì mỗi shop giao hàng độc lập, khác gói vận đơn). */
interface ShopGroupPriced {
  carrierQuote?: CarrierQuote | null;
  shopId: string;
  lines: Basket['lines'];
  subtotal: bigint;
  shippingFee: bigint;
}

/* Gói đã trừ voucher: shopDiscount do SHOP chịu, platformDiscount do SÀN chịu (phần phân bổ của voucher sàn). */
interface PricedGroup extends ShopGroupPriced {
  lineAllocations?:Map<string,LiveLineAllocation>;
  shopDiscount: bigint;
  platformDiscount: bigint;
  /* PLAN-0030: phần của mỗi loại giảm rơi vào PHÍ SHIP (voucher freeship) — hoa hồng không tính trên phí ship. */
  shopShippingDiscount: bigint;
  platformShippingDiscount: bigint;
  discount: bigint;
  total: bigint;
}

/* Kết quả quote một mã: shopId = null là mã sàn. Mã lỗi vẫn giữ để báo lý do cho khách. */
interface VoucherPlan {
  shopId: string | null;
  quote: PromotionQuote;
}

interface Priced {
  basket: Basket;
  groups: PricedGroup[];
  subtotal: bigint;
  shippingFee: bigint;
  province: { code: string; name: string } | null;
  vouchers: VoucherPlan[];
  discount: bigint;
  total: bigint;
  warnings: string[];
}

/*
 * Đơn hàng (PLAN-0006). Đặt hàng = MỘT transaction: giỏ (dòng tick, còn bán, đủ tồn) → snapshot dòng → phí ship (tỉnh) →
 * mã KM consume → mã đơn (sequence khoá) → tạo đơn + lịch sử → giữ kho (reserve) → xoá dòng giỏ → khởi tạo thanh toán
 * (COD/PayOS URL) → thông báo tổng cho khách + outbox ORDER_CREATED (mail khách + thông báo shop; KHÔNG báo nhân viên sàn theo từng đơn — NTF-03) → idempotency complete.
 * Idempotency-Key: gửi lại cùng key → trả đúng đơn cũ, KHÔNG tạo đơn/giữ kho hai lần. Tiền: server tính toàn bộ.
 */
@Injectable()
export class OrderService {
  simulatedOrderCodes(codes: string[]): Promise<ReadonlySet<string>> { return this.repo.simulatedOrderCodes(codes); }
  private readonly logger = new Logger(OrderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: OrderRepository,
    private readonly audit: OrderAuditLogService,
    private readonly outbox: OrderOutboxService,
    private readonly cart: CartQueryApi,
    private readonly identity: IdentityQueryApi,
    private readonly system: SystemQueryApi,
    private readonly payments: PaymentQueryApi,
    private readonly shops: ShopQueryApi,
    @Inject(INVENTORY_GATEWAY) private readonly inventory: InventoryGateway,
    @Inject(PROMOTION_GATEWAY) private readonly promotion: PromotionGateway,
    @Inject(PAYMENT_GATEWAY) private readonly payment: PaymentGateway,
    @Inject(CART_GATEWAY) private readonly cartWrite: CartGateway,
    @Inject(NOTIFICATION_GATEWAY) private readonly notify: NotificationGateway,
    @Inject(PRODUCT_STATS_GATEWAY) private readonly productStats: ProductStatsGateway,
    @Inject(USER_DIRECTORY_GATEWAY) private readonly users: UserDirectoryGateway,
    @Optional() private readonly shippingPricing?: OrderShippingPricingService,
    @Optional() private readonly shippingCommands?: ShippingApplicationApi,
    @Optional() private readonly shippingQueries?: ShippingQueryApi,
    @Optional() private readonly checkoutIntents?: CheckoutIntentRepository,
  ) {}

  /* Sự kiện hãng đã xác minh: caller giữ ĐƠN/SHIPMENT, tất cả side-effect cùng tx inbox. */
  async applyCarrierUpdate(snapshot:ShippingOrderSnapshot,input:CarrierOrderUpdate,tx:Tx):Promise<void> {
    const o=await this.repo.findByCodeForUpdate(snapshot.code,tx);
    if(!o || o.fulfilmentMode!=='carrier') throw new BusinessException('SHIPMENT_ORDER_INVALID','Đơn không thuộc tuyến hãng',409);
    const now=new Date(); const status=input.status;
    if(status==='cancelled') {
      if(o.status === ORDER_STATUS.CANCELLED) return;
      if((input as CarrierOrderUpdate & {cancelRequested?:boolean}).cancelRequested) {
        if (await this.repo.hasOpenReturn(o.id, tx)) throw new BusinessException(ORDER_ERR.HAS_OPEN_RETURN, 'Đơn đang có yêu cầu đổi trả chưa xử lý xong — hãy xử lý yêu cầu đó trước', 409);
        await this.doCancel(o,'Đã huỷ yêu cầu vận chuyển trước khi lấy hàng',null,tx,{restock:true,source:CANCEL_SOURCE.SYSTEM,reasonCode:'other'}); return;
      }
      if(o.status!==ORDER_STATUS.SHIPPING) return;
      await this.repo.update(o.id,{status:ORDER_STATUS.PACKING,shipDueAt:await this.slaDueAt(SETTING_KEY.ORDER_SHOP_SHIP_HOURS,48),trackingCode:null,trackingUrl:null,carrier:null},tx);
      await this.repo.addHistory(o.id,o.status,ORDER_STATUS.PACKING,'Hãng huỷ lấy hàng — shop có thể tạo yêu cầu mới',null,tx);
    } else if(status==='returned') {
      if([ORDER_STATUS.CANCELLED,ORDER_STATUS.RETURNED].includes(o.status as 'cancelled'|'returned') && o.goodsReturnedAt) return;
      if(o.status!==ORDER_STATUS.SHIPPING) throw new BusinessException('SHIPMENT_RETURN_CONFLICT','Cần đối chiếu trạng thái trả hàng với CSKH',409);
      if(await this.repo.hasOpenReturn(o.id,tx)) {
        if(!(await this.repo.hasOpenNotReceived(o.id,tx))) throw new BusinessException(ORDER_ERR.HAS_OPEN_RETURN,'Đơn có tranh chấp đang mở — cần xử lý trước',409);
        if(!o.goodsReturnedAt) await this.inventory.restock(o.items.map((i)=>({variantId:i.variantId,quantity:i.quantity})),{type:'order',id:o.code},tx);
        await this.repo.update(o.id,{goodsReturnedAt:o.goodsReturnedAt ?? now,deliveryFailedAt:o.deliveryFailedAt ?? now,shippingSnapshot:{...(o.shippingSnapshot as Prisma.JsonObject),verifiedCarrierStatus:'returned'}},tx);
        await this.audit.write(tx,null,{action:'CARRIER_RETURN_VERIFIED',entityType:'order',entityId:o.id,entityCode:o.code,after:{shipmentId:input.shipmentId,pendingDispute:true}});
        return; // Inbox giữ retry tới khi yêu cầu được giải quyết/rút; không khoá request ngược chiều.
      }
      await this.doCancel(o,'Hãng xác nhận đã trả hàng về shop',null,tx,{restock:!o.goodsReturnedAt,source:CANCEL_SOURCE.SYSTEM,reasonCode:'other'});
      await this.repo.update(o.id,{deliveryFailedAt:now,deliveryFailedReason:'other',goodsReturnedAt:now},tx);
    } else if(status==='delivered') {
      if([ORDER_STATUS.DELIVERED,ORDER_STATUS.COMPLETED,ORDER_STATUS.RETURNED].includes(o.status as 'delivered'|'completed'|'returned')) return;
      if(o.status!==ORDER_STATUS.SHIPPING) throw new BusinessException('SHIPMENT_DELIVERY_CONFLICT','Đơn chưa ở trạng thái giao hàng',409);
      if(await this.repo.hasOpenNotReceived(o.id,tx)) throw new BusinessException(ORDER_ERR.NOT_RECEIVED_OPEN,'Cần giải quyết yêu cầu chưa nhận hàng trước khi xác nhận giao',409);
      if(o.paymentMethodCode==='cod') await this.payment.markCodCollected(o.code,null,tx,{shopId:o.shopId,total:BigInt(o.total.toString()),commissionBase:commissionBase(o),platformCredit:BigInt(o.platformDiscount.toString()),commissionRate:o.commissionRateSnapshot.toString()});
      await this.repo.update(o.id,{status:ORDER_STATUS.DELIVERED,deliveredAt:now},tx);
      await this.repo.addHistory(o.id,o.status,ORDER_STATUS.DELIVERED,'Hãng xác nhận giao hàng thành công',null,tx);
      await this.outbox.publish(tx,{eventType:ORDER_EVENT.DELIVERED,aggregateType:'order',aggregateId:o.id,payload:{orderCode:o.code,userId:o.userId,from:o.status,to:ORDER_STATUS.DELIVERED}});
    } else if(status==='lost') {
      // Shipping ghi một carrier_exception bền và gọi recordShippingAction cùng tx; không gửi thông báo lần hai ở đây.
    } else if(o.status===ORDER_STATUS.PACKING && status==='awaiting_pickup') {
      await this.repo.update(o.id,{status:ORDER_STATUS.SHIPPING,shippedAt:now,shipDueAt:null,carrier:'ghn',trackingCode:input.carrierOrderCode,trackingUrl:input.trackingUrl},tx);
      await this.repo.addHistory(o.id,o.status,ORDER_STATUS.SHIPPING,'GHN đã nhận yêu cầu lấy hàng — chờ hãng đến lấy',null,tx);
    } else if(status==='picked' && o.status===ORDER_STATUS.SHIPPING) {
      await this.repo.addHistory(o.id,o.status,o.status,'Hãng xác nhận đã lấy hàng — đã bàn giao kiện',null,tx);
    }
    await this.audit.write(tx,null,{action:'CARRIER_STATUS_APPLIED',entityType:'order',entityId:o.id,entityCode:o.code,after:{status,shipmentId:input.shipmentId}});
  }

  /* Carrier chỉ đổi sang địa chỉ mã hợp lệ, cùng phí đã chốt; đổi phí yêu cầu huỷ/đặt lại. */
  async changeCarrierAddress(actor:AuthenticatedActor,code:string,addressId:string):Promise<void> {
    const before=await this.repo.findByCode(code);
    if(!before || before.userId!==actor.userId) throw new NotFoundException(ORDER_ERR.NOT_FOUND,'Không tìm thấy đơn hàng');
    if(before.fulfilmentMode!=='carrier' || !this.shippingCommands) throw new BusinessException('ORDER_ADDRESS_MODE_INVALID','Đơn tự giao cần nhập địa chỉ theo biểu mẫu hiện hành',409);
    if(!['pending','confirmed'].includes(before.status)) throw new BusinessException('ORDER_ADDRESS_LOCKED','Đơn đã đóng gói nên không đổi địa chỉ được',409);
    const a=await this.identity.findAddress(actor.userId,addressId);
    if(!a) throw new NotFoundException(ORDER_ERR.ADDRESS_NOT_FOUND,'Không tìm thấy địa chỉ');
    const snapshot=before.shippingSnapshot as unknown as ShippingSnapshot;
    const destination=OrderShippingPricingService.address(OrderService.fromAddressBrief(a));
    if(destination.provinceId!==snapshot.destination.provinceId) throw new BusinessException('ORDER_ADDRESS_PROVINCE_CHANGED','Vui lòng huỷ và đặt lại khi đổi tỉnh/thành',409);
    const quote=await this.shippingCommands.quote({userId:actor.userId,shopId:before.shopId,pickup:snapshot.pickup,destination,returnAddress:snapshot.returnAddress,parcel:snapshot.parcel,codValue:before.paymentMethodCode==='cod'?before.total.toString():'0',fallbackFee:before.shippingFee.toString()});
    if(BigInt(quote.shippingFee)!==BigInt(before.shippingFee.toString())) throw new BusinessException('ORDER_ADDRESS_SHIPPING_CHANGED','Phí giao tới địa chỉ mới thay đổi — vui lòng huỷ và đặt lại để xác nhận tổng tiền',409);
    await this.prisma.$transaction(async(tx)=>{
      const o=await this.repo.findByCodeForUpdate(code,tx);
      if(!o || o.userId!==actor.userId || !['pending','confirmed'].includes(o.status) || o.version!==before.version) throw new BusinessException('ORDER_ADDRESS_LOCKED','Đơn vừa thay đổi, vui lòng tải lại',409);
      const shippingAddress=[a.street,a.wardName,a.districtName,a.provinceName].filter(Boolean).join(', ');
      await this.repo.update(o.id,{recipientName:a.recipientName,recipientPhone:a.phone,provinceCode:a.provinceCode,provinceName:a.provinceName,districtName:a.districtName,wardName:a.wardName,street:a.street,shippingAddress,shippingQuoteId:quote.id,shippingSnapshot:JSON.parse(JSON.stringify(quote.snapshot)) as Prisma.InputJsonValue,updatedBy:actor.userId},tx);
      await this.repo.addHistory(o.id,o.status,o.status,'Khách đổi địa chỉ nhận hàng — phí vận chuyển giữ nguyên',actor.userId,tx);
      await this.audit.write(tx,actor,{action:'ORDER_ADDRESS_CHANGED',entityType:'order',entityId:o.id,entityCode:o.code,after:{addressId,quoteId:quote.id}});
      await this.outbox.publish(tx,{eventType:ORDER_EVENT.ADDRESS_CHANGED,aggregateType:'order',aggregateId:o.id,payload:{orderCode:o.code,userId:o.userId,shopId:o.shopId}});
    });
  }

  async recordShippingAction(o:ShippingOrderSnapshot,input:{kind:string;shipmentId:string;message:string},tx:Tx):Promise<void> {
    await this.audit.write(tx,null,{action:'SHIPPING_'+input.kind.toUpperCase(),entityType:'order',entityId:o.id,entityCode:o.code,after:{shipmentId:input.shipmentId,message:input.message}});
    if(['pickup_overdue','carrier_exception','create_unknown'].includes(input.kind)) {
      const staff=await this.users.staffUserIdsWithPermission('order.return.process');
      const shopMembers=await this.shops.activeMemberUserIds(o.shopId);
      await this.notify.notifyMany([...new Set([...staff,...shopMembers])].map((userId)=>({userId,type:'order',title:'Vận chuyển cần kiểm tra — '+o.code,content:input.message,link:shopMembers.includes(userId)?'/vendor/orders/'+o.code:'/order/orders/'+o.code})),tx);
    }
  }
  async confirmCarrierCod(o:ShippingOrderSnapshot,actor:AuthenticatedActor,input:{amount:string;reference:string;note?:string},tx:Tx):Promise<void> {
    if(o.collectionMode!=='carrier_cod') throw new BusinessException('PAYMENT_COD_MODE_INVALID','Đơn không thuộc COD hãng thu',409);
    await this.payment.confirmCarrierCod(o.code,actor,input,tx);
  }

  /* Huỷ hãng NGOÀI tx; bảo vệ ownership trước khi phát lệnh mạng. */
  private async cancelCarrierBeforeAction(actor:AuthenticatedActor,code:string,shopId?:string):Promise<void> {
    if(!this.shippingQueries || !this.shippingCommands) return;
    const o=await this.repo.findByCode(code);
    if(!o || (shopId && o.shopId!==shopId)) throw new NotFoundException(ORDER_ERR.NOT_FOUND,'Không tìm thấy đơn hàng');
    if(o.fulfilmentMode!=='carrier') return;
    const shipment=await this.shippingQueries.latest(code);
    if(!shipment?.active) return;
    if (await this.repo.hasOpenReturn(o.id)) throw new BusinessException(ORDER_ERR.HAS_OPEN_RETURN, 'Đơn đang có yêu cầu đổi trả chưa xử lý xong — hãy xử lý yêu cầu đó trước', 409);
    await this.shippingCommands.cancel(actor,o.shopId,code);
  }

  // ================================================================ khách

  /* Mã khách gửi (voucherCode + voucherCodes): bỏ rỗng/trùng (không phân biệt hoa thường), giữ thứ tự — mã đứng trước thắng khi tranh chỗ. */
  private static normalizeCodes(input: { voucherCode?: string | null; voucherCodes?: string[] }): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of [input.voucherCode, ...(input.voucherCodes ?? [])]) {
      const code = raw?.trim();
      if (!code || seen.has(code.toUpperCase())) continue;
      seen.add(code.toUpperCase());
      out.push(code);
    }
    return out.slice(0, 12);
  }

  private static failedQuote(code: string, error: string, shopId: string | null): PromotionQuote {
    return { ok: false, code: code.trim().toUpperCase(), name: null, type: 'unknown', scope: shopId ? 'shop' : 'platform', shopId, discount: 0n, error, missingAmount: null };
  }

  private static promoLines(lines: Basket['lines']) {
    return lines.map((l) => ({ productId: l.productId, categorySlug: l.categorySlug, lineTotal: l.lineTotal, variantId:l.variantId,shopId:l.shopId,quantity:l.quantity,unitPrice:l.unitPrice,liveSources:l.sourceLots }));
  }

  /*
   * Tính tiền cả giỏ. Voucher: tối đa 1 mã SÀN (tính trên cả giỏ, SÀN chịu, phân bổ về các đơn con theo tỉ lệ) + tối đa 1 mã GIAN HÀNG
   * cho mỗi shop có trong giỏ (tính trên riêng phần hàng của shop đó, SHOP chịu). Mã thứ hai cùng loại/cùng shop, hoặc mã shop không có
   * trong giỏ → bị từ chối kèm lý do (không im lặng bỏ qua).
   */
  private async price(userId: string, provinceHint: string | null, codes: string[], carrier?: CarrierPricingContext, sourceBasket?:Basket): Promise<Priced> {
    const basket = sourceBasket ?? await this.cart.basketOf(userId, true);
    const warnings: string[] = [];
    for (const l of basket.lines) {
      if (!l.isSellable) warnings.push(`${l.name} (${l.color}/${l.size}) đã ngừng bán`);
      else if (l.quantity > l.available) warnings.push(`${l.name} (${l.color}/${l.size}) chỉ còn ${l.available}`);
    }
    const sellable = basket.lines.filter((l) => l.isSellable);

    // Nhóm theo shop — mỗi gói tự tính phí ship riêng theo subtotal của gói (xem giải thích ở ShopGroupPriced).
    const byShop = new Map<string, Basket['lines']>();
    for (const l of sellable) byShop.set(l.shopId, [...(byShop.get(l.shopId) ?? []), l]);

    const raw: ShopGroupPriced[] = [];
    let province: { code: string; name: string } | null = null;
    for (const [shopId, lines] of byShop) {
      const groupSubtotal = lines.reduce((s, l) => s + l.lineTotal, 0n);
      const { fee, province: p } = await this.system.shippingFeeFor(groupSubtotal, provinceHint);
      province = province ?? p;
      const carrierQuote = carrier && this.shippingPricing ? await this.shippingPricing.resolve(userId, shopId, lines, groupSubtotal, fee, carrier) : null;
      raw.push({ shopId, lines, subtotal: groupSubtotal, shippingFee: carrierQuote ? BigInt(carrierQuote.shippingFee) : fee, ...(carrierQuote ? {carrierQuote}: {}) });
    }
    const subtotal = raw.reduce((s, g) => s + g.subtotal, 0n);
    const shippingFee = raw.reduce((s, g) => s + g.shippingFee, 0n);

    // ---- voucher
    const vouchers: VoucherPlan[] = [];
    if (subtotal > 0n) {
      let platformTaken = false;
      const shopTaken = new Set<string>();
      const wholeBasket = { userId, subtotal, shippingFee, lines: OrderService.promoLines(sellable),shippingByShop:Object.fromEntries(raw.map(g=>[g.shopId,g.shippingFee])) };
      for (const code of codes) {
        const scope = await this.promotion.scopeOf(code);
        if (!scope) {
          vouchers.push({ shopId: null, quote: await this.promotion.quote(code, wholeBasket) });
        } else if (scope.scope === 'platform') {
          if (platformTaken) {
            vouchers.push({ shopId: null, quote: OrderService.failedQuote(code, 'Mỗi đơn chỉ dùng được 1 mã giảm giá của sàn', null) });
          } else {
            const quote = await this.promotion.quote(code, wholeBasket);
            if (quote.ok) platformTaken = true; // mã bị từ chối không chiếm chỗ — mã hợp lệ đứng sau vẫn được nhận
            vouchers.push({ shopId: null, quote });
          }
        } else {
          const group = raw.find((g) => g.shopId === scope.shopId);
          if (!group || !scope.shopId) {
            vouchers.push({ shopId: scope.shopId, quote: OrderService.failedQuote(code, 'Mã này dành cho gian hàng không có trong giỏ hàng của bạn', scope.shopId) });
          } else if (shopTaken.has(scope.shopId)) {
            vouchers.push({ shopId: scope.shopId, quote: OrderService.failedQuote(code, 'Mỗi gian hàng chỉ dùng được 1 mã giảm giá của gian hàng', scope.shopId) });
          } else {
            const quote = await this.promotion.quote(code, { userId, shopId: group.shopId, subtotal: group.subtotal, shippingFee: group.shippingFee, lines: OrderService.promoLines(group.lines) });
            if (quote.ok) shopTaken.add(scope.shopId);
            vouchers.push({ shopId: scope.shopId, quote });
          }
        }
      }
    }

    const groups = OrderService.applyVouchers(raw, vouchers);
    const discount = groups.reduce((s, g) => s + g.discount, 0n);
    const total = groups.reduce((s, g) => s + g.total, 0n);
    return { basket, groups, subtotal, shippingFee, province, vouchers, discount, total, warnings };
  }

  /*
   * Phân bổ voucher về từng đơn con: voucher shop → đúng đơn của shop; voucher sàn → theo tỉ lệ (freeship theo phí ship từng gói, loại
   * khác theo subtotal), dồn phần dư làm tròn vào gói cuối có trọng số để tổng khớp tuyệt đối. Mỗi đơn con KHÔNG giảm quá subtotal + ship:
   * shop discount được ưu tiên, phần sàn bị cắt bớt nếu vượt — tổng đơn cha luôn bằng tổng các đơn con.
   */
  private static applyVouchers(groups: ShopGroupPriced[], vouchers: VoucherPlan[]): PricedGroup[] {
    const platform = vouchers.find((v) => v.shopId === null && v.quote.ok)?.quote ?? null;
    const shopQuote = new Map<string, PromotionQuote>();
    for (const v of vouchers) if (v.shopId && v.quote.ok) shopQuote.set(v.shopId, v.quote);

    const weight = (g: ShopGroupPriced) => platform?.eligibleShopWeights ? BigInt(platform.eligibleShopWeights[g.shopId] ?? '0') : (platform?.type === 'free_shipping' ? g.shippingFee : g.subtotal);
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
      const sq = shopQuote.get(g.shopId);
      const rawShop = sq?.discount ?? 0n;
      let shopDiscount = rawShop > cap ? cap : rawShop;
      let platformDiscount = platformShare > cap - shopDiscount ? cap - shopDiscount : platformShare;
      // Freeship sàn + freeship shop trên cùng đơn con: tổng hai mã không được vượt phí ship (shop ưu tiên) — nếu không phần dư sẽ trừ vào tiền hàng.
      if (platform?.type === 'free_shipping' && shopQuote.get(g.shopId)?.type === 'free_shipping') {
        const room = g.shippingFee - shopDiscount; // phần phí ship còn lại sau voucher shop
        if (platformDiscount > room) platformDiscount = room > 0n ? room : 0n;
      }
      // Phần giảm trên phí ship: voucher freeship ⇒ toàn bộ phần giảm đó (đã bị chặn ≤ phí ship ở trên); voucher loại khác ⇒ 0 (giảm trên tiền hàng).
      const shopShippingDiscount = shopQuote.get(g.shopId)?.type === 'free_shipping' ? (shopDiscount > g.shippingFee ? g.shippingFee : shopDiscount) : 0n;
      const platformShippingDiscount = platform?.type === 'free_shipping' ? (platformDiscount > g.shippingFee ? g.shippingFee : platformDiscount) : 0n;
      const live=(sq?.liveCampaignId||platform?.liveCampaignId) ? allocateLiveLines(g.lines,shopDiscount,platformDiscount,g.shippingFee,shopShippingDiscount,platformShippingDiscount,sq?.type==='free_shipping'?undefined:sq?.eligibleVariantWeights,platform?.type==='free_shipping'?undefined:platform?.eligibleVariantWeights):null;
      if(live) {shopDiscount=live.shopGoods+shopShippingDiscount;platformDiscount=live.platformGoods+platformShippingDiscount;}
      const discount=shopDiscount+platformDiscount;
      return { ...g, shopDiscount, platformDiscount, shopShippingDiscount, platformShippingDiscount, discount, total: cap - discount,...(live?{lineAllocations:live.allocations}:{}) };
    });
  }

  private async resolveProvinceHint(userId: string, q: { province?: string; addressId?: string }): Promise<string | null> {
    if (q.province) return q.province;
    const a = q.addressId ? await this.identity.findAddress(userId, q.addressId) : await this.identity.defaultAddress(userId);
    return a?.provinceCode ?? a?.provinceName ?? null;
  }

  async checkoutSummary(actor: AuthenticatedActor, q: { voucherCode?: string; voucherCodes?: string[]; province?: string; addressId?: string; paymentMethodCode?: string; checkoutIntentId?:string }): Promise<CheckoutSummaryResponse> {
    const hint = await this.resolveProvinceHint(actor.userId, q);
    const a = this.shippingPricing ? (q.addressId ? await this.identity.findAddress(actor.userId,q.addressId) : await this.identity.defaultAddress(actor.userId)) : null;
    const sourceBasket=q.checkoutIntentId && this.checkoutIntents ? await this.checkoutIntents.basket(actor.userId,q.checkoutIntentId):undefined;
    const p = await this.price(actor.userId, hint, OrderService.normalizeCodes(q), a ? {address:OrderService.fromAddressBrief(a),methodCode:q.paymentMethodCode ?? 'cod'} : undefined,sourceBasket);
    return this.toSummary(p);
  }

  /* Dựng CheckoutSummaryResponse từ một báo giá — dùng chung cho GET /checkout/summary và body của 409 ORDER_PRICE_CHANGED (CK-05) để FE vẽ lại bằng đúng MỘT kiểu dữ liệu. Chỉ chứa số khách được thấy (không giá vốn/hoa hồng). */
  private async toSummary(p: Priced): Promise<CheckoutSummaryResponse> {
    const codOk = await this.payment.codAvailability(p.groups.map((g) => g.shopId));
    const shopGroups = await Promise.all(
      p.groups.map(async (g) => {
        const shop = await this.shops.findBrief(g.shopId);
        return { shopId: g.shopId, shopName: shop?.name ?? 'Gian hàng', codAvailable: g.carrierQuote ? true : (codOk.get(g.shopId) ?? false), ...(g.carrierQuote ? {shippingQuoteId:g.carrierQuote.id,shippingQuoteExpiresAt:g.carrierQuote.expiresAt,shippingFeeSource:g.carrierQuote.feeSource,fulfilmentMode:'carrier'} : {}), itemCount: g.lines.reduce((n, l) => n + l.quantity, 0), subtotal: money(g.subtotal), shippingFee: money(g.shippingFee), discount: money(g.discount), total: money(g.total) };
      }),
    );
    return {
      subtotal: money(p.subtotal),
      shippingFee: money(p.shippingFee),
      discount: money(p.discount),
      total: money(p.total),
      // Tương thích FE cũ (1 ô nhập mã): mã đầu tiên được nhận + lỗi đầu tiên; chi tiết từng mã nằm ở `vouchers`.
      promotionCode: p.vouchers.find((v) => v.quote.ok)?.quote.code ?? null,
      promotionError: p.vouchers.find((v) => !v.quote.ok)?.quote.error ?? null,
      vouchers: await Promise.all(
        p.vouchers.map(async (v) => ({
          code: v.quote.code,
          scope: v.quote.scope,
          shopId: v.quote.shopId,
          shopName: v.quote.shopId ? ((await this.shops.findBrief(v.quote.shopId))?.name ?? null) : null,
          ok: v.quote.ok,
          error: v.quote.error,
          // Số THỰC áp (sau khi cắt theo từng đơn con), không phải số quote thô — tổng các mã khớp tổng giảm của đơn.
          discount: money(!v.quote.ok ? 0n : v.shopId ? (p.groups.find((g) => g.shopId === v.shopId)?.shopDiscount ?? 0n) : p.groups.reduce((n, g) => n + g.platformDiscount, 0n)),
        })),
      ),
      itemCount: p.basket.itemCount,
      provinceName: p.province?.name ?? null,
      warnings: p.warnings,
      shopGroups,
    };
  }

  /*
   * PLAN-0014 bước 7: giỏ có thể chứa hàng từ NHIỀU shop → 1 lần checkout tạo 1 OrderGroup (đơn cha, không
   * status riêng) + N Order con (mỗi shop 1 đơn, giữ NGUYÊN state machine/reserve/payment hiện có). Mỗi đơn
   * con gọi `payment.initiate()` ĐỘC LẬP (N lần thanh toán riêng cho N shop) — KHÔNG gộp thành 1 lần thanh
   * toán duy nhất: việc đó thuộc PLAN-0015 (đóng băng payment module ở vòng này theo đúng yêu cầu).
   */
  async placeOrder(actor: AuthenticatedActor, input: PlaceOrderInput, idempotencyKey: string | null): Promise<OrderGroupResponse> {
    if(input.checkoutIntentId && this.checkoutIntents) { const intent=await this.checkoutIntents.row(actor.userId,input.checkoutIntentId); if(intent.state==='consumed' && intent.resultGroupCode) return this.myOrderGroup(actor,intent.resultGroupCode); }
    const commandHash = this.shippingPricing ? IdempotencyService.hashRequest({userId:actor.userId,addressId:input.addressId ?? null,address:input.address ?? null,methodCode:input.paymentMethodCode,note:input.note ?? null,vouchers:OrderService.normalizeCodes(input).map((c)=>c.toUpperCase()).sort(),...(input.checkoutIntentId?{checkoutIntentId:input.checkoutIntentId}:{})}) : null;
    if(idempotencyKey && commandHash) { const replay=await this.repo.completedPlacement(actor.userId,idempotencyKey,commandHash); if(replay) return this.myOrderGroup(actor,replay); }
    // 1. Địa chỉ giao
    let address: CheckoutAddress;
    if (input.addressId) {
      const a = await this.identity.findAddress(actor.userId, input.addressId);
      if (!a) throw new NotFoundException(ORDER_ERR.ADDRESS_NOT_FOUND, 'Không tìm thấy địa chỉ');
      address = OrderService.fromAddressBrief(a);
    } else if (input.address) {
      address = input.address;
    } else {
      const a = await this.identity.defaultAddress(actor.userId);
      if (!a) throw new BusinessException(ORDER_ERR.ADDRESS_REQUIRED, 'Vui lòng chọn hoặc nhập địa chỉ giao hàng');
      address = OrderService.fromAddressBrief(a);
    }
    // 2. Phương thức thanh toán (PLAN-0018: chỉ còn cod · payos) — DÙNG CHUNG cho mọi đơn con trong lần checkout này
    const methodCode = input.paymentMethodCode;
    if (!(await this.payment.isMethodActive(methodCode))) throw new BusinessException(ORDER_ERR.PAYMENT_METHOD_INVALID, 'Phương thức thanh toán không khả dụng');

    const expectedTotal = OrderService.parseExpectedTotal(input.expectedTotal); // CK-05: null = client cũ không gửi ⇒ không kiểm giá
    const requestHash = commandHash ?? IdempotencyService.hashRequest({ userId: actor.userId, address, methodCode, note: input.note ?? null, vouchers: OrderService.normalizeCodes(input).map((c) => c.toUpperCase()).sort() });
    // Replay được đọc trước quote: retry thành công không phụ thuộc giỏ còn hàng/quote còn hạn.
    if (idempotencyKey && this.shippingPricing) {
      const replay = await this.repo.completedPlacement(actor.userId,idempotencyKey,requestHash);
      if (replay) return this.myOrderGroup(actor,replay);
    }
    const sourceBasket=input.checkoutIntentId && this.checkoutIntents ? await this.checkoutIntents.basket(actor.userId,input.checkoutIntentId):undefined;
    const prepriced = this.shippingPricing ? await this.price(actor.userId,address.provinceCode ?? address.provinceName,OrderService.normalizeCodes(input),{address,methodCode,quoteIds:input.quoteIds},sourceBasket) : null;
    const prepared = prepriced ? new Map(prepriced.groups.map((g) => [g.shopId,g.carrierQuote ?? null])) : undefined;
    const createdOrderCodes: string[] = []; // mã đơn con vừa tạo trong transaction (rỗng khi replay Idempotency-Key)
    const groupCode = await this.prisma.$transaction(
      async (tx) => {
        const idem = idempotencyKey ? await IdempotencyService.begin<{ code: string }>(tx.orderIdempotencyKey, { scope: 'place-order', actorKey: actor.userId, key: idempotencyKey, requestHash, ttlHours: 24 }) : null;
        if (idem?.replay) return idem.replay.code;
        if(input.checkoutIntentId && this.checkoutIntents) { const row=await this.checkoutIntents.row(actor.userId,input.checkoutIntentId,tx,true); if(row.state==='consumed' && row.resultGroupCode) { if(idem) await idem.complete(200,{code:row.resultGroupCode},row.resultGroupCode); return row.resultGroupCode; } }

        // 3. Giỏ + tiền theo từng shop (đọc trong tx để nhất quán)
        let p: Priced;
        try { p = await this.price(actor.userId, address.provinceCode ?? address.provinceName, OrderService.normalizeCodes(input), prepared ? {address,methodCode,prepared} : undefined,input.checkoutIntentId && this.checkoutIntents ? await this.checkoutIntents.basket(actor.userId,input.checkoutIntentId,tx):undefined); }
        catch (err) { if (err instanceof BusinessException && err.errorCode === 'ORDER_SHIPPING_QUOTE_CHANGED') throw new PriceChangedSignal(expectedTotal ?? prepriced?.total ?? 0n,null); throw err; }
        if (p.groups.length === 0) throw new BusinessException(ORDER_ERR.CART_EMPTY, 'Giỏ hàng trống hoặc không còn sản phẩm nào bán được');
        if (p.warnings.length > 0) throw new BusinessException(ORDER_ERR.CART_CHANGED, `Giỏ hàng có thay đổi: ${p.warnings.join('; ')}`, 409);
        const zero = p.groups.find((g) => g.total <= 0n);
        if (zero) throw new BusinessException(ORDER_ERR.PROMOTION_INVALID, 'Đơn của một gian hàng được giảm hết giá trị — vui lòng gỡ bớt mã giảm giá', 409);
        // Chống "mua chéo" (wash-trade): thành viên của một gian hàng không được mua hàng của CHÍNH gian hàng đó — nếu không họ tự giao hàng, tự đánh giá 5★,
        // và lấy phần voucher sàn hoàn lại. Đọc thẳng trong tx (không tin cache).
        for (const g of p.groups) {
          if ((await this.shops.activeMemberUserIds(g.shopId)).includes(actor.userId)) throw new BusinessException(ORDER_ERR.SHOP_NOT_AVAILABLE, 'Bạn không thể mua sản phẩm của chính gian hàng mình', 409);
        }
        // CK-05 (PLAN-0032 §2.1): so số khách đã thấy với số vừa TÍNH LẠI trong chính transaction này (giá hiện hành, phí ship, giảm giá, voucher còn hiệu lực).
        // Đặt ngay trước các kiểm tra phụ thuộc voucher/COD để mã hết lượt hay giá đổi đều ra "giá đã đổi" kèm báo giá mới, và TRƯỚC mọi thao tác ghi (mã đơn, consume voucher, giữ kho).
        // Lệch ⇒ rollback toàn bộ (kể cả dòng idempotency IN_PROGRESS nên Idempotency-Key không bị tiêu). Replay Idempotency-Key đã return ở trên nên không bao giờ bị 409 oan khi retry sau mất mạng.
        if (expectedTotal !== null && expectedTotal !== p.total) throw new PriceChangedSignal(expectedTotal, p);
        const rejected = p.vouchers.find((v) => !v.quote.ok);
        if (rejected) throw new BusinessException(ORDER_ERR.PROMOTION_INVALID, `${rejected.quote.code}: ${rejected.quote.error ?? 'Mã giảm giá không hợp lệ'}`);

        // 3b. Đọc THẲNG trạng thái từng shop trong tx (không tin cache) — sàn khoá gian hàng giữa lúc khách bấm đặt
        // hàng thì chặn ngay, không để lọt đơn (PLAN-0014 mục 8, học từ race-condition đã phát hiện ở bước 1-4).
        const shopBriefs = new Map<string, ShopBrief>();
        for (const g of p.groups) {
          const shop = await this.shops.findBrief(g.shopId);
          if (!shop || shop.status !== 'approved') throw new BusinessException(ORDER_ERR.SHOP_NOT_AVAILABLE, `Gian hàng "${shop?.name ?? g.shopId}" hiện không thể đặt hàng — vui lòng bỏ sản phẩm này khỏi giỏ`, 409);
          shopBriefs.set(g.shopId, shop);
        }

        // 3c. Hạn mức COD kiểm THEO TỪNG ĐƠN CON — mỗi shop thu tiền độc lập (N gói hàng, N lần thu COD)
        if (methodCode === PAYMENT_METHOD.COD) {
          // PLAN-0020: shop chỉ bán COD khi đã đặt cọc (ví > 0) — đọc THẲNG trong tx để không lọt đơn khi ví vừa về 0.
          const codOk = await this.payment.codAvailability(p.groups.map((g) => g.shopId), tx);
          const closed = p.groups.find((g) => !g.carrierQuote && !codOk.get(g.shopId));
          if (closed) throw new BusinessException(ORDER_ERR.COD_NOT_AVAILABLE, `Gian hàng "${shopBriefs.get(closed.shopId)?.name ?? closed.shopId}" hiện không nhận thanh toán khi nhận hàng — vui lòng thanh toán trước (PayOS)`, 409);
          const max = await this.system.settingNumber(SETTING_KEY.ORDER_COD_MAX_AMOUNT);
          if (max > 0) {
            const over = p.groups.find((g) => g.total > BigInt(max));
            if (over) throw new BusinessException(ORDER_ERR.COD_LIMIT, `Đơn trên ${money(max).display} vui lòng thanh toán trước (PayOS)`);
          }
        }

        // 4. Mã đơn CHA + mã đơn CON (sinh trước để voucher shop gắn lượt dùng vào ĐÚNG đơn con của nó) + chốt lượt voucher.
        // Voucher sàn consume theo mã đơn CHA; voucher shop consume theo mã đơn CON. Consume khoá dòng + kiểm hạn mức lần cuối;
        // số giảm sau consume phải KHỚP số đã quote (cùng giỏ, cùng tx) — lệch nghĩa là điều kiện vừa đổi → dừng, không tạo đơn sai tiền.
        const groupCode = await this.repo.nextGroupCode(tx);
        const childCodes = new Map<string, string>();
        for (const g of p.groups) childCodes.set(g.shopId, await this.repo.nextCode(tx));
        const promoByShop = new Map<string, PromotionQuote>();
        let platformPromo: PromotionQuote | null = null;
        for (const v of p.vouchers) {
          const group = v.shopId ? p.groups.find((g) => g.shopId === v.shopId) : null;
          const basket = group
            ? { userId: actor.userId, shopId: group.shopId, subtotal: group.subtotal, shippingFee: group.shippingFee, lines: OrderService.promoLines(group.lines) }
            : { userId: actor.userId, subtotal: p.subtotal, shippingFee: p.shippingFee, lines: OrderService.promoLines(p.groups.flatMap((g) => g.lines)),shippingByShop:Object.fromEntries(p.groups.map(g=>[g.shopId,g.shippingFee])) };
          const orderRef = group ? (childCodes.get(group.shopId) as string) : groupCode;
          const applied=group?group.shopDiscount:p.groups.reduce((n,g)=>n+g.platformDiscount,0n);
          const consumed = await this.promotion.consume(v.quote.code, basket, orderRef, tx,applied);
          const voucherLost = !consumed.ok
            ? new BusinessException(ORDER_ERR.PROMOTION_INVALID, `${v.quote.code}: ${consumed.error ?? 'Mã giảm giá không còn hiệu lực'}`)
            : consumed.discount !== v.quote.discount
              ? new BusinessException(ORDER_ERR.PROMOTION_INVALID, `Mã ${v.quote.code} vừa thay đổi điều kiện, vui lòng kiểm tra lại`, 409)
              : null;
          // CK-05: voucher hụt đúng lúc chốt (hết lượt do đơn khác chốt trước…) mà khách đang giữ một con số đã thấy ⇒ chính là "giá đổi": trả báo giá mới (tính lại) thay vì lỗi mã chung.
          // Lỗi gốc đi kèm làm lối thoát: nếu tính lại mà tổng vẫn khớp (quote/consume lệch nhau) thì báo đúng lỗi mã thay vì 409 giá-đổi vô nghĩa khiến FE lặp vô hạn.
          if (voucherLost) throw expectedTotal !== null ? new PriceChangedSignal(expectedTotal, null, voucherLost) : voucherLost;
          if (group) promoByShop.set(group.shopId, consumed);
          else platformPromo = consumed;
        }
        const groups = p.groups;
        const discount = p.discount;
        const groupTotal = p.total;

        // 5. Tạo đơn cha (snapshot địa chỉ + tổng cả giỏ)
        const shippingAddress = [address.street, address.wardName, address.districtName, p.province?.name ?? address.provinceName].filter(Boolean).join(', ');
        const expiresAt = await this.paymentExpiry(methodCode);
        // PLAN-0027: COD vào hàng đợi của shop ngay lúc đặt ⇒ hạn xác nhận từ bây giờ; PayOS chỉ bắt đầu tính hạn khi NHẬN TIỀN (onPaid) — đơn chưa trả do job huỷ quá hạn thanh toán lo.
        const confirmDueAt = methodCode === PAYMENT_METHOD.COD ? await this.slaDueAt(SETTING_KEY.ORDER_SHOP_CONFIRM_HOURS, 24) : null;
        const group = await this.repo.createGroup(
          {
            code: groupCode,
            userId: actor.userId,
            recipientName: address.recipientName.trim(),
            recipientPhone: address.phone,
            shippingAddress,
            subtotal: p.subtotal.toString(),
            shippingFee: p.shippingFee.toString(),
            discount: discount.toString(),
            total: groupTotal.toString(),
            createdBy: actor.userId,
          },
          tx,
        );

        // PLAN-0040 tầng 4 (AUD-11a / NTF-03): KHÔNG báo "Đơn mới" cho nhân viên sàn theo từng đơn con (spam: 5 vai × N shop). Shop nhận qua listener ORDER_CREATED (system-worker); sàn xem hàng đợi bằng số đếm dashboard (reporting `pending`).
        const clientIp = RequestTraceContext.current()?.ip ?? '127.0.0.1';
        const purchasedVariantIds: string[] = [];

        // 6. Tạo TỪNG đơn con theo shop — giữ NGUYÊN logic hiện có (snapshot/reserve/payment) cho mỗi đơn
        for (const g of groups) {
          const shop = shopBriefs.get(g.shopId)!;
          const orderCode = childCodes.get(g.shopId) as string;
          createdOrderCodes.push(orderCode);
          const shopPromo = promoByShop.get(g.shopId) ?? null;
          const order = await this.repo.create(
            {
              code: orderCode,
              userId: actor.userId,
              shopId: g.shopId,
              orderGroupId: group.id,
              commissionRateSnapshot: shop.commissionRate,
              ...(g.carrierQuote ? {fulfilmentMode:'carrier',collectionMode:methodCode === 'cod' ? 'carrier_cod':'platform_online',shippingProvider:g.carrierQuote.provider,shippingEnvironment:g.carrierQuote.environment,shippingQuoteId:g.carrierQuote.id,shippingSnapshot:JSON.parse(JSON.stringify(g.carrierQuote.snapshot)) as Prisma.InputJsonValue}:{}),
              status: ORDER_STATUS.PENDING,
              paymentMethodCode: methodCode,
              paymentStatus: PAYMENT_STATUS.UNPAID,
              recipientName: address.recipientName.trim(),
              recipientPhone: address.phone,
              provinceCode: p.province?.code ?? address.provinceCode,
              provinceName: p.province?.name ?? address.provinceName,
              districtName: address.districtName,
              wardName: address.wardName,
              street: address.street.trim(),
              shippingAddress,
              customerNote: input.note?.trim() || null,
              subtotal: g.subtotal.toString(),
              shippingFee: g.shippingFee.toString(),
              discount: g.discount.toString(),
              shopDiscount: g.shopDiscount.toString(),
              platformDiscount: g.platformDiscount.toString(),
              shopShippingDiscount: g.shopShippingDiscount.toString(),
              platformShippingDiscount: g.platformShippingDiscount.toString(),
              promotionCode: platformPromo?.code ?? null,
              promotionName: platformPromo?.name ?? null,
              shopPromotionCode: shopPromo?.code ?? null,
              shopPromotionName: shopPromo?.name ?? null,
              total: g.total.toString(),
              itemCount: g.lines.reduce((n, l) => n + l.quantity, 0),
              paymentExpiresAt: expiresAt,
              confirmDueAt,
              createdBy: actor.userId,
              updatedBy: actor.userId,
              items: { create: g.lines.map((l) => ({ variantId: l.variantId, productId: l.productId, shopId: l.shopId, slug: l.slug, name: l.name, imageUrl: l.imageUrl, color: l.color, size: l.size, sku: l.sku, quantity: l.quantity, unitPrice: l.unitPrice.toString(), lineTotal: l.lineTotal.toString(),liveSources:JSON.parse(JSON.stringify(l.sourceLots??[])) as Prisma.InputJsonValue,...(g.lineAllocations?.has(l.variantId)?{discountAllocation:{...g.lineAllocations.get(l.variantId)!}}:{}) })) },
            },
            tx,
          );
          await this.repo.addHistory(order.id, null, ORDER_STATUS.PENDING, 'Khách đặt hàng', actor.userId, tx);

          // Giữ kho — theo TỪNG đơn con (mỗi đơn tự giữ hàng của gói mình)
          try {
            await this.inventory.reserve(g.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })), { type: 'order', id: orderCode }, tx);
          } catch (err) {
            if (err instanceof InsufficientStockError) {
              const names = err.shortages.map((s) => `${g.lines.find((l) => l.variantId === s.variantId)?.name ?? s.variantId}: còn ${s.available}`).join('; ');
              throw new BusinessException(ORDER_ERR.OUT_OF_STOCK, `Không đủ hàng — ${names}`, 409);
            }
            throw err;
          }

          // Khởi tạo thanh toán — MỖI đơn con gọi initiate() ĐỘC LẬP (không đụng payment module/interface)
          await this.payment.initiate({ orderId: order.id, orderCode, shopId: g.shopId, userId: actor.userId, amount: g.total, methodCode, clientIp, collectionMode:g.carrierQuote ? (methodCode === 'cod' ? 'carrier_cod':'platform_online') : undefined }, tx);

          await this.audit.write(tx, actor, { action: ORDER_AUDIT.CREATED, entityType: 'order', entityId: order.id, entityCode: orderCode, after: { total: g.total.toString(), method: methodCode, items: g.lines.length, promotion: platformPromo?.code ?? null, shopPromotion: shopPromo?.code ?? null, discount: g.discount.toString(), shopId: g.shopId } });
          await this.outbox.publish(tx, { eventType: ORDER_EVENT.CREATED, aggregateType: 'order', aggregateId: order.id, payload: { orderCode, orderGroupCode: groupCode, shopId: g.shopId, userId: actor.userId, total: g.total.toString(), methodCode, itemCount: g.lines.reduce((n, l) => n + l.quantity, 0) } });
          purchasedVariantIds.push(...g.lines.map((l) => l.variantId));
        }

        // 7. Xoá dòng giỏ đã mua (toàn bộ, không phân biệt shop) + 1 thông báo tổng cho khách
        if(input.checkoutIntentId && this.checkoutIntents) await this.checkoutIntents.committed(actor.userId,input.checkoutIntentId,groupCode,tx);
        else await this.cartWrite.removeLines(actor.userId, purchasedVariantIds, tx);
        await this.notify.notify(
          {
            userId: actor.userId,
            type: 'order',
            title: `Đặt hàng thành công — ${groupCode}`,
            content: `Tổng ${money(groupTotal).display}${groups.length > 1 ? ` cho ${groups.length} gian hàng` : ''}. ${methodCode === PAYMENT_METHOD.COD ? 'Thanh toán khi nhận hàng.' : 'Vui lòng thanh toán để đơn được xử lý.'}`,
            link: `/account/orders/${groupCode}`,
          },
          tx,
        );
        if (idem) await idem.complete(200, { code: groupCode }, groupCode);
        return groupCode;
      },
      { timeout: 20_000 },
    ).catch((err: unknown) => this.rethrowPlaceFailure(err, actor, address, input));
    this.logger.log({ groupCode, userId: actor.userId }, 'Đã tạo đơn hàng');
    // PayOS (AUD-06): tạo link SAU commit — PayOS chậm/lỗi không làm đơn rollback, không giữ khoá DB. Lỗi ⇒ đơn vẫn có, `linkRetryable` = true để khách bấm "Thanh toán lại".
    if (methodCode === PAYMENT_METHOD.PAYOS && createdOrderCodes.length > 0) await this.payment.createCheckoutLinks(createdOrderCodes);
    return this.myOrderGroup(actor, groupCode);
  }

  /*
   * CK-05: biến tín hiệu nội bộ thành 409 ORDER_PRICE_CHANGED (transaction đã rollback xong — không còn giữ khoá nào). `data` = báo giá MỚI đúng dạng
   * GET /checkout/summary để storefront vẽ lại và cho khách xác nhận; `details` chỉ có hai con số VND (chuỗi) cho FE chỉ đọc details. Mọi lỗi khác đi qua nguyên vẹn.
   */
  private async rethrowPlaceFailure(err: unknown, actor: AuthenticatedActor, address: CheckoutAddress, input: PlaceOrderInput): Promise<never> {
    if (!(err instanceof PriceChangedSignal)) throw err;
    // Tính lại cùng đầu vào (cùng tỉnh, cùng mã) khi tín hiệu không mang sẵn báo giá — dòng giỏ chưa bị xoá vì transaction đã rollback.
    const fresh = err.priced ?? (await this.price(actor.userId, address.provinceCode ?? address.provinceName, OrderService.normalizeCodes(input),this.shippingPricing ? {address,methodCode:input.paymentMethodCode,quoteIds:input.quoteIds}:undefined,input.checkoutIntentId && this.checkoutIntents ? await this.checkoutIntents.basket(actor.userId,input.checkoutIntentId):undefined));
    if (!err.priced && err.fallback && fresh.total === err.expected) throw err.fallback;
    throw new BusinessException(
      ORDER_ERR.PRICE_CHANGED,
      `Giá đơn hàng đã thay đổi từ ${money(err.expected).display} thành ${money(fresh.total).display} — vui lòng kiểm tra lại và xác nhận đặt hàng`,
      409,
      { expectedTotal: err.expected.toString(), currentTotal: fresh.total.toString() },
      await this.toSummary(fresh),
    );
  }

  /* `expectedTotal` do client gửi: bỏ trống ⇒ null (không kiểm). Chỉ nhận số nguyên VND không âm (DTO đã chặn, đây là lớp phòng thủ cho caller khác) — tuyệt đối không so bằng float. */
  private static parseExpectedTotal(raw: string | null | undefined): bigint | null {
    if (raw === undefined || raw === null || raw.trim() === '') return null;
    const s = raw.trim();
    if (!/^\d{1,14}(\.0+)?$/.test(s)) throw new BusinessException('COMMON_VALIDATION_ERROR', 'expectedTotal phải là số tiền VND nguyên không âm (vd "1250000")', 400, { expectedTotal: 'expectedTotal phải là số tiền VND nguyên không âm' });
    return vnd(s);
  }

  private async paymentExpiry(methodCode: string): Promise<Date | null> {
    // Link thanh toán PayOS hết hạn theo mốc này — thiếu nhánh này đơn PayOS chưa trả giữ kho + voucher vĩnh viễn. COD không có hạn.
    if (methodCode === PAYMENT_METHOD.PAYOS) return new Date(Date.now() + (await this.system.settingNumber(SETTING_KEY.ORDER_ONLINE_PAYMENT_TIMEOUT_MINUTES)) * 60_000);
    return null;
  }

  static fromAddressBrief(a: AddressBrief): CheckoutAddress {
    return { addressSystem:a.addressSystem,ghnProvinceId:a.ghnProvinceId,ghnDistrictId:a.ghnDistrictId,ghnWardCode:a.ghnWardCode,recipientName: a.recipientName, phone: a.phone, provinceCode: a.provinceCode, provinceName: a.provinceName, districtName: a.districtName, wardName: a.wardName, street: a.street };
  }

  async myOrders(actor: AuthenticatedActor, page: number, size: number, status?: string): Promise<PageResponse<OrderSummaryResponse>> {
    const { items, total } = await this.repo.list({ userId: actor.userId, status }, (page - 1) * size, size);
    const refunds = await this.payment.refundSummaries(items.map((o) => o.code)); // MỘT lần cho cả trang
    return PageResponse.of(items.map((o) => toOrderSummary(o, refunds.get(o.code))), page, size, total);
  }

  /* Bản đầy đủ cho trang "Đơn của tôi" (FE vẽ từng món) — ≤ 20 đơn/trang nên gộp extras thanh toán tuần tự vẫn nhẹ. */
  async myOrdersFull(actor: AuthenticatedActor, page: number, size: number, status?: string): Promise<PageResponse<OrderResponse>> {
    const { items, total } = await this.repo.list({ userId: actor.userId, status }, (page - 1) * size, Math.min(size, 20));
    const full = await this.toResponses(items);
    return PageResponse.of(full, page, size, total);
  }

  async myOrder(actor: AuthenticatedActor, code: string): Promise<OrderResponse> {
    const o = await this.repo.findByCode(code);
    if (!o || o.userId !== actor.userId) throw new NotFoundException(ORDER_ERR.NOT_FOUND, 'Không tìm thấy đơn hàng');
    return this.toResponse(o);
  }

  /* PLAN-0014 bước 7 — đơn cha kèm mọi đơn con (mỗi đơn con đủ payment extras/history như 1 OrderResponse). */
  async myOrderGroup(actor: AuthenticatedActor, code: string): Promise<OrderGroupResponse> {
    const g = await this.repo.findGroupByCode(code);
    if (!g || g.userId !== actor.userId) throw new NotFoundException(ORDER_ERR.NOT_FOUND, 'Không tìm thấy đơn hàng');
    const orders = await this.toResponses(g.orders);
    return toOrderGroupResponse(g, orders);
  }

  async myOrderGroups(actor: AuthenticatedActor, page: number, size: number): Promise<PageResponse<OrderGroupResponse>> {
    const { items, total } = await this.repo.listGroups(actor.userId, (page - 1) * size, Math.min(size, 20));
    // Một lượt cho MỌI đơn con của cả trang (khoản hoàn, tên shop, số lượng đã giữ chỗ đổi trả) — không N+1 theo đơn.
    const byCode = new Map((await this.toResponses(items.flatMap((g) => g.orders))).map((r) => [r.code, r]));
    const full = items.map((g) => toOrderGroupResponse(g, g.orders.map((o) => byCode.get(o.code) as OrderResponse)));
    return PageResponse.of(full, page, size, total);
  }

  private async toResponse(o: OrderRow, staffView = false): Promise<OrderResponse> {
    return (await this.toResponses([o], staffView))[0];
  }

  /*
   * Dựng OrderResponse theo LÔ (PLAN-0022 §4.5): cài đặt, tên/slug shop, khoản hoàn tiền (payment.refundSummaries) và số lượng đã giữ chỗ đổi trả đều tra MỘT lần cho cả trang —
   * chỉ thông tin thanh toán (extras) còn tra theo từng đơn như trước. Trong hạn nhưng đã yêu cầu trả/báo HẾT số lượng ⇒ canReturn/canReportNotReceived = false
   * (tránh nút dẫn tới 400 "chỉ còn 0").
   */
  private async toResponses(rows: OrderRow[], staffView = false): Promise<OrderResponse[]> {
    if (rows.length === 0) return [];
    const [window, notReceivedDays, shops, refunds] = await Promise.all([
      this.system.settingNumber(SETTING_KEY.RETURN_WINDOW_DAYS),
      this.system.settingNumber(SETTING_KEY.RETURN_NOT_RECEIVED_DAYS),
      this.shops.findManyBrief(rows.map((o) => o.shopId)),
      this.payment.refundSummaries(rows.map((o) => o.code)),
    ]);
    const shipmentMap = this.shippingQueries ? await this.shippingQueries.summaries(rows.filter((o)=>o.fulfilmentMode === 'carrier').map((o)=>o.code)) : new Map<string, import('@modules/shipping/queryapi/shipping.queryapi').ShipmentResponse>();
    const extras = await Promise.all(rows.map((o) => this.payments.extrasForOrder(o.code)));
    const base = rows.map((o, i) => toOrderResponse(o, extras[i], window, shops.get(o.shopId)?.name ?? 'Gian hàng', { refund: refunds.get(o.code) ?? null, notReceivedDays, staffView }));
    const candidates = rows.filter((_, i) => base[i].canReturn || base[i].canReportNotReceived);
    const returned = await this.repo.returnedQtyByItem(candidates.map((o) => o.id));
    const deliveredIds = rows.filter((o) => o.status === ORDER_STATUS.DELIVERED).map((o) => o.id);
    const openReturns = deliveredIds.length > 0 ? await this.repo.openReturnOrderIds(deliveredIds) : new Set<string>();
    return rows.map((o, i) => {
      const res = base[i];
      if (res.canReturn || res.canReportNotReceived) {
        const anyLeft = o.items.some((it) => it.quantity - (returned.get(it.id) ?? 0) > 0);
        res.canReturn = res.canReturn && anyLeft;
        res.canReportNotReceived = res.canReportNotReceived && anyLeft;
      }
      // PLAN-0027: "Đã nhận hàng" chỉ khi đơn `delivered` và KHÔNG có yêu cầu đổi trả / "chưa nhận hàng" đang mở.
      return { ...res, ...(o.fulfilmentMode === 'carrier' ? {shipment:shipmentMap.get(o.code) ?? null}:{}), canMarkReceived: res.canMarkReceived && !openReturns.has(o.id), shopSlug: shops.get(o.shopId)?.slug ?? '' };
    });
  }

  /*
   * Khách huỷ đơn (PLAN-0027 §2.2): TỨC THÌ khi `pending` hoặc `confirmed` (CAN-03: nhập lại kho, hoàn tiền nếu đã trả, báo shop); `packing` ⇒ 409 + gợi ý gửi YÊU CẦU huỷ
   * (POST /orders/:code/cancel-request — shop duyệt); `shipping` trở đi ⇒ 400 (từ chối nhận / đổi trả). Khoá dòng đơn TRƯỚC khi kiểm trạng thái (G15, CONC-03/05) nên huỷ ↔ shop xác nhận/giao
   * đồng thời chỉ một bên thắng. `reasonCode` (changed_mind, wrong_address, found_cheaper, slow_confirm, other) tuỳ chọn; `reason` là lý do hiển thị (API cũ + chatbot chỉ gửi `reason`).
   */
  async cancelByCustomer(actor: AuthenticatedActor, code: string, reason: string, extra: { reasonCode?: string; note?: string } = {}): Promise<OrderResponse> {
    const { reasonCode, text } = resolveCancelReason('customer', { reason, reasonCode: extra.reasonCode, note: extra.note });
    await this.prisma.$transaction(async (tx) => {
      const o = await this.repo.findByCodeForUpdate(code, tx);
      if (!o || o.userId !== actor.userId) throw new NotFoundException(ORDER_ERR.NOT_FOUND, 'Không tìm thấy đơn hàng');
      // Idempotent cho chính khách: bấm huỷ lại / thử lại sau lỗi mạng / đơn vừa bị hệ thống huỷ (hết hạn, shop bị khoá) ⇒ trả đơn hiện tại, KHÔNG hoàn tiền hay thông báo lần hai.
      if (o.status === ORDER_STATUS.CANCELLED) return;
      if (o.status === ORDER_STATUS.PACKING) throw new BusinessException(ORDER_ERR.CANNOT_CANCEL, 'Đơn đang được đóng gói — hãy gửi yêu cầu huỷ để shop xem xét', 409, { hint: 'cancel_request' });
      if (o.status !== ORDER_STATUS.PENDING && o.status !== ORDER_STATUS.CONFIRMED) {
        throw new BusinessException(ORDER_ERR.CANNOT_CANCEL, o.status === ORDER_STATUS.SHIPPING ? 'Đơn đang được giao — vui lòng từ chối nhận hàng khi shipper giao tới' : 'Đơn không còn huỷ được');
      }
      await this.doCancel(o, text, actor, tx, { source: CANCEL_SOURCE.CUSTOMER, reasonCode });
    });
    return this.myOrder(actor, code);
  }

  // ================================================================ nhân viên

  /*
   * PLAN-0040 tầng 4 (AUD-12b / OPS-08): CSKH tìm đơn toàn sàn không cần chọn shop. `q` khớp mã đơn con, SĐT/tên người nhận (có sẵn) + MÃ NHÓM `DHN…` + EMAIL KHÁCH.
   * Email → userId tra qua IdentityQueryApi (không join chéo schema): chỉ khi `q` có '@' (không quét bảng user cho mọi chữ gõ vào ô tìm), khớp đúng email không phân biệt hoa thường.
   * Vẫn phân trang server; không khớp user nào thì các nhánh còn lại vẫn chạy bình thường.
   */
  private async withAdminSearch(f: OrderListFilter): Promise<OrderListFilter> {
    const q = f.q?.trim();
    if (!q) return { ...f, q: undefined };
    const qUserIds: string[] = [];
    if (q.includes('@')) {
      const user = await this.identity.findUserBriefByEmail(q);
      if (user) qUserIds.push(user.id);
    }
    return { ...f, q, qGroupCode: true, qUserIds };
  }

  async listAdmin(f: OrderListFilter, page: number, size: number): Promise<PageResponse<OrderSummaryResponse>> {
    const { items, total } = await this.repo.list(await this.withAdminSearch(f), (page - 1) * size, size);
    const refunds = await this.payment.refundSummaries(items.map((o) => o.code)); // MỘT lần cho cả trang
    return PageResponse.of(items.map((o) => toOrderSummary(o, refunds.get(o.code))), page, size, total);
  }

  async getAdmin(code: string): Promise<OrderResponse> {
    const o = await this.repo.findByCode(code);
    if (!o) throw new NotFoundException(ORDER_ERR.NOT_FOUND, 'Không tìm thấy đơn hàng');
    return this.toResponse(o, true);
  }

  /*
   * Chuyển trạng thái theo lưới STAFF_TRANSITIONS. Hệ quả: confirmed → trừ kho thật (commit); delivered → COD thu tiền
   * (payment.markCodCollected → onPaid); completed → cộng sold_count. Mỗi bước: lịch sử + audit + thông báo khách + outbox.
   */
  async updateStatus(actor: AuthenticatedActor, code: string, next: string, opts: { trackingUrl?: string; carrier?: string; trackingCode?: string; note?: string }): Promise<OrderResponse> {
    // PLAN-0040 Tầng 3.6–3.7 (FUL-08, PLAN-0031 §2.1): chuyển `shipping` BẮT BUỘC hãng + mã vận đơn (thiếu ⇒ 400 ORDER_TRACKING_REQUIRED, chưa khoá/ghi gì); link tra cứu tự sinh theo hãng. Mọi đường vào
    // `shipping` đều qua đây nên đơn mới luôn có mã vận đơn (đơn đã `shipping` từ trước khi có cột này giữ NULL — vẫn báo giao/giao thất bại được).
    const proof = next === ORDER_STATUS.SHIPPING ? resolveShippingProof(opts) : null;
    const note = proof ? [`${carrierName(proof.carrier) ?? proof.carrier} · mã vận đơn ${proof.trackingCode}`, opts.note].filter(Boolean).join(' — ').slice(0, 500) : (opts.note ?? null);
    await this.prisma.$transaction(async (tx) => {
      const o = await this.repo.findByCodeForUpdate(code, tx);
      if (!o) throw new NotFoundException(ORDER_ERR.NOT_FOUND, 'Không tìm thấy đơn hàng');
      if (o.fulfilmentMode === 'carrier' && [ORDER_STATUS.SHIPPING,ORDER_STATUS.DELIVERED].includes(next as 'shipping'|'delivered')) throw new BusinessException('SHIPMENT_MANAGED_BY_CARRIER','Trạng thái giao hàng được cập nhật bởi hãng vận chuyển',409);
      if (!(STAFF_TRANSITIONS[o.status] ?? []).includes(next)) throw new BusinessException(ORDER_ERR.INVALID_TRANSITION, `Không thể chuyển từ "${STATUS_LABEL[o.status]}" sang "${STATUS_LABEL[next]}"`);
      if (next === ORDER_STATUS.CONFIRMED && o.paymentMethodCode !== PAYMENT_METHOD.COD && o.paymentStatus !== PAYMENT_STATUS.PAID) {
        throw new BusinessException(ORDER_ERR.INVALID_TRANSITION, 'Đơn thanh toán online chưa nhận được tiền — chưa xác nhận được');
      }
      const lines = o.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity }));
      const now = new Date();
      const stamps: Prisma.OrderUncheckedUpdateInput = { status: next, updatedBy: actor.userId, ...(opts.trackingUrl ? { trackingUrl: opts.trackingUrl } : {}) };
      if (next === ORDER_STATUS.CONFIRMED) {
        stamps.confirmedAt = now;
        stamps.shipDueAt = await this.slaDueAt(SETTING_KEY.ORDER_SHOP_SHIP_HOURS, 48, now); // PLAN-0027: hạn giao = lúc xác nhận + order.shop_ship_hours (luôn ghi; job chỉ hành động khi bật SLA)
        await this.inventory.commit(lines, { type: 'order', id: code }, tx);
      }
      if (next === ORDER_STATUS.PACKING) stamps.packedAt = now;
      if (next === ORDER_STATUS.SHIPPING && proof) {
        stamps.shippedAt = now;
        stamps.carrier = proof.carrier;
        stamps.trackingCode = proof.trackingCode;
        stamps.trackingUrl = proof.trackingUrl; // link do hệ thống sinh theo hãng (hoặc link https shop nhập cho hãng không có mẫu) — thay hẳn giá trị shop gửi
        // SHP-13: cùng mã vận đơn đã gắn cho đơn KHÁC (chưa huỷ) của shop ⇒ vẫn cho qua nhưng gắn cờ + báo CSKH (nghi một vận đơn dùng cho nhiều đơn để "giao" hàng giả).
        stamps.trackingReused = await this.repo.trackingCodeUsedByOther(o.shopId, proof.trackingCode, o.id, tx);
      }
      if (next === ORDER_STATUS.DELIVERED) {
        // PLAN-0031 §2.2 (SHP-06): khách đang báo CHƯA NHẬN hàng (yêu cầu not_received còn mở) ⇒ shop KHÔNG được báo "đã giao" (nếu không COD sẽ bị ghi thu + trừ hoa hồng trên chính đơn đang tranh chấp). Chặn ở đây = mọi đường vào `delivered`.
        if (await this.repo.hasOpenNotReceived(o.id, tx)) throw new BusinessException(ORDER_ERR.NOT_RECEIVED_OPEN, 'Khách đang báo chưa nhận được hàng của đơn này — hãy xử lý yêu cầu đó (duyệt hoàn hoặc từ chối kèm bằng chứng giao hàng) trước khi báo đã giao', 409);
        stamps.deliveredAt = now;
        if (o.paymentMethodCode === PAYMENT_METHOD.COD && o.paymentStatus !== PAYMENT_STATUS.PAID) await this.payment.markCodCollected(code, actor.userId, tx, { shopId: o.shopId, total: BigInt(o.total.toString()), commissionBase: commissionBase(o), platformCredit: BigInt(o.platformDiscount.toString()), commissionRate: o.commissionRateSnapshot.toString() });
      }
      if (next === ORDER_STATUS.COMPLETED) {
        // PLAN-0027 (SHP-04): không hoàn tất tay khi khách đang có yêu cầu đổi trả MỞ (hoàn tất mở escrow trong lúc đang tranh chấp).
        if (await this.repo.hasOpenReturn(o.id, tx)) throw new BusinessException(ORDER_ERR.HAS_OPEN_RETURN, 'Đơn đang có yêu cầu đổi trả chưa xử lý xong — chưa hoàn tất được', 409);
        stamps.completedAt = now;
        stamps.completedBy = 'staff';
        await this.productStats.addSold(o.items.map((i) => ({ productId: i.productId, quantity: i.quantity })), tx);
      }
      await this.repo.update(o.id, stamps, tx);
      await this.repo.addHistory(o.id, o.status, next, note, actor.userId, tx);
      await this.audit.write(tx, actor, { action: ORDER_AUDIT.STATUS_CHANGED, entityType: 'order', entityId: o.id, entityCode: code, before: { status: o.status }, after: { status: next, note, ...(proof ? { carrier: proof.carrier, trackingCode: proof.trackingCode } : {}) } });
      await this.notify.notify({ userId: o.userId, type: 'order', title: `Đơn ${code}: ${STATUS_LABEL[next]}`, content: note, link: `/account/orders/${code}` }, tx);
      if (proof && stamps.trackingReused === true) {
        // SHP-13: báo CSKH (quyền phân xử đổi trả) — mã vận đơn của đơn này đã gắn cho đơn khác của cùng shop.
        await this.audit.write(tx, actor, { action: ORDER_AUDIT.TRACKING_REUSED, entityType: 'order', entityId: o.id, entityCode: code, after: { carrier: proof.carrier, trackingCode: proof.trackingCode, shopId: o.shopId } });
        const staff = await this.users.staffUserIdsWithPermission('order.return.process');
        await this.notify.notifyMany(staff.map((userId) => ({ userId, type: 'order', title: `Mã vận đơn dùng lại — đơn ${code}`, content: `Mã ${proof.trackingCode} (${carrierName(proof.carrier) ?? proof.carrier}) đã được gian hàng dùng cho đơn khác. Cần đối chiếu với hãng vận chuyển.`, link: `/order/orders/${code}` })), tx);
      }
      await this.outbox.publish(tx, { eventType: next === ORDER_STATUS.DELIVERED ? ORDER_EVENT.DELIVERED : ORDER_EVENT.STATUS_CHANGED, aggregateType: 'order', aggregateId: o.id, payload: { orderCode: code, userId: o.userId, from: o.status, to: next } });
    });
    return this.getAdmin(code);
  }

  /*
   * Sàn (CSKH/Admin) huỷ thay khách. pending/confirmed như cũ; PLAN-0027 (CAN-08, SHOP-01f) thêm `packing` — tranh chấp / shop mất liên lạc (trước đây đơn đóng gói kẹt vì không ai huỷ được): nhập lại kho,
   * hoàn tiền nếu đã trả, báo CẢ khách LẪN shop. `packing`/`shipping` bắt buộc lý do ≥ 10 ký tự; `shipping` thêm: hàng ở đơn vị vận chuyển ⇒ KHÔNG tự nhập kho, còn đổi trả mở ⇒ 409.
   * `reasonCode` sàn: dispute | fraud | other (thiếu ⇒ other).
   */
  async cancelByStaff(actor: AuthenticatedActor, code: string, reason: string, extra: { reasonCode?: string } = {}): Promise<OrderResponse> {
    const { reasonCode, text } = resolveCancelReason('platform', { reason, reasonCode: extra.reasonCode });
    if(this.shippingCommands && text.length < 10 && (await this.repo.findByCode(code))?.fulfilmentMode==='carrier') throw new BusinessException('COMMON_VALIDATION_ERROR','Huỷ vận chuyển cần lý do ít nhất 10 ký tự');
    await this.cancelCarrierBeforeAction(actor,code);
    await this.prisma.$transaction(async (tx) => {
      const o = await this.repo.findByCodeForUpdate(code, tx);
      if (!o) throw new NotFoundException(ORDER_ERR.NOT_FOUND, 'Không tìm thấy đơn hàng');
      if(o.status===ORDER_STATUS.CANCELLED && o.fulfilmentMode==='carrier') return;
      if (!(STAFF_TRANSITIONS[o.status] ?? []).includes(ORDER_STATUS.CANCELLED)) throw new BusinessException(ORDER_ERR.CANNOT_CANCEL, `Không huỷ được đơn đang "${STATUS_LABEL[o.status]}"`);
      if (o.status === ORDER_STATUS.SHIPPING || o.status === ORDER_STATUS.PACKING) {
        // PLAN-0022: huỷ đơn ĐANG GIAO khi tranh chấp (thất lạc, COD bom…). Hàng đang ở đơn vị vận chuyển ⇒ bắt buộc lý do rõ, KHÔNG tự nhập kho; có yêu cầu đổi trả đang mở thì xử lý nó trước.
        if (text.length < 10) throw new BusinessException('COMMON_VALIDATION_ERROR', `Huỷ đơn ${o.status === ORDER_STATUS.SHIPPING ? 'đang giao' : 'đang đóng gói'} cần lý do rõ ràng (từ 10 ký tự)`);
      }
      if (o.status === ORDER_STATUS.SHIPPING && (await this.repo.hasOpenReturn(o.id, tx))) {
        throw new BusinessException(ORDER_ERR.HAS_OPEN_RETURN, 'Đơn đang có yêu cầu đổi trả chưa xử lý xong — hãy xử lý yêu cầu đó trước', 409);
      }
      const inTransit = o.status === ORDER_STATUS.SHIPPING || o.status === ORDER_STATUS.PACKING;
      await this.doCancel(o, text, actor, tx, {
        source: CANCEL_SOURCE.PLATFORM,
        reasonCode,
        // Đơn đã xác nhận/đang giao/đóng gói thì người đang xử lý (shop.order.update) phải biết ngay để dừng; đơn chờ xác nhận chỉ cần thông báo chung.
        notifyShop: inTransit ? { title: `Sàn đã huỷ đơn ${o.code} ${o.status === ORDER_STATUS.SHIPPING ? 'đang giao' : 'đang đóng gói'}`, content: text, permission: 'shop.order.update' } : undefined,
      });
    });
    return this.getAdmin(code);
  }

  /*
   * Shop huỷ đơn của CHÍNH mình (PLAN-0027 §2.2; quyền `shop.order.cancel`): pending/confirmed/packing (CAN-06/07). Khoá dòng đơn trước khi kiểm trạng thái → huỷ ↔ khách/CSKH/job đồng thời chỉ một bên thắng.
   * Đơn shop khác ⇒ 404. Đang giao trở đi ⇒ 409 (dùng "Giao không thành công" / sàn xử lý). Nếu khách đang có yêu cầu huỷ chờ duyệt thì việc huỷ này chốt luôn yêu cầu (accepted).
   * Điểm vi phạm (hết hàng / sai giá / từ chối yêu cầu huỷ rồi tự huỷ / huỷ đơn đã đóng gói) ghi qua listener ORDER_CANCELLED (idempotent) — payload mang cancelSource + reasonCode + fromStatus.
   */
  async cancelByShop(actor: AuthenticatedActor, shopId: string, code: string, input: { reason?: string; reasonCode?: string; note?: string }): Promise<void> {
    const { reasonCode, text } = resolveCancelReason('shop', input);
    if (text.length < 5) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Lý do huỷ cần ít nhất 5 ký tự');
    await this.cancelCarrierBeforeAction(actor,code,shopId);
    await this.prisma.$transaction(async (tx) => {
      const o = await this.repo.findByCodeForUpdate(code, tx);
      if (!o || o.shopId !== shopId) throw new NotFoundException(ORDER_ERR.NOT_FOUND, 'Không tìm thấy đơn hàng');
      if(o.status===ORDER_STATUS.CANCELLED && o.fulfilmentMode==='carrier') return;
      if (o.status !== ORDER_STATUS.PENDING && o.status !== ORDER_STATUS.CONFIRMED && o.status !== ORDER_STATUS.PACKING) {
        throw new BusinessException(ORDER_ERR.CANNOT_CANCEL, o.status === ORDER_STATUS.SHIPPING ? 'Đơn đang giao — hãy báo "Giao không thành công" khi khách không nhận, hoặc liên hệ sàn' : `Không huỷ được đơn đang "${STATUS_LABEL[o.status]}"`, 409);
      }
      await this.doCancel(o, text, actor, tx, { source: CANCEL_SOURCE.SHOP, reasonCode });
    });
  }

  /*
   * Shop báo đơn `shipping` GIAO KHÔNG THÀNH CÔNG (khách từ chối / không liên lạc được / thất lạc / khác) — lối thoát có chủ cho đơn kẹt `shipping` (PLAN-0022 §2). MỘT transaction,
   * khoá đơn: đơn → cancelled (lịch sử + lý do); `goodsReturned` ⇒ nhập kho lại (hàng đã về shop), ngược lại KHÔNG nhập; đơn ĐÃ THU tiền online ⇒ yêu cầu hoàn ĐỦ cho khách, đơn COD chưa
   * thu ⇒ không hoàn (doCancel); nhả voucher. Báo khách + CSKH; audit ORDER_DELIVERY_FAILED. shopId từ ngữ cảnh phiên: đơn shop khác ⇒ 404; đơn không ở `shipping` ⇒ 400; còn yêu cầu đổi trả mở ⇒ 409.
   */
  async deliveryFailed(actor: AuthenticatedActor, shopId: string, code: string, input: { reasonCode: DeliveryFailedReason; note: string; goodsReturned: boolean }): Promise<void> {
    const label = DELIVERY_FAILED_LABEL[input.reasonCode];
    const note = input.note.trim();
    const reason = `${label}: ${note}`.slice(0, 255);
    await this.prisma.$transaction(async (tx) => {
      const o = await this.repo.findByCodeForUpdate(code, tx);
      if (!o || o.shopId !== shopId) throw new NotFoundException(ORDER_ERR.NOT_FOUND, 'Không tìm thấy đơn hàng');
      if (o.status !== ORDER_STATUS.SHIPPING) throw new BusinessException(ORDER_ERR.INVALID_TRANSITION, `Chỉ báo giao không thành công khi đơn đang giao (hiện: "${STATUS_LABEL[o.status]}")`);
      if (await this.repo.hasOpenReturn(o.id, tx)) throw new BusinessException(ORDER_ERR.HAS_OPEN_RETURN, 'Đơn đang có yêu cầu đổi trả chưa xử lý xong — hãy xử lý yêu cầu đó trước', 409);
      const refunded = o.paymentStatus === PAYMENT_STATUS.PAID;
      await this.doCancel(o, reason, actor, tx, {
        restock: input.goodsReturned,
        notify: { title: `Giao hàng không thành công — đơn ${o.code} đã huỷ`, content: `${reason}.${refunded ? ' Chúng tôi sẽ hoàn lại toàn bộ số tiền bạn đã thanh toán.' : ''}` },
      });
      // PLAN-0031 §2.4 (SHP-09): ghi mốc giao thất bại + hàng đã về kho chưa. `goodsReturned=true` ⇒ doCancel đã nhập kho ⇒ đánh dấu luôn (route "hàng đã về" sẽ từ chối, không nhập kho hai lần); false ⇒ NULL để shop xác nhận sau.
      await this.repo.update(o.id, { deliveryFailedAt: new Date(), deliveryFailedReason: input.reasonCode, goodsReturnedAt: input.goodsReturned ? new Date() : null }, tx);
      // Sự kiện cho WP-08 (đếm "bom" của khách): consumer lọc theo `customerFault` (refused/unreachable) + `paymentMethod`; các lý do còn lại (địa chỉ, thất lạc, hư hỏng…) không phạt khách.
      await this.outbox.publish(tx, { eventType: ORDER_EVENT.DELIVERY_FAILED, aggregateType: 'order', aggregateId: o.id, payload: { orderCode: o.code, userId: o.userId, shopId, reasonCode: input.reasonCode, paymentMethod: o.paymentMethodCode, customerFault: DELIVERY_FAILED_CUSTOMER_FAULT.includes(input.reasonCode) } });
      await this.audit.write(tx, actor, { action: ORDER_AUDIT.DELIVERY_FAILED, entityType: 'order', entityId: o.id, entityCode: o.code, before: { status: o.status }, after: { reasonCode: input.reasonCode, note: note.slice(0, 200), goodsReturned: input.goodsReturned, refundRequested: refunded, shopId } });
      const staff = await this.users.staffUserIdsWithPermission('order.return.process');
      await this.notify.notifyMany(staff.map((userId) => ({ userId, type: 'order', title: `Giao không thành công — đơn ${o.code}`, content: `${reason}${input.goodsReturned ? ' · hàng đã về shop' : ''}`, link: `/order/orders/${o.code}` })), tx);
    });
    this.logger.log({ code, shopId, reasonCode: input.reasonCode, goodsReturned: input.goodsReturned }, 'Shop báo giao không thành công, đã huỷ đơn');
  }

  /*
   * PLAN-0031 §2.4 (SHP-09): shop xác nhận "HÀNG ĐÃ VỀ KHO" cho đơn đã huỷ vì giao thất bại mà lúc báo `goodsReturned=false` (hàng chưa về). Nhập kho lại đúng số đã giao, đúng MỘT lần: một transaction, khoá đơn;
   * `goods_returned_at` (NULL → now) kiểm dưới khoá đơn ⇒ bấm đúp / hai thiết bị cùng lúc chỉ nhập một lần (lần sau 409). Chỉ đơn của shop (shopId từ ngữ cảnh phiên; đơn shop khác ⇒ 404), chỉ đơn `cancelled`
   * có `delivery_failed_at` (đường huỷ khác — CSKH huỷ khi tranh chấp/thất lạc, khách huỷ… — không đi đường này), trong vòng GOODS_RETURN_WINDOW_DAYS ngày kể từ lúc báo giao thất bại. Ghi lịch sử + audit.
   */
  async goodsReturned(actor: AuthenticatedActor, shopId: string, code: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const o = await this.repo.findByCodeForUpdate(code, tx);
      if (!o || o.shopId !== shopId) throw new NotFoundException(ORDER_ERR.NOT_FOUND, 'Không tìm thấy đơn hàng');
      if (o.status !== ORDER_STATUS.CANCELLED || !o.deliveryFailedAt) throw new BusinessException(ORDER_ERR.GOODS_RETURN_NOT_ALLOWED, 'Chỉ xác nhận "hàng đã về kho" cho đơn đã huỷ vì giao hàng không thành công');
      if (o.goodsReturnedAt) throw new BusinessException(ORDER_ERR.GOODS_ALREADY_RETURNED, 'Hàng của đơn này đã được xác nhận về kho và nhập kho trước đó', 409);
      if (Date.now() - o.deliveryFailedAt.getTime() > GOODS_RETURN_WINDOW_DAYS * 86_400_000) throw new BusinessException(ORDER_ERR.GOODS_RETURN_NOT_ALLOWED, `Đã quá ${GOODS_RETURN_WINDOW_DAYS} ngày kể từ lúc báo giao không thành công — liên hệ CSKH để điều chỉnh kho`, 409);
      await this.inventory.restock(o.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })), { type: 'order', id: o.code }, tx);
      await this.repo.update(o.id, { goodsReturnedAt: new Date(), updatedBy: actor.userId }, tx);
      await this.repo.addHistory(o.id, o.status, o.status, 'Shop xác nhận hàng đã về kho — đã nhập kho lại', actor.userId, tx);
      await this.audit.write(tx, actor, { action: ORDER_AUDIT.GOODS_RETURNED, entityType: 'order', entityId: o.id, entityCode: o.code, after: { shopId, reasonCode: o.deliveryFailedReason, deliveryFailedAt: o.deliveryFailedAt.toISOString(), items: o.items.length } });
    });
    this.logger.log({ code, shopId }, 'Shop xác nhận hàng đã về kho, đã nhập kho lại');
  }

  /*
   * PLAN-0027: PUBLIC (OrderFulfilmentService/OrderSlaService gọi trong tx đã KHOÁ dòng đơn — thứ tự khoá ĐƠN → PAYMENT → ví). Mở rộng so với bản cũ:
   *  - `opts.source` + `opts.reasonCode`: ai huỷ + mã lý do (cột cancel_source / cancel_reason_code, có trong payload ORDER_CANCELLED). Không nêu ⇒ suy ra từ người thao tác (inferCancelSource).
   *  - đơn `partially_refunded` (G14, CAN-13): hoàn PHẦN CÒN LẠI = total − các khoản hoàn theo đơn đã phát sinh (payments.orderRefundCommitted) — không vượt số đã thu, không hoàn hai lần.
   *  - THÔNG BÁO THÀNH VIÊN SHOP (G12) cùng tx khi caller nêu `source` (≠ shop): khách/sàn/hệ thống huỷ thì shop PHẢI biết để không đóng gói nhầm. `opts.notifyShop` = false để bỏ, hoặc {title,content,permission} để tuỳ biến.
   *  - đơn có yêu cầu huỷ đang chờ ⇒ chốt yêu cầu (`opts.requestResolution`, mặc định accepted) cùng lúc.
   * Giữ nguyên: `opts.restock` (mặc định nhập kho lại, trừ đơn `shipping` — hàng ở đơn vị vận chuyển, chỉ nhập khi shop xác nhận hàng đã về / goodsReturned; đơn `pending` luôn NHẢ giữ chỗ) và
   * `opts.notify` (nội dung thông báo cho khách, mặc định "Đơn X đã huỷ" + lý do).
   */
  async doCancel(
    o: OrderRow,
    reason: string,
    actor: AuthenticatedActor | null,
    tx: Tx,
    opts: { restock?: boolean; notify?: { title: string; content: string }; source?: CancelSource; reasonCode?: string | null; notifyShop?: boolean | { title: string; content?: string; permission: string }; requestResolution?: CancelRequestStatus } = {},
  ): Promise<void> {
    if (o.fulfilmentMode === 'carrier' && this.shippingCommands) {
      const shipment = await this.shippingCommands.barrier(o.code,tx);
      if (shipment?.active) throw new BusinessException('SHIPMENT_OPERATION_PENDING','Vui lòng huỷ yêu cầu vận chuyển và chờ hãng xác nhận trước khi huỷ đơn',409);
    }
    const source = opts.source ?? inferCancelSource(actor?.userId ?? null, o.userId);
    const lines = o.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity }));
    if (o.status === ORDER_STATUS.PENDING) await this.inventory.release(lines, { type: 'order', id: o.code }, tx);
    else if (opts.restock ?? o.status !== ORDER_STATUS.SHIPPING) await this.inventory.restock(lines, { type: 'order', id: o.code }, tx);
    await this.promotion.release(o.code, tx); // voucher shop (lượt dùng gắn mã đơn con)
    // Voucher sàn gắn mã đơn CHA: chỉ nhả khi KHÔNG còn đơn con nào khác còn hiệu lực trong nhóm.
    const sibling = await this.repo.groupSiblingInfo(o.orderGroupId, o.id, tx);
    if (sibling && sibling.activeOthers === 0) await this.promotion.release(sibling.groupCode, tx);
    let refundRequested = false;
    if (o.paymentStatus === PAYMENT_STATUS.PAID) {
      await this.payment.requestRefund({ orderCode: o.code, shopId: o.shopId, amount: BigInt(o.total.toString()), reason: refundReason('Huỷ đơn: ', reason), returnRequestId: null, actorUserId: actor?.userId ?? null }, tx);
      refundRequested = true;
    } else if (o.paymentStatus === PAYMENT_STATUS.PARTIALLY_REFUNDED) {
      // G14/CAN-13: đã hoàn MỘT PHẦN (đổi trả…) ⇒ hoàn nốt phần còn lại. Đã khoá dòng đơn nên không có khoản hoàn mới chen vào giữa lúc tính.
      const remaining = BigInt(o.total.toString()) - (await this.payments.orderRefundCommitted(o.code, tx));
      if (remaining > 0n) {
        await this.payment.requestRefund({ orderCode: o.code, shopId: o.shopId, amount: remaining, reason: refundReason('Huỷ đơn (hoàn phần còn lại): ', reason), returnRequestId: null, actorUserId: actor?.userId ?? null }, tx);
        refundRequested = true;
      }
    } else {
      await this.payment.cancel(o.code, reason, tx);
    }
    const resolvesRequest = o.cancelRequestStatus === CANCEL_REQUEST_STATUS.PENDING;
    await this.repo.update(
      o.id,
      {
        status: ORDER_STATUS.CANCELLED,
        cancelReason: reason,
        cancelReasonCode: opts.reasonCode ?? null,
        cancelSource: source,
        cancelledAt: new Date(),
        cancelledBy: actor?.userId ?? null,
        updatedBy: actor?.userId ?? null,
        ...(resolvesRequest ? { cancelRequestStatus: opts.requestResolution ?? CANCEL_REQUEST_STATUS.ACCEPTED, cancelRequestResolvedBy: actor?.userId ?? null } : {}),
      },
      tx,
    );
    await this.repo.addHistory(o.id, o.status, ORDER_STATUS.CANCELLED, reason, actor?.userId ?? null, tx);
    await this.audit.write(tx, actor, { action: ORDER_AUDIT.CANCELLED, entityType: 'order', entityId: o.id, entityCode: o.code, before: { status: o.status }, after: { reason, reasonCode: opts.reasonCode ?? null, source, refund: refundRequested } });
    await this.notify.notify({ userId: o.userId, type: 'order', title: opts.notify?.title ?? `Đơn ${o.code} đã huỷ`, content: opts.notify?.content ?? reason, link: `/account/orders/${o.code}` }, tx);
    const shopNote =
      opts.notifyShop === false
        ? null
        : typeof opts.notifyShop === 'object'
          ? opts.notifyShop
          : opts.notifyShop === true || (opts.source !== undefined && source !== CANCEL_SOURCE.SHOP)
            ? { title: `Đơn ${o.code} đã bị huỷ`, content: `${CANCEL_SOURCE_LABEL[source]} đã huỷ đơn: ${reason}`, permission: 'shop.order.read' }
            : null;
    if (shopNote) {
      const members = await this.shops.memberUserIdsWithPermission(o.shopId, shopNote.permission);
      await this.notify.notifyMany(members.map((userId) => ({ userId, type: 'order', title: shopNote.title, content: shopNote.content ?? reason, link: `/vendor/orders/${o.code}` })), tx);
    }
    await this.outbox.publish(tx, {
      eventType: ORDER_EVENT.CANCELLED,
      aggregateType: 'order',
      aggregateId: o.id,
      payload: { orderCode: o.code, userId: o.userId, reason, shopId: o.shopId, cancelSource: source, reasonCode: opts.reasonCode ?? null, fromStatus: o.status, hadRejectedRequest: o.cancelRequestStatus === CANCEL_REQUEST_STATUS.REJECTED },
    });
  }

  /* PLAN-0027: hạn chót = mốc + N giờ (setting; 0/lỗi ⇒ mặc định). LUÔN ghi lúc đặt/xác nhận — vô hại khi SLA tắt, job chỉ hành động khi `order.sla_enabled`. */
  private async slaDueAt(key: string, fallbackHours: number, from: Date = new Date()): Promise<Date> {
    const hours = await this.system.settingNumber(key);
    return new Date(from.getTime() + (hours > 0 ? hours : fallbackHours) * 3_600_000);
  }

  // ================================================================ cổng ngược từ payment

  /* Payment khoá đơn TRƯỚC khi khoá payment (thứ tự khoá đơn → payment, cùng thứ tự với huỷ/đổi trạng thái) — chống deadlock webhook ↔ khách huỷ (AUD-01). */
  async lockOrder(orderCode: string, tx: Tx): Promise<void> {
    await this.repo.lockByCode(orderCode, tx);
  }

  async onPaid(orderCode: string, info: { paymentId: string; methodCode: string; transactionCode: string | null; bankCode: string | null; paidAt: Date }, tx: Tx): Promise<void> {
    const o = await this.repo.findByCodeForUpdate(orderCode, tx);
    if (!o) throw new NotFoundException(ORDER_ERR.NOT_FOUND, `Không tìm thấy đơn ${orderCode}`);
    if (o.paymentStatus === PAYMENT_STATUS.PAID) return; // IPN lặp — đã xử lý
    // Tiền về sau khi đơn đã huỷ/trả (khách quét QR rồi huỷ, webhook đến muộn): ghi nhận đã thu rồi TẠO NGAY yêu cầu hoàn đủ — không để tiền nằm ở sàn không ai biết.
    if (o.status === ORDER_STATUS.CANCELLED || o.status === ORDER_STATUS.RETURNED) {
      await this.repo.update(o.id, { paymentStatus: PAYMENT_STATUS.PAID, paymentExpiresAt: null, updatedBy: null }, tx);
      if(o.collectionMode==='carrier_cod' && (await this.payments.orderRefundCommitted(o.code,tx))>0n) return;
      await this.payment.requestRefund({ orderCode, shopId: o.shopId, amount: BigInt(o.total.toString()), reason: 'Thanh toán đến sau khi đơn đã huỷ', returnRequestId: null, actorUserId: null, paymentId: info.paymentId }, tx);
      await this.audit.write(tx, null, { action: ORDER_AUDIT.PAID, entityType: 'order', entityId: o.id, entityCode: orderCode, after: { method: info.methodCode, lateAfter: o.status, refundRequested: true } });
      await this.notify.notify({ userId: o.userId, type: 'payment', title: `Đơn ${orderCode} đã huỷ — khoản thanh toán sẽ được hoàn`, content: 'Hệ thống nhận được thanh toán sau khi đơn bị huỷ. Chúng tôi sẽ hoàn lại toàn bộ số tiền.', link: `/account/orders/${orderCode}` }, tx);
      return;
    }
    await this.repo.update(o.id, { paymentStatus: PAYMENT_STATUS.PAID, paymentExpiresAt: null, updatedBy: null }, tx);
    // PLAN-0027: tiền PayOS về ⇒ đơn mới thật sự vào hàng đợi của shop: hạn xác nhận tính từ lúc nhận tiền (COD đã có hạn từ lúc đặt; onPaid của COD chạy lúc giao).
    if (o.paymentMethodCode !== PAYMENT_METHOD.COD) await this.repo.update(o.id, { confirmDueAt: await this.slaDueAt(SETTING_KEY.ORDER_SHOP_CONFIRM_HOURS, 24, info.paidAt), confirmRemindedAt: null }, tx);
    await this.audit.write(tx, null, { action: ORDER_AUDIT.PAID, entityType: 'order', entityId: o.id, entityCode: orderCode, after: { method: info.methodCode, transactionCode: info.transactionCode } });
    if (o.paymentMethodCode !== PAYMENT_METHOD.COD) {
      await this.notify.notify({ userId: o.userId, type: 'payment', title: `Đã nhận thanh toán đơn ${orderCode}`, content: `Cảm ơn bạn. Đơn sẽ được xác nhận và đóng gói sớm.`, link: `/account/orders/${orderCode}` }, tx);
      // PLAN-0040 tầng 4 (AUD-11a / NTF-03): bỏ "Đơn … đã thanh toán" gửi mọi người có quyền cập nhật trạng thái — người cần hành động là SHOP (listener ORDER_PAID ở system-worker) và khách; sàn theo dõi qua số đếm dashboard.
    }
    await this.outbox.publish(tx, { eventType: ORDER_EVENT.PAID, aggregateType: 'order', aggregateId: o.id, payload: { orderCode, userId: o.userId, methodCode: info.methodCode } });
  }

  async onPaymentFailed(orderCode: string, reason: string, tx: Tx): Promise<void> {
    const o = await this.repo.findByCodeForUpdate(orderCode, tx);
    if (!o || o.status !== ORDER_STATUS.PENDING || o.paymentStatus === PAYMENT_STATUS.PAID) return;
    await this.repo.addHistory(o.id, o.status, o.status, `Thanh toán thất bại: ${reason}`, null, tx);
    await this.notify.notify({ userId: o.userId, type: 'payment', title: `Thanh toán đơn ${orderCode} không thành công`, content: `${reason}. Bạn có thể thử lại trong trang đơn hàng.`, link: `/account/orders/${orderCode}` }, tx);
  }

  async onRefunded(orderCode: string, amount: bigint, refundId: string, tx: Tx, fullyRefunded?: boolean): Promise<void> {
    const o = await this.repo.findByCodeForUpdate(orderCode, tx);
    if (!o) return;
    // Hoàn LUỸ KẾ: payment báo đã hoàn đủ chưa; không tự đoán từ một khoản lẻ (60k + 40k trên đơn 100k phải ra "refunded").
    const full = fullyRefunded ?? amount >= BigInt(o.total.toString());
    await this.repo.update(o.id, { paymentStatus: full ? PAYMENT_STATUS.REFUNDED : PAYMENT_STATUS.PARTIALLY_REFUNDED, updatedBy: null }, tx);
    await this.repo.addHistory(o.id, o.status, o.status, `Đã hoàn ${money(amount).display}`, null, tx);
    await this.notify.notify({ userId: o.userId, type: 'payment', title: `Đã hoàn tiền đơn ${orderCode}`, content: `Số tiền ${money(amount).display} đã được hoàn.`, link: `/account/orders/${orderCode}`, payload: { refundId } }, tx);
  }

  // ================================================================ jobs (worker)

  async cancelExpired(limit = 50): Promise<number> {
    // PLAN-0025 (G02): chỉ huỷ khi đã quá hạn + ân hạn VÀ cổng xác nhận CHƯA trả. Hỏi PayOS NGOÀI transaction; khách đã trả mà webhook trễ thì được ghi nhận, không bị huỷ oan.
    const grace = await this.system.settingNumber(SETTING_KEY.ORDER_PAYMENT_GRACE_MINUTES);
    const rows = await this.repo.findPaymentExpired(limit, grace);
    let n = 0;
    for (const { code, paymentExpiresAt } of rows) {
      try {
        const gateway = await this.payment.confirmPaymentStatus(code);
        if (gateway === 'paid') continue; // đã ghi nhận qua đường webhook/poll — đơn không còn quá hạn
        // Không tra được PayOS: để lần sau; chỉ huỷ khi đã quá hạn + ân hạn + 60 phút mà PayOS vẫn không trả lời (tránh kẹt giữ kho vô hạn).
        if (gateway === 'unknown' && !(paymentExpiresAt && Date.now() - paymentExpiresAt.getTime() > (grace + 60) * 60_000)) continue;
        await this.prisma.$transaction(async (tx) => {
          const o = await this.repo.findByCodeForUpdate(code, tx);
          if (!o || o.status !== ORDER_STATUS.PENDING || o.paymentStatus === PAYMENT_STATUS.PAID) return;
          await this.doCancel(o, 'Quá hạn thanh toán', null, tx, { source: CANCEL_SOURCE.SYSTEM, reasonCode: 'payment_expired', notifyShop: false });
          n += 1;
        });
      } catch (err) {
        this.logger.warn({ err, code }, 'Huỷ đơn quá hạn lỗi');
      }
    }
    return n;
  }

  /* Tự hoàn tất đơn đã giao quá N ngày. Lặp theo lô (cũ nhất trước) tới hết — tồn đọng làm trễ escrow/đối soát. Phát ORDER_STATUS_CHANGED như
     updateStatus: listener ví COD trừ hoa hồng CHỈ nghe sự kiện này (thiếu nó thì hoa hồng COD không bao giờ bị trừ khi đơn tự hoàn tất). */
  async autoComplete(limit = 100): Promise<number> {
    const days = await this.system.settingNumber(SETTING_KEY.ORDER_AUTO_COMPLETE_DAYS);
    const before = new Date(Date.now() - days * 86_400_000);
    let n = 0;
    const failed = new Set<string>(); // đơn lỗi trong lần chạy này — loại khỏi các lô sau để không "đói" các đơn tốt đứng sau (sắp cũ nhất trước)
    for (let batch = 0; batch < 50; batch += 1) {
      const rows = await this.repo.findDeliveredBefore(before, limit, [...failed]);
      if (rows.length === 0) break;
      for (const { code } of rows) {
        try {
          await this.prisma.$transaction(async (tx) => {
            const o = await this.repo.findByCodeForUpdate(code, tx);
            if (!o || o.status !== ORDER_STATUS.DELIVERED) return;
            // PLAN-0027 (SHP-04, G13): khách vừa mở yêu cầu đổi trả ⇒ KHÔNG hoàn tất (finder đã lọc, nhưng yêu cầu có thể mở giữa lúc quét và lúc khoá). Loại khỏi các lô sau của lần chạy này.
            if (await this.repo.hasOpenReturn(o.id, tx)) {
              failed.add(code);
              return;
            }
            await this.repo.update(o.id, { status: ORDER_STATUS.COMPLETED, completedAt: new Date(), completedBy: 'system' }, tx);
            await this.repo.addHistory(o.id, o.status, ORDER_STATUS.COMPLETED, `Tự hoàn tất sau ${days} ngày`, null, tx);
            await this.productStats.addSold(o.items.map((i) => ({ productId: i.productId, quantity: i.quantity })), tx);
            await this.audit.write(tx, null, { action: ORDER_AUDIT.STATUS_CHANGED, entityType: 'order', entityId: o.id, entityCode: code, before: { status: o.status }, after: { status: ORDER_STATUS.COMPLETED, note: `Tự hoàn tất sau ${days} ngày` } });
            await this.outbox.publish(tx, { eventType: ORDER_EVENT.STATUS_CHANGED, aggregateType: 'order', aggregateId: o.id, payload: { orderCode: code, userId: o.userId, from: o.status, to: ORDER_STATUS.COMPLETED } });
            n += 1;
          });
        } catch (err) {
          failed.add(code);
          this.logger.warn({ err, code }, 'Tự hoàn tất đơn lỗi');
        }
      }
      if (rows.length < limit) break; // lô cuối chưa đầy ⇒ đã hết
    }
    return n;
  }

  /* Cổng cho payment (AUD-05): thanh toán lại ⇒ kéo dài hạn thanh toán của đơn. Khoá đơn trước (thứ tự ĐƠN → PAYMENT). */
  async extendPaymentDeadline(orderCode: string, until: Date, tx: Tx): Promise<void> {
    const o = await this.repo.findByCodeForUpdate(orderCode, tx);
    if (!o || o.status !== ORDER_STATUS.PENDING || o.paymentStatus === PAYMENT_STATUS.PAID) return;
    if (o.paymentExpiresAt && o.paymentExpiresAt.getTime() >= until.getTime()) return;
    await this.repo.update(o.id, { paymentExpiresAt: until, updatedBy: null }, tx);
  }

  /* Cổng cho payment: còn cho thanh toán/thử lại link được không (đơn còn pending và chưa thu tiền). */
  async canRetryPayment(orderCode: string): Promise<boolean> {
    const o = await this.repo.findByCode(orderCode);
    return !!o && o.status === ORDER_STATUS.PENDING && o.paymentStatus !== PAYMENT_STATUS.PAID;
  }

  /* Bảo vệ: chỉ chủ đơn hoặc nhân viên có quyền mới xem — dùng cho route dùng chung. */
  assertOwner(o: OrderRow, actor: AuthenticatedActor): void {
    if (o.userId !== actor.userId) throw new ForbiddenException(ORDER_ERR.NOT_FOUND, 'Không tìm thấy đơn hàng');
  }
}
