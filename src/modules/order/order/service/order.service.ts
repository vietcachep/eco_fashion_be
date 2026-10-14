import { Inject, Injectable, Logger } from '@nestjs/common';
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
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { Basket, CartQueryApi } from '../../../cart/queryapi/cart.queryapi';
import { AddressBrief, IdentityQueryApi } from '../../../identity/queryapi/identity.queryapi';
import { PaymentQueryApi } from '../../../payment/queryapi/payment.queryapi';
import { ShopBrief, ShopQueryApi } from '../../../shop/queryapi/shop.queryapi';
import { SETTING_KEY } from '../../../system/enums/setting-keys';
import { SystemQueryApi } from '../../../system/queryapi/system.queryapi';
import { OrderAuditLogService } from '../../audit/order-audit-log.service';
import { ORDER_AUDIT, ORDER_ERR, ORDER_EVENT, ORDER_STATUS, PAYMENT_METHOD, PAYMENT_STATUS, STAFF_TRANSITIONS, STATUS_LABEL } from '../../foundation/order.constants';
import { OrderOutboxService } from '../../outbox/order-outbox.service';
import { CheckoutSummaryResponse, OrderGroupResponse, OrderResponse, OrderSummaryResponse } from '../dto/order.responses';
import { toOrderGroupResponse, toOrderResponse, toOrderSummary } from '../mapper/order.mapper';
import { OrderListFilter, OrderRepository, OrderRow } from '../repository/order.repository';

export interface CheckoutAddress {
  recipientName: string;
  phone: string;
  provinceCode: string | null;
  provinceName: string;
  districtName: string | null;
  wardName: string | null;
  street: string;
}

export interface PlaceOrderInput {
  addressId?: string;
  address?: CheckoutAddress;
  paymentMethodCode: string;
  bankCode?: string | null;
  note?: string;
  /* Mã khách nhập: tối đa 1 mã SÀN + 1 mã GIAN HÀNG cho mỗi shop trong giỏ (voucherCode + voucherCodes gộp, bỏ trùng). */
  voucherCode?: string | null;
  voucherCodes?: string[];
}

/* Một gói hàng theo shop trong giỏ (PLAN-0014 bước 7) — 1 gói = 1 Order con sau này. Phí ship tính RIÊNG
   theo subtotal của gói này (bảng giá vẫn dùng chung toàn sàn — quyết định "shipping fee shared platform
   table" — nhưng SỐ TIỀN phải tính theo từng gói vì mỗi shop giao hàng độc lập, khác gói vận đơn). */
interface ShopGroupPriced {
  shopId: string;
  lines: Basket['lines'];
  subtotal: bigint;
  shippingFee: bigint;
}

/* Gói đã trừ voucher: shopDiscount do SHOP chịu, platformDiscount do SÀN chịu (phần phân bổ của voucher sàn). */
interface PricedGroup extends ShopGroupPriced {
  shopDiscount: bigint;
  platformDiscount: bigint;
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
 * (COD/VietQR/VNPay URL) → thông báo nhân viên + outbox ORDER_CREATED (mail) → idempotency complete.
 * Idempotency-Key: gửi lại cùng key → trả đúng đơn cũ, KHÔNG tạo đơn/giữ kho hai lần. Tiền: server tính toàn bộ.
 */
@Injectable()
export class OrderService {
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
  ) {}

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
    return lines.map((l) => ({ productId: l.productId, categorySlug: l.categorySlug, lineTotal: l.lineTotal }));
  }

  /*
   * Tính tiền cả giỏ. Voucher: tối đa 1 mã SÀN (tính trên cả giỏ, SÀN chịu, phân bổ về các đơn con theo tỉ lệ) + tối đa 1 mã GIAN HÀNG
   * cho mỗi shop có trong giỏ (tính trên riêng phần hàng của shop đó, SHOP chịu). Mã thứ hai cùng loại/cùng shop, hoặc mã shop không có
   * trong giỏ → bị từ chối kèm lý do (không im lặng bỏ qua).
   */
  private async price(userId: string, provinceHint: string | null, codes: string[]): Promise<Priced> {
    const basket = await this.cart.basketOf(userId, true);
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
      raw.push({ shopId, lines, subtotal: groupSubtotal, shippingFee: fee });
    }
    const subtotal = raw.reduce((s, g) => s + g.subtotal, 0n);
    const shippingFee = raw.reduce((s, g) => s + g.shippingFee, 0n);

    // ---- voucher
    const vouchers: VoucherPlan[] = [];
    if (subtotal > 0n) {
      let platformTaken = false;
      const shopTaken = new Set<string>();
      const wholeBasket = { userId, subtotal, shippingFee, lines: OrderService.promoLines(sellable) };
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

    const weight = (g: ShopGroupPriced) => (platform?.type === 'free_shipping' ? g.shippingFee : g.subtotal);
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
      const rawShop = shopQuote.get(g.shopId)?.discount ?? 0n;
      const shopDiscount = rawShop > cap ? cap : rawShop;
      let platformDiscount = platformShare > cap - shopDiscount ? cap - shopDiscount : platformShare;
      // Freeship sàn + freeship shop trên cùng đơn con: tổng hai mã không được vượt phí ship (shop ưu tiên) — nếu không phần dư sẽ trừ vào tiền hàng.
      if (platform?.type === 'free_shipping' && shopQuote.get(g.shopId)?.type === 'free_shipping') {
        const room = g.shippingFee - shopDiscount; // phần phí ship còn lại sau voucher shop
        if (platformDiscount > room) platformDiscount = room > 0n ? room : 0n;
      }
      const discount = shopDiscount + platformDiscount;
      return { ...g, shopDiscount, platformDiscount, discount, total: cap - discount };
    });
  }

  private async resolveProvinceHint(userId: string, q: { province?: string; addressId?: string }): Promise<string | null> {
    if (q.province) return q.province;
    const a = q.addressId ? await this.identity.findAddress(userId, q.addressId) : await this.identity.defaultAddress(userId);
    return a?.provinceCode ?? a?.provinceName ?? null;
  }

  async checkoutSummary(actor: AuthenticatedActor, q: { voucherCode?: string; voucherCodes?: string[]; province?: string; addressId?: string }): Promise<CheckoutSummaryResponse> {
    const hint = await this.resolveProvinceHint(actor.userId, q);
    const p = await this.price(actor.userId, hint, OrderService.normalizeCodes(q));
    const shopGroups = await Promise.all(
      p.groups.map(async (g) => {
        const shop = await this.shops.findBrief(g.shopId);
        return { shopId: g.shopId, shopName: shop?.name ?? 'Gian hàng', itemCount: g.lines.reduce((n, l) => n + l.quantity, 0), subtotal: money(g.subtotal), shippingFee: money(g.shippingFee), discount: money(g.discount), total: money(g.total) };
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
    // 2. Phương thức thanh toán (FE `card` = VNPay thẻ quốc tế) — DÙNG CHUNG cho mọi đơn con trong lần checkout này
    const methodCode = input.paymentMethodCode === 'card' ? PAYMENT_METHOD.VNPAY : input.paymentMethodCode;
    const bankCode = input.paymentMethodCode === 'card' ? 'INTCARD' : (input.bankCode ?? null);
    if (!(await this.payment.isMethodActive(methodCode))) throw new BusinessException(ORDER_ERR.PAYMENT_METHOD_INVALID, 'Phương thức thanh toán không khả dụng');

    const requestHash = IdempotencyService.hashRequest({ userId: actor.userId, address, methodCode, note: input.note ?? null, vouchers: OrderService.normalizeCodes(input).map((c) => c.toUpperCase()).sort() });
    const groupCode = await this.prisma.$transaction(
      async (tx) => {
        const idem = idempotencyKey ? await IdempotencyService.begin<{ code: string }>(tx.orderIdempotencyKey, { scope: 'place-order', actorKey: actor.userId, key: idempotencyKey, requestHash, ttlHours: 24 }) : null;
        if (idem?.replay) return idem.replay.code;

        // 3. Giỏ + tiền theo từng shop (đọc trong tx để nhất quán)
        const p = await this.price(actor.userId, address.provinceCode ?? address.provinceName, OrderService.normalizeCodes(input));
        if (p.groups.length === 0) throw new BusinessException(ORDER_ERR.CART_EMPTY, 'Giỏ hàng trống hoặc không còn sản phẩm nào bán được');
        if (p.warnings.length > 0) throw new BusinessException(ORDER_ERR.CART_CHANGED, `Giỏ hàng có thay đổi: ${p.warnings.join('; ')}`, 409);
        const zero = p.groups.find((g) => g.total <= 0n);
        if (zero) throw new BusinessException(ORDER_ERR.PROMOTION_INVALID, 'Đơn của một gian hàng được giảm hết giá trị — vui lòng gỡ bớt mã giảm giá', 409);
        // Chống "mua chéo" (wash-trade): thành viên của một gian hàng không được mua hàng của CHÍNH gian hàng đó — nếu không họ tự giao hàng, tự đánh giá 5★,
        // và lấy phần voucher sàn hoàn lại. Đọc thẳng trong tx (không tin cache).
        for (const g of p.groups) {
          if ((await this.shops.activeMemberUserIds(g.shopId)).includes(actor.userId)) throw new BusinessException(ORDER_ERR.SHOP_NOT_AVAILABLE, 'Bạn không thể mua sản phẩm của chính gian hàng mình', 409);
        }
        const rejected = p.vouchers.find((v) => !v.quote.ok);
        if (rejected) throw new BusinessException(ORDER_ERR.PROMOTION_INVALID, `${rejected.quote.code}: ${rejected.quote.error ?? 'Mã giảm giá không hợp lệ'}`);

        // 3b. Đọc THẲNG trạng thái từng shop trong tx (không tin cache) — sàn khoá gian hàng giữa lúc khách bấm đặt
        // hàng thì chặn ngay, không để lọt đơn (PLAN-0014 mục 8, học từ race-condition đã phát hiện ở bước 1-4).
        const shopBriefs = new Map<string, ShopBrief>();
        for (const g of p.groups) {
          const shop = await this.shops.findBrief(g.shopId);
          if (!shop || shop.status !== 'approved') throw new BusinessException(ORDER_ERR.SHOP_NOT_AVAILABLE, `Gian hàng "${shop?.name ?? g.shopId}" hiện không thể đặt hàng — vui lòng bỏ sản phẩm này khỏi giỏ`, 409);
          if (methodCode === PAYMENT_METHOD.COD && !shop.codEnabled) throw new BusinessException(ORDER_ERR.SHOP_COD_DISABLED, `Gian hàng "${shop.name}" tạm ngừng nhận thanh toán khi nhận hàng (COD) — vui lòng chọn chuyển khoản/VNPay hoặc bỏ sản phẩm của gian hàng này`, 409);
          shopBriefs.set(g.shopId, shop);
        }

        // 3c. Hạn mức COD kiểm THEO TỪNG ĐƠN CON — mỗi shop thu tiền độc lập (N gói hàng, N lần thu COD)
        if (methodCode === PAYMENT_METHOD.COD) {
          const max = await this.system.settingNumber(SETTING_KEY.ORDER_COD_MAX_AMOUNT);
          if (max > 0) {
            const over = p.groups.find((g) => g.total > BigInt(max));
            if (over) throw new BusinessException(ORDER_ERR.COD_LIMIT, `Đơn trên ${money(max).display} vui lòng thanh toán trước (chuyển khoản/VNPay)`);
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
            : { userId: actor.userId, subtotal: p.subtotal, shippingFee: p.shippingFee, lines: OrderService.promoLines(p.groups.flatMap((g) => g.lines)) };
          const orderRef = group ? (childCodes.get(group.shopId) as string) : groupCode;
          const consumed = await this.promotion.consume(v.quote.code, basket, orderRef, tx);
          if (!consumed.ok) throw new BusinessException(ORDER_ERR.PROMOTION_INVALID, `${v.quote.code}: ${consumed.error ?? 'Mã giảm giá không còn hiệu lực'}`);
          if (consumed.discount !== v.quote.discount) throw new BusinessException(ORDER_ERR.PROMOTION_INVALID, `Mã ${v.quote.code} vừa thay đổi điều kiện, vui lòng kiểm tra lại`, 409);
          if (group) promoByShop.set(group.shopId, consumed);
          else platformPromo = consumed;
        }
        const groups = p.groups;
        const discount = p.discount;
        const groupTotal = p.total;

        // 5. Tạo đơn cha (snapshot địa chỉ + tổng cả giỏ)
        const shippingAddress = [address.street, address.wardName, address.districtName, p.province?.name ?? address.provinceName].filter(Boolean).join(', ');
        const expiresAt = await this.paymentExpiry(methodCode);
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

        const staff = await this.users.staffUserIdsWithPermission('order.order.read');
        const clientIp = RequestTraceContext.current()?.ip ?? '127.0.0.1';
        const purchasedVariantIds: string[] = [];

        // 6. Tạo TỪNG đơn con theo shop — giữ NGUYÊN logic hiện có (snapshot/reserve/payment) cho mỗi đơn
        for (const g of groups) {
          const shop = shopBriefs.get(g.shopId)!;
          const orderCode = childCodes.get(g.shopId) as string;
          const shopPromo = promoByShop.get(g.shopId) ?? null;
          const order = await this.repo.create(
            {
              code: orderCode,
              userId: actor.userId,
              shopId: g.shopId,
              orderGroupId: group.id,
              commissionRateSnapshot: shop.commissionRate,
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
              promotionCode: platformPromo?.code ?? null,
              promotionName: platformPromo?.name ?? null,
              shopPromotionCode: shopPromo?.code ?? null,
              shopPromotionName: shopPromo?.name ?? null,
              total: g.total.toString(),
              itemCount: g.lines.reduce((n, l) => n + l.quantity, 0),
              paymentExpiresAt: expiresAt,
              createdBy: actor.userId,
              updatedBy: actor.userId,
              items: { create: g.lines.map((l) => ({ variantId: l.variantId, productId: l.productId, shopId: l.shopId, slug: l.slug, name: l.name, imageUrl: l.imageUrl, color: l.color, size: l.size, sku: l.sku, quantity: l.quantity, unitPrice: l.unitPrice.toString(), lineTotal: l.lineTotal.toString() })) },
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
          await this.payment.initiate({ orderId: order.id, orderCode, userId: actor.userId, amount: g.total, methodCode, clientIp, bankCode }, tx);

          await this.audit.write(tx, actor, { action: ORDER_AUDIT.CREATED, entityType: 'order', entityId: order.id, entityCode: orderCode, after: { total: g.total.toString(), method: methodCode, items: g.lines.length, promotion: platformPromo?.code ?? null, shopPromotion: shopPromo?.code ?? null, discount: g.discount.toString(), shopId: g.shopId } });
          await this.notify.notifyMany(staff.map((userId) => ({ userId, type: 'order', title: `Đơn mới ${orderCode}`, content: `${address.recipientName} · ${money(g.total).display} · ${methodCode}`, link: `/orders/${orderCode}` })), tx);
          await this.outbox.publish(tx, { eventType: ORDER_EVENT.CREATED, aggregateType: 'order', aggregateId: order.id, payload: { orderCode, orderGroupCode: groupCode, shopId: g.shopId, userId: actor.userId, total: g.total.toString(), methodCode, itemCount: g.lines.reduce((n, l) => n + l.quantity, 0) } });
          purchasedVariantIds.push(...g.lines.map((l) => l.variantId));
        }

        // 7. Xoá dòng giỏ đã mua (toàn bộ, không phân biệt shop) + 1 thông báo tổng cho khách
        await this.cartWrite.removeLines(actor.userId, purchasedVariantIds, tx);
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
    );
    this.logger.log({ groupCode, userId: actor.userId }, 'Đã tạo đơn hàng');
    return this.myOrderGroup(actor, groupCode);
  }

  private async paymentExpiry(methodCode: string): Promise<Date | null> {
    // PayOS dùng cùng hạn với VNPay (link thanh toán PayOS cũng hết hạn theo mốc này) — thiếu nhánh này đơn PayOS chưa trả giữ kho + voucher vĩnh viễn.
    if (methodCode === PAYMENT_METHOD.VNPAY || methodCode === PAYMENT_METHOD.PAYOS) return new Date(Date.now() + (await this.system.settingNumber(SETTING_KEY.ORDER_VNPAY_TIMEOUT_MINUTES)) * 60_000);
    if (methodCode === PAYMENT_METHOD.BANK_TRANSFER) return new Date(Date.now() + (await this.system.settingNumber(SETTING_KEY.ORDER_BANK_TRANSFER_TIMEOUT_HOURS)) * 3_600_000);
    return null;
  }

  static fromAddressBrief(a: AddressBrief): CheckoutAddress {
    return { recipientName: a.recipientName, phone: a.phone, provinceCode: a.provinceCode, provinceName: a.provinceName, districtName: a.districtName, wardName: a.wardName, street: a.street };
  }

  async myOrders(actor: AuthenticatedActor, page: number, size: number, status?: string): Promise<PageResponse<OrderSummaryResponse>> {
    const { items, total } = await this.repo.list({ userId: actor.userId, status }, (page - 1) * size, size);
    return PageResponse.of(items.map(toOrderSummary), page, size, total);
  }

  /* Bản đầy đủ cho trang "Đơn của tôi" (FE vẽ từng món) — ≤ 20 đơn/trang nên gộp extras thanh toán tuần tự vẫn nhẹ. */
  async myOrdersFull(actor: AuthenticatedActor, page: number, size: number, status?: string): Promise<PageResponse<OrderResponse>> {
    const { items, total } = await this.repo.list({ userId: actor.userId, status }, (page - 1) * size, Math.min(size, 20));
    const full = await Promise.all(items.map((o) => this.toResponse(o)));
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
    const orders = await Promise.all(g.orders.map((o) => this.toResponse(o)));
    return toOrderGroupResponse(g, orders);
  }

  async myOrderGroups(actor: AuthenticatedActor, page: number, size: number): Promise<PageResponse<OrderGroupResponse>> {
    const { items, total } = await this.repo.listGroups(actor.userId, (page - 1) * size, Math.min(size, 20));
    const full = await Promise.all(items.map(async (g) => toOrderGroupResponse(g, await Promise.all(g.orders.map((o) => this.toResponse(o))))));
    return PageResponse.of(full, page, size, total);
  }

  private async toResponse(o: OrderRow): Promise<OrderResponse> {
    const [extras, window, shop] = await Promise.all([this.payments.extrasForOrder(o.code), this.system.settingNumber(SETTING_KEY.RETURN_WINDOW_DAYS), this.shops.findBrief(o.shopId)]);
    const res = toOrderResponse(o, extras, window, shop?.name ?? 'Gian hàng');
    // Trong hạn đổi trả nhưng đã yêu cầu trả HẾT số lượng ⇒ không còn gì để trả (tránh nút "Trả hàng" dẫn tới 400 "chỉ còn 0").
    if (res.canReturn) {
      const returned = await this.repo.returnedQtyByItem(o.id);
      res.canReturn = o.items.some((i) => i.quantity - (returned.get(i.id) ?? 0) > 0);
    }
    return { ...res, shopSlug: shop?.slug ?? '' };
  }

  async cancelByCustomer(actor: AuthenticatedActor, code: string, reason: string): Promise<OrderResponse> {
    await this.prisma.$transaction(async (tx) => {
      const o = await this.repo.findByCodeForUpdate(code, tx);
      if (!o || o.userId !== actor.userId) throw new NotFoundException(ORDER_ERR.NOT_FOUND, 'Không tìm thấy đơn hàng');
      if (o.status !== ORDER_STATUS.PENDING) throw new BusinessException(ORDER_ERR.CANNOT_CANCEL, 'Đơn đã được xác nhận, vui lòng liên hệ cửa hàng để huỷ');
      await this.doCancel(o, reason, actor, tx);
    });
    return this.myOrder(actor, code);
  }

  // ================================================================ nhân viên

  async listAdmin(f: OrderListFilter, page: number, size: number): Promise<PageResponse<OrderSummaryResponse>> {
    const { items, total } = await this.repo.list(f, (page - 1) * size, size);
    return PageResponse.of(items.map(toOrderSummary), page, size, total);
  }

  async getAdmin(code: string): Promise<OrderResponse> {
    const o = await this.repo.findByCode(code);
    if (!o) throw new NotFoundException(ORDER_ERR.NOT_FOUND, 'Không tìm thấy đơn hàng');
    return this.toResponse(o);
  }

  /*
   * Chuyển trạng thái theo lưới STAFF_TRANSITIONS. Hệ quả: confirmed → trừ kho thật (commit); delivered → COD thu tiền
   * (payment.markCodCollected → onPaid); completed → cộng sold_count. Mỗi bước: lịch sử + audit + thông báo khách + outbox.
   */
  async updateStatus(actor: AuthenticatedActor, code: string, next: string, opts: { trackingUrl?: string; note?: string }): Promise<OrderResponse> {
    await this.prisma.$transaction(async (tx) => {
      const o = await this.repo.findByCodeForUpdate(code, tx);
      if (!o) throw new NotFoundException(ORDER_ERR.NOT_FOUND, 'Không tìm thấy đơn hàng');
      if (!(STAFF_TRANSITIONS[o.status] ?? []).includes(next)) throw new BusinessException(ORDER_ERR.INVALID_TRANSITION, `Không thể chuyển từ "${STATUS_LABEL[o.status]}" sang "${STATUS_LABEL[next]}"`);
      if (next === ORDER_STATUS.CONFIRMED && o.paymentMethodCode !== PAYMENT_METHOD.COD && o.paymentStatus !== PAYMENT_STATUS.PAID) {
        throw new BusinessException(ORDER_ERR.INVALID_TRANSITION, 'Đơn thanh toán online chưa nhận được tiền — chưa xác nhận được');
      }
      const lines = o.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity }));
      const now = new Date();
      const stamps: Prisma.OrderUncheckedUpdateInput = { status: next, updatedBy: actor.userId, ...(opts.trackingUrl ? { trackingUrl: opts.trackingUrl } : {}) };
      if (next === ORDER_STATUS.CONFIRMED) {
        stamps.confirmedAt = now;
        await this.inventory.commit(lines, { type: 'order', id: code }, tx);
      }
      if (next === ORDER_STATUS.PACKING) stamps.packedAt = now;
      if (next === ORDER_STATUS.SHIPPING) stamps.shippedAt = now;
      if (next === ORDER_STATUS.DELIVERED) {
        stamps.deliveredAt = now;
        if (o.paymentMethodCode === PAYMENT_METHOD.COD && o.paymentStatus !== PAYMENT_STATUS.PAID) await this.payment.markCodCollected(code, actor.userId, tx);
      }
      if (next === ORDER_STATUS.COMPLETED) {
        stamps.completedAt = now;
        await this.productStats.addSold(o.items.map((i) => ({ productId: i.productId, quantity: i.quantity })), tx);
      }
      await this.repo.update(o.id, stamps, tx);
      await this.repo.addHistory(o.id, o.status, next, opts.note ?? null, actor.userId, tx);
      await this.audit.write(tx, actor, { action: ORDER_AUDIT.STATUS_CHANGED, entityType: 'order', entityId: o.id, entityCode: code, before: { status: o.status }, after: { status: next, note: opts.note ?? null } });
      await this.notify.notify({ userId: o.userId, type: 'order', title: `Đơn ${code}: ${STATUS_LABEL[next]}`, content: opts.note ?? null, link: `/account/orders/${code}` }, tx);
      await this.outbox.publish(tx, { eventType: next === ORDER_STATUS.DELIVERED ? ORDER_EVENT.DELIVERED : ORDER_EVENT.STATUS_CHANGED, aggregateType: 'order', aggregateId: o.id, payload: { orderCode: code, userId: o.userId, from: o.status, to: next } });
    });
    return this.getAdmin(code);
  }

  async cancelByStaff(actor: AuthenticatedActor, code: string, reason: string): Promise<OrderResponse> {
    await this.prisma.$transaction(async (tx) => {
      const o = await this.repo.findByCodeForUpdate(code, tx);
      if (!o) throw new NotFoundException(ORDER_ERR.NOT_FOUND, 'Không tìm thấy đơn hàng');
      if (!(STAFF_TRANSITIONS[o.status] ?? []).includes(ORDER_STATUS.CANCELLED)) throw new BusinessException(ORDER_ERR.CANNOT_CANCEL, `Không huỷ được đơn đang "${STATUS_LABEL[o.status]}"`);
      await this.doCancel(o, reason, actor, tx);
    });
    return this.getAdmin(code);
  }

  /* Huỷ: nhả/hoàn kho tuỳ đã commit chưa, nhả lượt KM, huỷ/hoàn thanh toán, lịch sử + audit + thông báo + outbox. */
  private async doCancel(o: OrderRow, reason: string, actor: AuthenticatedActor | null, tx: Tx): Promise<void> {
    const lines = o.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity }));
    if (o.status === ORDER_STATUS.PENDING) await this.inventory.release(lines, { type: 'order', id: o.code }, tx);
    else await this.inventory.restock(lines, { type: 'order', id: o.code }, tx);
    await this.promotion.release(o.code, tx); // voucher shop (lượt dùng gắn mã đơn con)
    // Voucher sàn gắn mã đơn CHA: chỉ nhả khi KHÔNG còn đơn con nào khác còn hiệu lực trong nhóm.
    const sibling = await this.repo.groupSiblingInfo(o.orderGroupId, o.id, tx);
    if (sibling && sibling.activeOthers === 0) await this.promotion.release(sibling.groupCode, tx);
    if (o.paymentStatus === PAYMENT_STATUS.PAID) {
      await this.payment.requestRefund({ orderCode: o.code, shopId: o.shopId, amount: BigInt(o.total.toString()), reason: `Huỷ đơn: ${reason}`, returnRequestId: null, actorUserId: actor?.userId ?? null }, tx);
    } else {
      await this.payment.cancel(o.code, reason, tx);
    }
    await this.repo.update(o.id, { status: ORDER_STATUS.CANCELLED, cancelReason: reason, cancelledAt: new Date(), cancelledBy: actor?.userId ?? null, updatedBy: actor?.userId ?? null }, tx);
    await this.repo.addHistory(o.id, o.status, ORDER_STATUS.CANCELLED, reason, actor?.userId ?? null, tx);
    await this.audit.write(tx, actor, { action: ORDER_AUDIT.CANCELLED, entityType: 'order', entityId: o.id, entityCode: o.code, before: { status: o.status }, after: { reason, refund: o.paymentStatus === PAYMENT_STATUS.PAID } });
    await this.notify.notify({ userId: o.userId, type: 'order', title: `Đơn ${o.code} đã huỷ`, content: reason, link: `/account/orders/${o.code}` }, tx);
    await this.outbox.publish(tx, { eventType: ORDER_EVENT.CANCELLED, aggregateType: 'order', aggregateId: o.id, payload: { orderCode: o.code, userId: o.userId, reason } });
  }

  // ================================================================ cổng ngược từ payment

  async onPaid(orderCode: string, info: { paymentId: string; methodCode: string; transactionCode: string | null; bankCode: string | null; paidAt: Date }, tx: Tx): Promise<void> {
    const o = await this.repo.findByCodeForUpdate(orderCode, tx);
    if (!o) throw new NotFoundException(ORDER_ERR.NOT_FOUND, `Không tìm thấy đơn ${orderCode}`);
    if (o.paymentStatus === PAYMENT_STATUS.PAID) return; // IPN lặp — đã xử lý
    // Tiền về sau khi đơn đã huỷ/trả (khách quét QR rồi huỷ, webhook đến muộn): ghi nhận đã thu rồi TẠO NGAY yêu cầu hoàn đủ — không để tiền nằm ở sàn không ai biết.
    if (o.status === ORDER_STATUS.CANCELLED || o.status === ORDER_STATUS.RETURNED) {
      await this.repo.update(o.id, { paymentStatus: PAYMENT_STATUS.PAID, paymentExpiresAt: null, updatedBy: null }, tx);
      await this.payment.requestRefund({ orderCode, shopId: o.shopId, amount: BigInt(o.total.toString()), reason: 'Thanh toán đến sau khi đơn đã huỷ', returnRequestId: null, actorUserId: null, paymentId: info.paymentId }, tx);
      await this.audit.write(tx, null, { action: ORDER_AUDIT.PAID, entityType: 'order', entityId: o.id, entityCode: orderCode, after: { method: info.methodCode, lateAfter: o.status, refundRequested: true } });
      await this.notify.notify({ userId: o.userId, type: 'payment', title: `Đơn ${orderCode} đã huỷ — khoản thanh toán sẽ được hoàn`, content: 'Hệ thống nhận được thanh toán sau khi đơn bị huỷ. Chúng tôi sẽ hoàn lại toàn bộ số tiền.', link: `/account/orders/${orderCode}` }, tx);
      return;
    }
    await this.repo.update(o.id, { paymentStatus: PAYMENT_STATUS.PAID, paymentExpiresAt: null, updatedBy: null }, tx);
    await this.audit.write(tx, null, { action: ORDER_AUDIT.PAID, entityType: 'order', entityId: o.id, entityCode: orderCode, after: { method: info.methodCode, transactionCode: info.transactionCode } });
    if (o.paymentMethodCode !== PAYMENT_METHOD.COD) {
      await this.notify.notify({ userId: o.userId, type: 'payment', title: `Đã nhận thanh toán đơn ${orderCode}`, content: `Cảm ơn bạn. Đơn sẽ được xác nhận và đóng gói sớm.`, link: `/account/orders/${orderCode}` }, tx);
      const staff = await this.users.staffUserIdsWithPermission('order.order.status.update');
      await this.notify.notifyMany(staff.map((userId) => ({ userId, type: 'payment', title: `Đơn ${orderCode} đã thanh toán`, content: `${info.methodCode} · ${money(o.total.toString()).display}`, link: `/orders/${orderCode}` })), tx);
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
    const rows = await this.repo.findPaymentExpired(limit);
    let n = 0;
    for (const { code } of rows) {
      try {
        await this.prisma.$transaction(async (tx) => {
          const o = await this.repo.findByCodeForUpdate(code, tx);
          if (!o || o.status !== ORDER_STATUS.PENDING || o.paymentStatus === PAYMENT_STATUS.PAID) return;
          await this.doCancel(o, 'Quá hạn thanh toán', null, tx);
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
            await this.repo.update(o.id, { status: ORDER_STATUS.COMPLETED, completedAt: new Date() }, tx);
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
