import { Inject, Injectable, Optional } from '@nestjs/common';
import { BusinessException, NotFoundException } from '@common/exception/business.exception';
import { PAYMENT_GATEWAY, PaymentGateway } from '@common/gateway/payment.gateway';
import { PrismaService } from '@common/prisma/prisma.service';
import { PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { ShopQueryApi } from '@modules/shop/queryapi/shop.queryapi';
import { SETTING_KEY } from '@modules/system/enums/setting-keys';
import { SystemQueryApi } from '@modules/system/queryapi/system.queryapi';
import { ORDER_ERR, ORDER_STATUS, STATUS_LABEL, type DeliveryFailedReason } from '../../foundation/order.constants';
import { OrderResponse, OrderSummaryResponse } from '../dto/order.responses';
import { toOrderResponse, toOrderSummary } from '../mapper/order.mapper';
import { OrderListFilter, OrderRepository, OrderRow } from '../repository/order.repository';
import { OrderService } from './order.service';
import { ShippingQueryApi } from '@modules/shipping/queryapi/shipping.queryapi';

/* Lưới chuyển trạng thái vendor được phép (hẹp hơn STAFF_TRANSITIONS: không huỷ qua PUT status, không completed/returned). */
const VENDOR_TRANSITIONS: Record<string, string[]> = {
  [ORDER_STATUS.PENDING]: [ORDER_STATUS.CONFIRMED],
  [ORDER_STATUS.CONFIRMED]: [ORDER_STATUS.PACKING],
  [ORDER_STATUS.PACKING]: [ORDER_STATUS.SHIPPING],
  [ORDER_STATUS.SHIPPING]: [ORDER_STATUS.DELIVERED],
};

/*
 * Vendor huỷ được khi đơn CHƯA đóng gói. PHẢI khớp STAFF_TRANSITIONS (order.constants.ts): chỉ pending/confirmed có
 * `cancelled`; packing KHÔNG có (hàng đã đóng — muốn dừng thì liên hệ sàn) nên OrderService.cancelByStaff sẽ ném
 * ORDER_CANNOT_CANCEL. Chặn sớm ở đây để thông báo lỗi rõ ràng và không phụ thuộc vào lưới của OrderService.
 */
const VENDOR_CANCELABLE: readonly string[] = [ORDER_STATUS.PENDING, ORDER_STATUS.CONFIRMED, ORDER_STATUS.PACKING];

/*
 * Vendor quản lý đơn hàng của gian hàng mình (PLAN-0014 bước 5). shopId luôn từ ShopContextGuard, không bao giờ từ
 * body/param để vendor không thể thao tác đơn của shop khác. Chỉ cho phép chuyển
 * pending→confirmed→packing→shipping→delivered (không delivered→completed, đó là quyền admin).
 *
 * Mọi route (GET / PUT status / POST cancel) trả CÙNG một dạng OrderResponse dựng từ toOrderResponse với extras = null:
 * vendor KHÔNG được thấy paymentUrl/transactionCode/cardBrand/cardLast4 (thông tin thanh toán của khách).
 * OrderService.updateStatus/cancelByStaff kết thúc bằng getAdmin() (có extras thanh toán) nên kết quả của chúng bị BỎ,
 * service này đọc lại đơn qua `get()` sau khi ghi.
 * Transaction/audit/outbox/khoá dòng đều nằm ở OrderService — service này chỉ kiểm quyền sở hữu + lưới vendor + định dạng
 * response, không ghi gì trực tiếp.
 */
@Injectable()
export class ShopOrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: OrderRepository,
    private readonly orders: OrderService,
    private readonly shops: ShopQueryApi,
    private readonly system: SystemQueryApi,
    @Inject(PAYMENT_GATEWAY) private readonly payment: PaymentGateway,
    @Optional() private readonly shipping?: ShippingQueryApi,
  ) {}

  /* Danh sách đơn của gian hàng theo trạng thái, tìm kiếm mã/tên/SĐT. */
  async list(shopId: string, filter: OrderListFilter, page: number, size: number): Promise<PageResponse<OrderSummaryResponse>> {
    const skip = (page - 1) * size;
    const { items, total } = await this.repo.list({ ...filter, shopId }, skip, size);
    const refunds = await this.payment.refundSummaries(items.map((o) => o.code)); // MỘT lần cho cả trang ("đang hoàn tiền" thay vì "đã thanh toán")
    return PageResponse.of(
      items.map((o) => toOrderSummary(o, refunds.get(o.code))),
      page,
      size,
      total,
    );
  }

  /* Thống kê đơn theo trạng thái — MỘT câu groupBy (thay cho 8 lệnh count), trạng thái không có đơn trả 0. */
  async summary(shopId: string): Promise<Record<string, number>> {
    const rows = await this.prisma.order.groupBy({ by: ['status'], where: { shopId, isDeleted: false }, _count: { _all: true } });
    const byStatus = new Map(rows.map((r) => [r.status, r._count._all]));
    return Object.fromEntries(Object.values(ORDER_STATUS).map((status) => [status, byStatus.get(status) ?? 0]));
  }

  /* Lấy chi tiết đơn của gian hàng mình (404 nếu không phải đơn của shop này). */
  async get(shopId: string, code: string): Promise<OrderResponse> {
    const o = await this.findOwned(shopId, code);
    return this.toShopOrderResponse(o, shopId);
  }

  /*
   * Cập nhật trạng thái đơn — chỉ cho phép pending→confirmed, confirmed→packing, packing→shipping,
   * shipping→delivered (vendor không được chuyển sang completed hay các trạng thái khác).
   */
  async updateStatus(
    actor: AuthenticatedActor,
    shopId: string,
    code: string,
    nextStatus: string,
    opts: { trackingUrl?: string; carrier?: string; trackingCode?: string; note?: string },
  ): Promise<OrderResponse> {
    const orderCode = code.toUpperCase();
    const o = await this.findOwned(shopId, orderCode);

    if (!(VENDOR_TRANSITIONS[o.status] ?? []).includes(nextStatus)) {
      throw new BusinessException(
        ORDER_ERR.INVALID_TRANSITION,
        `Vendor chỉ được chuyển từ "${STATUS_LABEL[o.status]}" sang các trạng thái cho phép`,
      );
    }

    // OrderService lo transaction + khoá + kho + audit + outbox; kết quả của nó có thông tin thanh toán nên không trả ra.
    await this.orders.updateStatus(actor, orderCode, nextStatus, opts);
    return this.get(shopId, orderCode);
  }

  /*
   * Huỷ đơn hàng — PLAN-0027: pending/confirmed/packing (CAN-06/07). Khoá dòng, kiểm trạng thái, kiểm shop sở hữu (đơn shop khác ⇒ 404) đều ở OrderService.cancelByShop — KHÔNG đọc-rồi-quyết ở đây
   * (đọc ngoài khoá sẽ cho kết quả cũ khi shop/khách/job huỷ đồng thời). Điểm vi phạm ghi qua sự kiện ORDER_CANCELLED.
   */
  async cancel(actor: AuthenticatedActor, shopId: string, code: string, input: { reason?: string; reasonCode?: string; note?: string }): Promise<OrderResponse> {
    const orderCode = code.toUpperCase();
    await this.orders.cancelByShop(actor, shopId, orderCode, input);
    return this.get(shopId, orderCode);
  }

  /*
   * Báo giao không thành công (PLAN-0022): đơn `shipping` → cancelled, nhập kho lại nếu `goodsReturned`, hoàn tiền nếu đã thu online. Transaction/khoá/audit/thông báo ở
   * OrderService.deliveryFailed (kiểm đơn thuộc đúng `shopId` ở đó — đơn shop khác ⇒ 404); trả OrderResponse của vendor (không lộ thông tin thanh toán).
   */
  async deliveryFailed(actor: AuthenticatedActor, shopId: string, code: string, input: { reasonCode: DeliveryFailedReason; note: string; goodsReturned: boolean }): Promise<OrderResponse> {
    const orderCode = code.toUpperCase();
    if (this.shipping && (await this.findOwned(shopId,orderCode)).fulfilmentMode === 'carrier') throw new BusinessException('SHIPMENT_MANAGED_BY_CARRIER','Hãng vận chuyển quản lý đơn này',409);
    await this.orders.deliveryFailed(actor, shopId, orderCode, input);
    return this.get(shopId, orderCode);
  }

  /*
   * "Hàng đã về kho" (PLAN-0031 §2.4, SHP-09): đơn đã huỷ vì giao thất bại mà lúc báo `goodsReturned=false` — shop xác nhận hàng về, nhập kho đúng một lần. Kiểm đơn thuộc `shopId` + điều kiện + khoá ở
   * OrderService.goodsReturned; trả OrderResponse của vendor.
   */
  async goodsReturned(actor: AuthenticatedActor, shopId: string, code: string): Promise<OrderResponse> {
    const orderCode = code.toUpperCase();
    if ((await this.findOwned(shopId,orderCode)).fulfilmentMode === 'carrier') throw new BusinessException('SHIPMENT_MANAGED_BY_CARRIER','Hãng vận chuyển quản lý đơn này',409);
    await this.orders.goodsReturned(actor, shopId, orderCode);
    return this.get(shopId, orderCode);
  }

  /* Đơn của đúng gian hàng này; mã không tồn tại và đơn của shop khác đều 404 (không lộ sự tồn tại). */
  private async findOwned(shopId: string, code: string): Promise<OrderRow> {
    const o = await this.repo.findByCode(code.toUpperCase());
    if (!o || o.shopId !== shopId) throw new NotFoundException(ORDER_ERR.NOT_FOUND, 'Không tìm thấy đơn hàng');
    return o;
  }

  /*
   * OrderRow → OrderResponse cho vendor: extras = null (không lộ thông tin thanh toán), cửa sổ đổi trả đọc từ tham số
   * vận hành `return.window_days` (cùng nguồn với phía khách), `canCancel` theo quyền huỷ của VENDOR (tới confirmed)
   * chứ không phải của khách (chỉ pending).
   */
  private async toShopOrderResponse(o: OrderRow, shopId: string): Promise<OrderResponse> {
    const [shop, windowDays, refunds, shipment] = await Promise.all([this.shops.findBrief(shopId), this.system.settingNumber(SETTING_KEY.RETURN_WINDOW_DAYS), this.payment.refundSummaries([o.code]), o.fulfilmentMode === 'carrier' && this.shipping ? this.shipping.latest(o.code) : Promise.resolve(null)]);
    let canCancel = VENDOR_CANCELABLE.includes(o.status);
    if (o.fulfilmentMode === 'carrier' && shipment) {
      if (shipment.createStatus !== 'created' || ['requested', 'unknown'].includes(shipment.cancelStatus) || shipment.pickedUpAt || ['picked', 'in_transit', 'delivering', 'delivery_failed', 'returning', 'returned', 'delivered', 'lost'].includes(shipment.status ?? '')) canCancel = false;
      else if (o.status === ORDER_STATUS.SHIPPING) canCancel = shipment.active && shipment.status === 'awaiting_pickup' && shipment.cancelStatus === 'none';
    }
    // `canReportNotReceived` là cờ của KHÁCH — vô nghĩa với vendor.
    return { ...toOrderResponse(o, null, windowDays, shop?.name ?? 'Gian hàng', { refund: refunds.get(o.code) ?? null }), ...(o.fulfilmentMode === 'carrier' ? {shipment}:{}), canCancel, canReportNotReceived: false, canRequestCancel: false, canChangeAddress: false, canMarkReceived: false }; // PLAN-0027: ba cờ này là của KHÁCH
  }
}
