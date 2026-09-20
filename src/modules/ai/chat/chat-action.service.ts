import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CacheService, CacheSpec } from '@common/cache/cache.service';
import { BusinessException, NotFoundException } from '@common/exception/business.exception';
import { CART_GATEWAY, CartGateway } from '@common/gateway/cart.gateway';
import { ORDER_ACTIONS_GATEWAY, OrderActionsGateway } from '@common/gateway/order-actions.gateway';
import { PrismaService } from '@common/prisma/prisma.service';
import { Prisma } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { AI_MODULE } from '../foundation/ai.constants';
import { argStr } from '../foundation/arg';

export const ACTION_KIND = { ADD_TO_CART: 'add_to_cart', CANCEL_ORDER: 'cancel_order' } as const;
const ACTION_TTL = 30 * 60;
const SPEC: CacheSpec = { module: AI_MODULE, purpose: 'chat-action', ttlSeconds: ACTION_TTL };

export interface ChatAction {
  id: string;
  kind: string;
  sessionId: string;
  userId: string;
  params: Record<string, unknown>;
  summary: string;
}

export interface ChatActionResult {
  kind: string;
  status: 'done';
  summary: string;
  productName?: string;
  variantLabel?: string;
  quantity?: number;
  itemCount?: number;
  orderCode?: string;
  orderStatus?: string;
}

/*
 * HÀNH ĐỘNG CỦA TRỢ LÝ — AI *đề xuất* (tool add_to_cart / cancel_order), KHÁCH bấm Xác nhận, backend mới ghi qua CỔNG
 * (CartGateway.addItem / OrderActionsGateway.cancelByCustomer — đủ luật của module sở hữu). Đề xuất sống ở Redis 30 phút
 * (mất Redis chỉ mất một nút bấm); kết quả ghi vào chat_messages (meta.actionResult) để mở lại phiên vẫn thấy.
 * Vì sao không để model tự "xác nhận" bằng lời: nút bấm là chữ ký của khách, không phụ thuộc cách model hiểu hội thoại.
 */
@Injectable()
export class ChatActionService {
  private readonly logger = new Logger(ChatActionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    @Inject(CART_GATEWAY) private readonly cart: CartGateway,
    @Inject(ORDER_ACTIONS_GATEWAY) private readonly orders: OrderActionsGateway,
  ) {}

  async propose(input: { sessionId: string; userId: string; kind: string; params: Record<string, unknown>; summary: string }): Promise<ChatAction> {
    if (!Object.values(ACTION_KIND).includes(input.kind as never)) throw new BusinessException('AI_ACTION_KIND_INVALID', 'Loại hành động không hợp lệ');
    const a: ChatAction = { id: randomUUID(), kind: input.kind, sessionId: input.sessionId, userId: input.userId, params: input.params, summary: input.summary.slice(0, 300) };
    await this.cache.set(SPEC, a.id, a, ACTION_TTL);
    return a;
  }

  private async load(actionId: string, sessionId: string, actor: AuthenticatedActor): Promise<ChatAction> {
    const a = await this.cache.get<ChatAction>(SPEC, actionId);
    // Đúng PHIÊN và đúng NGƯỜI — không có chuyện confirm hộ.
    if (!a || a.sessionId !== sessionId || a.userId !== actor.userId) throw new NotFoundException('AI_ACTION_NOT_FOUND', 'Đề xuất đã hết hạn hoặc không thuộc phiên này');
    return a;
  }

  async reject(actor: AuthenticatedActor, sessionId: string, actionId: string): Promise<void> {
    await this.load(actionId, sessionId, actor);
    await this.cache.del(SPEC, actionId);
  }

  /* Xoá đề xuất TRƯỚC khi ghi (bấm hai lần không ghi hai lần). */
  async confirm(actor: AuthenticatedActor, sessionId: string, actionId: string): Promise<ChatActionResult> {
    const a = await this.load(actionId, sessionId, actor);
    await this.cache.del(SPEC, actionId);
    let result: ChatActionResult;
    if (a.kind === ACTION_KIND.ADD_TO_CART) {
      const r = await this.cart.addItem(actor.userId, argStr(a.params.variantId), Number(a.params.quantity ?? 1));
      result = { kind: a.kind, status: 'done', summary: a.summary, productName: argStr(a.params.productName), variantLabel: argStr(a.params.variantLabel), quantity: Number(a.params.quantity ?? 1), itemCount: r.itemCount };
    } else {
      const r = await this.orders.cancelByCustomer(actor, argStr(a.params.orderCode), (argStr(a.params.reason) || 'Khách huỷ qua trợ lý'));
      result = { kind: a.kind, status: 'done', summary: a.summary, orderCode: r.code, orderStatus: r.status };
    }
    const text = a.kind === ACTION_KIND.ADD_TO_CART ? `Đã thêm ${result.productName} (${result.variantLabel}) ×${result.quantity} vào giỏ của bạn.` : `Đã huỷ đơn ${result.orderCode}.`;
    await this.prisma.chatMessage.create({ data: { sessionId, role: 'assistant', content: text, source: 'rule', meta: { actionResult: result } as unknown as Prisma.InputJsonObject } });
    await this.prisma.chatSession.update({ where: { id: sessionId }, data: { messageCount: { increment: 1 }, lastMessageAt: new Date() } });
    this.logger.log({ kind: a.kind, userId: actor.userId, sessionId }, 'Khách xác nhận hành động của trợ lý');
    return result;
  }
}
