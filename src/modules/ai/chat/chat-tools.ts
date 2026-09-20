import { formatVnd } from '@common/utils/money';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import type { CartQueryApi } from '../../cart/queryapi/cart.queryapi';
import type { OrderQueryApi } from '../../order/queryapi/order.queryapi';
import type { PaymentQueryApi } from '../../payment/queryapi/payment.queryapi';
import type { ProductCardResponse, ProductQueryApi } from '../../product/queryapi/product.queryapi';
import type { PromotionQueryApi } from '../../promotion/queryapi/promotion.queryapi';
import type { ReviewQueryApi } from '../../review/queryapi/review.queryapi';
import { SETTING_KEY } from '../../system/enums/setting-keys';
import type { SystemQueryApi } from '../../system/queryapi/system.queryapi';
import type { EmbeddingService } from '../embedding/embedding.service';
import type { AgentToolCall, ChatToolSpec } from '../provider/openai.provider';
import type { ReviewAiService } from '../review-ai/review-ai.service';
import { argStr } from '../foundation/arg';
import { ACTION_KIND, ChatAction, ChatActionService } from './chat-action.service';

export const MAX_CARDS_PER_TOOL = 4;

const MAX_PRODUCTS = 6;

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ChatToolSpec {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } };
}

/* Bộ tool của trợ lý — mô tả bằng tiếng Việt để model chọn đúng; catalog/kho tri thức chỉ tiếng Việt. */
export const CHAT_TOOLS: ChatToolSpec[] = [
  tool('search_products', 'Tìm sản phẩm đang bán theo nhu cầu của khách (theo NGHĨA + từ khoá). Dùng khi khách hỏi mua gì, tìm gì, có bán X không, gợi ý món cho dịp Y. Kết quả hiện thành THẺ dưới câu trả lời — chỉ nêu tên + giá + 1 ý vì sao hợp.', { query: { type: 'string', description: 'Nhu cầu/mô tả sản phẩm, đủ ý, tiếng Việt' }, max_price_vnd: { type: 'number', description: 'Ngân sách tối đa (VND) nếu khách nói' }, gender: { type: 'string', enum: ['nam', 'nu'], description: 'Giới nếu khách nói' }, limit: { type: 'integer', minimum: 1, maximum: MAX_PRODUCTS } }, ['query']),
  tool('get_product_details', 'Chi tiết một sản phẩm theo `slug` (từ search_products): mô tả, chất liệu, cách giặt, màu/size còn hàng, giá.', { slug: { type: 'string' } }, ['slug']),
  tool('get_product_reviews', 'Đánh giá của khách đã mua về MỘT sản phẩm (slug): tóm tắt ưu/nhược + vài đánh giá gần nhất. Dùng khi khách hỏi "có tốt không", "người mua nói sao".', { slug: { type: 'string' } }, ['slug']),
  tool('search_knowledge', 'Tra kho tri thức cửa hàng: đổi trả, bảo hành, giao hàng, thanh toán, COD, chọn size, bảo quản, giới thiệu shop. Dùng cho MỌI câu hỏi về quy định/cách làm.', { query: { type: 'string', description: 'Câu hỏi tiếng Việt' } }, ['query']),
  tool('get_my_orders', 'Đơn hàng gần đây CỦA CHÍNH khách đang đăng nhập (trạng thái, thanh toán, món hàng). Truyền `order_code` nếu khách nêu mã đơn.', { order_code: { type: 'string', description: 'Mã đơn, ví dụ DH2609150001' } }),
  tool('list_active_promotions', 'Mã giảm giá đang chạy (mã, mức giảm, điều kiện, hạn). Dùng khi khách hỏi khuyến mãi/voucher/mã giảm giá.', {}),
  tool('find_best_promotion', 'Mã giảm giá TỐT NHẤT áp được cho giỏ đang tick của khách đang đăng nhập (tính đúng phép tính bước thanh toán). Dùng khi khách hỏi "có mã nào cho giỏ của tôi", "áp mã tốt nhất".', {}),
  tool('get_shipping_info', 'Phí vận chuyển tới một tỉnh/thành (tên tiếng Việt) và ngưỡng miễn phí ship, thời gian giao.', { province: { type: 'string', description: 'Tên tỉnh/thành, ví dụ Hà Nội; bỏ trống = phí mặc định' } }),
  tool('list_payment_methods', 'Các cách thanh toán cửa hàng đang hỗ trợ (COD, chuyển khoản, VNPay).', {}),
  tool('get_recommendations', 'Gợi ý cá nhân hoá từ lịch sử xem/mua của khách. Dùng khi khách hỏi "gợi ý cho tôi", "nên mua gì", "có gì hợp với tôi".', {}),
  tool('request_human_support', 'Ghi nhận yêu cầu GẶP NHÂN VIÊN khi khách muốn nói chuyện với người thật, khiếu nại, hoặc bạn không có dữ liệu để trả lời. Khách chưa đăng nhập PHẢI hỏi email/số điện thoại trước rồi truyền `contact`.', { question: { type: 'string', description: 'Vấn đề của khách, 1-2 câu' }, contact: { type: 'string', description: 'Email/số điện thoại (bắt buộc với khách chưa đăng nhập)' }, summary: { type: 'string', description: 'Tóm tắt hội thoại cho nhân viên' } }, ['question']),
  tool('add_to_cart', 'ĐỀ XUẤT thêm sản phẩm vào giỏ của khách đang đăng nhập. Tool KHÔNG ghi ngay: tạo đề xuất, khách bấm "Xác nhận" trên thẻ trong chat mới thêm. Sản phẩm có nhiều màu/size mà khách chưa nói rõ → tool trả danh sách để hỏi khách chọn rồi gọi lại với `variant_id`.', { slug: { type: 'string' }, variant_id: { type: 'string', description: 'Id biến thể đã chọn' }, variant_hint: { type: 'string', description: 'Khách nói phân loại thế nào, ví dụ "đen size L"' }, quantity: { type: 'integer', minimum: 1, maximum: 10 } }, ['slug']),
  tool('cancel_order', 'ĐỀ XUẤT huỷ MỘT đơn của chính khách đang đăng nhập (chỉ khi đơn còn Chờ xác nhận). Không huỷ ngay — khách phải bấm "Xác nhận". Gọi sau khi đã tra get_my_orders.', { order_code: { type: 'string' }, reason: { type: 'string' } }, ['order_code']),
];

export interface ToolBoxDeps {
  products: ProductQueryApi;
  embeddings: EmbeddingService;
  reviews: ReviewQueryApi;
  reviewAi: ReviewAiService;
  orders: OrderQueryApi;
  promotions: PromotionQueryApi;
  cart: CartQueryApi;
  system: SystemQueryApi;
  payments: PaymentQueryApi;
  actions: ChatActionService;
  recommend: (userId: string | null, guestKey: string | null) => Promise<ProductCardResponse[]>;
  createSupport: (summary: string, contact: string | null) => Promise<{ id: string }>;
}

export interface ToolBoxContext {
  sessionId: string;
  actor?: AuthenticatedActor;
  guestKey: string | null;
}

const ORDER_STATUS_LABEL: Record<string, string> = { pending: 'chờ xác nhận', confirmed: 'đã xác nhận', packing: 'đang đóng gói', shipping: 'đang giao', delivered: 'đã giao', completed: 'hoàn tất', cancelled: 'đã huỷ' };
const PAY_LABEL: Record<string, string> = { unpaid: 'chưa thanh toán', processing: 'đang thanh toán', paid: 'đã thanh toán', partially_refunded: 'đã thanh toán (hoàn một phần)', refunded: 'đã hoàn tiền' };
const FILLER = new Set(['màu', 'mau', 'size', 'cỡ', 'co', 'loại', 'loai', 'kiểu', 'kieu', 'cái', 'cai', 'chiếc', 'chiec', 'bản', 'ban', 'nhé', 'nhe', 'đi', 'di']);

/*
 * Hộp tool theo LƯỢT chat: giữ card đã trích (`cited`), tool trả rỗng (`misses`), đề xuất hành động (`actions`), mã hỗ trợ.
 * Mỗi tool trả JSON gọn cho model; card gửi FE là ProductCardResponse thật (không do model dựng).
 */
export class ToolBox {
  readonly cited: ProductCardResponse[] = [];
  readonly misses: string[] = [];
  readonly actions: ChatAction[] = [];
  supportRequestId: string | null = null;

  constructor(
    private readonly d: ToolBoxDeps,
    private readonly ctx: ToolBoxContext,
  ) {}

  async execute(call: AgentToolCall): Promise<string> {
    const out = await this.dispatch(call.name, call.args);
    return JSON.stringify(out, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
  }

  private cite(cards: ProductCardResponse[]): void {
    for (const c of cards) if (!this.cited.some((x) => x.id === c.id)) this.cited.push(c);
  }

  private static card(c: ProductCardResponse) {
    return { slug: c.slug, name: c.name, price: c.price.display, listPrice: c.listPrice?.display ?? null, category: c.categorySlug, gender: c.gender, colors: c.colors.map((x) => x.name), sizes: c.sizes, rating: c.avgRating, reviews: c.reviewCount, inStock: c.inStock };
  }

  private async dispatch(name: string, a: Record<string, unknown>): Promise<unknown> {
    const userId = this.ctx.actor?.userId ?? null;
    switch (name) {
      case 'search_products': {
        const q = argStr(a.query).trim();
        const limit = Math.min(MAX_PRODUCTS, Math.max(1, Number(a.limit ?? MAX_PRODUCTS)));
        const maxPrice = a.max_price_vnd ? BigInt(Math.round(Number(a.max_price_vnd))) : undefined;
        const gender = a.gender === 'nam' || a.gender === 'nu' ? argStr(a.gender) : null;
        const ids = await this.d.embeddings.searchProducts(q, limit * 2, userId).catch(() => [] as string[]);
        let cards = ids.length ? await this.d.products.cardsByIds(ids) : [];
        if (cards.length < 2) cards = [...cards, ...(await this.d.products.searchCards(q, limit)).filter((c) => !cards.some((x) => x.id === c.id))];
        if (gender) cards = cards.filter((c) => c.gender === gender || c.gender === 'unisex');
        if (maxPrice !== undefined) cards = cards.filter((c) => BigInt(c.price.amount) <= maxPrice);
        cards = cards.slice(0, limit);
        if (cards.length === 0) {
          this.misses.push(`search_products:${q}`);
          return { found: 0, hint: 'Không có sản phẩm khớp — nói thẳng với khách và gợi ý mô tả khác (loại, màu, ngân sách).' };
        }
        this.cite(cards);
        return { found: cards.length, items: cards.map((c) => ToolBox.card(c)) };
      }
      case 'get_product_details': {
        const p = await this.d.products.detailForAi(argStr(a.slug));
        if (!p) return { error: 'Không tìm thấy sản phẩm (slug sai hoặc đã ngừng bán)' };
        const cards = await this.d.products.cardsByIds([p.id]);
        this.cite(cards);
        return { slug: p.slug, name: p.name, price: formatVnd(BigInt(p.price)), listPrice: p.listPrice ? formatVnd(BigInt(p.listPrice)) : null, category: p.categorySlug, gender: p.gender, shortDescription: p.shortDescription, description: p.description?.slice(0, 1500), material: p.material, care: p.care, rating: p.avgRating, reviews: p.reviewCount, sold: p.soldCount, variants: p.variants.map((v) => ({ id: v.id, color: v.colorName, size: v.sizeCode, price: formatVnd(BigInt(v.price)), inStock: v.inStock })) };
      }
      case 'get_product_reviews': {
        const p = await this.d.products.detailForAi(argStr(a.slug));
        if (!p) return { error: 'Không tìm thấy sản phẩm' };
        const [summary, recent] = await Promise.all([this.d.reviewAi.summary(p.id), this.d.reviews.approvedForProduct(p.id, 5)]);
        if (!summary && recent.length === 0) return { name: p.name, reviews: 0, hint: 'Chưa có đánh giá — nói rõ với khách.' };
        return { name: p.name, rating: p.avgRating, reviews: p.reviewCount, summary: summary ? { text: summary.summary, pros: summary.pros, cons: summary.cons } : null, recent: recent.map((r) => ({ rating: r.rating, content: r.content.slice(0, 300) })) };
      }
      case 'search_knowledge': {
        const hits = await this.d.embeddings.searchChunks(argStr(a.query), 4, userId).catch(() => []);
        if (hits.length === 0) {
          this.misses.push(`search_knowledge:${argStr(a.query)}`);
          return { found: 0, hint: 'Kho tri thức không có — nói khách liên hệ hotline/nhân viên, không tự đoán.' };
        }
        return { found: hits.length, passages: hits.map((h) => ({ title: h.title, content: h.content.slice(0, 900) })) };
      }
      case 'get_my_orders': {
        if (!this.ctx.actor) return { error: 'Khách chưa đăng nhập — mời khách đăng nhập để tra đơn.' };
        const code = a.order_code ? argStr(a.order_code).trim().toUpperCase() : null;
        if (code) {
          const o = await this.d.orders.findByCodeForUser(this.ctx.actor.userId, code);
          if (!o) return { error: `Không có đơn ${code} trong tài khoản này` };
          return { code: o.code, status: ORDER_STATUS_LABEL[o.status] ?? o.status, statusCode: o.status, payment: PAY_LABEL[o.paymentStatus] ?? o.paymentStatus, total: formatVnd(BigInt(o.total)), address: o.shippingAddress, createdAt: o.createdAt, items: o.items.map((i) => `${i.name} (${i.color}/${i.size}) ×${i.quantity}`) };
        }
        const list = await this.d.orders.recentOrders(this.ctx.actor.userId, 5);
        if (list.length === 0) return { orders: [], hint: 'Khách chưa có đơn nào.' };
        return { orders: list.map((o) => ({ code: o.code, status: ORDER_STATUS_LABEL[o.status] ?? o.status, statusCode: o.status, payment: PAY_LABEL[o.paymentStatus] ?? o.paymentStatus, total: formatVnd(BigInt(o.total)), createdAt: o.createdAt, items: o.items.map((i) => `${i.name} (${i.color}/${i.size}) ×${i.quantity}`) })) };
      }
      case 'list_active_promotions': {
        const basket = this.ctx.actor ? await this.d.cart.basketOf(this.ctx.actor.userId) : null;
        const offers = await this.d.promotions.offersFor({ userId: userId ?? '', subtotal: basket?.subtotal ?? 0n, shippingFee: 0n, lines: basket?.lines.map((l) => ({ productId: l.productId, categorySlug: l.categorySlug, lineTotal: l.lineTotal })) ?? [] });
        if (offers.length === 0) return { promotions: [], hint: 'Hiện không có mã công khai nào.' };
        return { promotions: offers.map((o) => ({ code: o.code, name: o.name, description: o.description, minOrder: o.displayMinOrderAmount?.display ?? null, maxDiscount: o.displayMaxDiscount?.display ?? null, endAt: o.endAt, eligibleForCurrentCart: o.eligible, reason: o.reason })) };
      }
      case 'find_best_promotion': {
        if (!this.ctx.actor) return { error: 'Khách chưa đăng nhập' };
        const basket = await this.d.cart.basketOf(this.ctx.actor.userId);
        if (basket.lines.length === 0) return { error: 'Giỏ đang trống (chưa tick dòng nào)' };
        const offers = await this.d.promotions.offersFor({ userId: this.ctx.actor.userId, subtotal: basket.subtotal, shippingFee: 0n, lines: basket.lines.map((l) => ({ productId: l.productId, categorySlug: l.categorySlug, lineTotal: l.lineTotal })) });
        const ok = offers.filter((o) => o.eligible).sort((x, y) => Number(y.displayDiscount.amount) - Number(x.displayDiscount.amount));
        if (ok.length === 0) return { best: null, cartSubtotal: formatVnd(basket.subtotal), hint: 'Không mã nào áp được cho giỏ hiện tại', nearMiss: offers.filter((o) => o.displayMissingAmount).map((o) => ({ code: o.code, missing: o.displayMissingAmount?.display })) };
        return { best: { code: ok[0].code, name: ok[0].name, discount: ok[0].displayDiscount.display }, cartSubtotal: formatVnd(basket.subtotal), others: ok.slice(1, 3).map((o) => ({ code: o.code, discount: o.displayDiscount.display })) };
      }
      case 'get_shipping_info': {
        const [fee, threshold] = await Promise.all([this.d.system.shippingFeeFor(0n, a.province ? argStr(a.province) : null), this.d.system.settingNumber(SETTING_KEY.SHIPPING_FREE_THRESHOLD)]);
        return { province: fee.province?.name ?? (a.province ? `không khớp "${argStr(a.province)}" — dùng phí mặc định` : 'mặc định'), fee: formatVnd(fee.fee), freeShippingFrom: formatVnd(BigInt(threshold)), eta: 'TP.HCM 1–2 ngày, tỉnh khác 2–5 ngày làm việc' };
      }
      case 'list_payment_methods':
        return { methods: await this.d.payments.activeMethods() };
      case 'get_recommendations': {
        const cards = (await this.d.recommend(userId, this.ctx.guestKey)).slice(0, MAX_PRODUCTS);
        this.cite(cards);
        return { items: cards.map((c) => ToolBox.card(c)) };
      }
      case 'request_human_support': {
        if (!this.ctx.actor && !a.contact) return { error: 'Khách chưa đăng nhập — hỏi xin email hoặc số điện thoại rồi gọi lại với `contact`.' };
        const summary = [argStr(a.question), a.summary ? argStr(a.summary) : ''].filter(Boolean).join(' | ').slice(0, 1000);
        const r = await this.d.createSupport(summary, a.contact ? argStr(a.contact).slice(0, 255) : null);
        this.supportRequestId = r.id;
        return { request_id: r.id.slice(0, 8).toUpperCase(), hint: 'Báo khách mã yêu cầu; nhân viên sẽ liên hệ lại.' };
      }
      case 'add_to_cart': {
        if (!this.ctx.actor) return { error: 'Khách chưa đăng nhập — mời đăng nhập để thêm giỏ.' };
        const p = await this.d.products.detailForAi(argStr(a.slug));
        if (!p) return { error: 'Không tìm thấy sản phẩm' };
        const inStock = p.variants.filter((v) => v.inStock);
        if (inStock.length === 0) return { error: 'Sản phẩm hết hàng ở mọi màu/size' };
        let variant = a.variant_id ? inStock.find((v) => v.id === argStr(a.variant_id)) : undefined;
        if (!variant && a.variant_hint) variant = ToolBox.pickVariant(argStr(a.variant_hint), inStock);
        if (!variant && inStock.length === 1) variant = inStock[0];
        if (!variant) return { need_variant: true, name: p.name, variants: inStock.map((v) => ({ variant_id: v.id, label: `${v.colorName} / ${v.sizeCode}`, price: formatVnd(BigInt(v.price)) })), hint: 'Liệt kê và HỎI khách chọn màu/size, rồi gọi lại với variant_id.' };
        const quantity = Math.min(10, Math.max(1, Number(a.quantity ?? 1)));
        const label = `${variant.colorName} / ${variant.sizeCode}`;
        const action = await this.d.actions.propose({ sessionId: this.ctx.sessionId, userId: this.ctx.actor.userId, kind: ACTION_KIND.ADD_TO_CART, params: { variantId: variant.id, quantity, productName: p.name, variantLabel: label, slug: p.slug }, summary: `Thêm ${p.name} (${label}) ×${quantity} vào giỏ` });
        this.actions.push(action);
        this.cite(await this.d.products.cardsByIds([p.id]));
        return { proposed: true, action_id: action.id, summary: action.summary, hint: 'Nói với khách: đã tạo đề xuất, bấm Xác nhận trên thẻ để thêm. KHÔNG nói đã thêm.' };
      }
      case 'cancel_order': {
        if (!this.ctx.actor) return { error: 'Khách chưa đăng nhập' };
        const code = argStr(a.order_code).trim().toUpperCase();
        const o = await this.d.orders.findByCodeForUser(this.ctx.actor.userId, code);
        if (!o) return { error: `Không có đơn ${code} trong tài khoản này` };
        if (o.status !== 'pending') return { error: `Đơn ${code} đang "${ORDER_STATUS_LABEL[o.status] ?? o.status}" — chỉ huỷ được khi còn Chờ xác nhận; gợi ý khách liên hệ nhân viên.` };
        const action = await this.d.actions.propose({ sessionId: this.ctx.sessionId, userId: this.ctx.actor.userId, kind: ACTION_KIND.CANCEL_ORDER, params: { orderCode: code, reason: a.reason ? argStr(a.reason).slice(0, 255) : 'Khách huỷ qua trợ lý' }, summary: `Huỷ đơn ${code} (${formatVnd(BigInt(o.total))})` });
        this.actions.push(action);
        return { proposed: true, action_id: action.id, summary: action.summary, hint: 'Nói với khách: đã tạo đề xuất huỷ, bấm Xác nhận để huỷ. KHÔNG nói đã huỷ.' };
      }
      default:
        return { error: `Tool không tồn tại: ${name}` };
    }
  }

  /* Khách nói phân loại bằng lời ("đen size L", "cái thứ hai") — chỉ chọn khi khớp DUY NHẤT, mơ hồ → undefined để model hỏi lại. */
  static pickVariant<T extends { colorName: string; sizeCode: string }>(hint: string, variants: T[]): T | undefined {
    const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
    const words = norm(hint).split(/[\s,/]+/).filter((w) => w && !FILLER.has(w));
    const ordinal: Record<string, number> = { 'dau tien': 0, 'thu nhat': 0, 'thu hai': 1, 'thu 2': 1, 'thu ba': 2, 'thu 3': 2, 'cuoi cung': -1, cuoi: -1 };
    for (const [k, idx] of Object.entries(ordinal)) if (norm(hint).includes(k)) return variants.at(idx);
    const matched = variants.filter((v) => {
      const label = norm(`${v.colorName} ${v.sizeCode}`);
      return words.every((w) => label.split(/\s+/).includes(w) || label.includes(w));
    });
    return matched.length === 1 ? matched[0] : undefined;
  }
}
