import { Injectable, Logger } from '@nestjs/common';
import { BusinessException } from '@common/exception/business.exception';
import { IdempotencyService } from '@common/idempotency/idempotency.service';
import { PrismaService } from '@common/prisma/prisma.service';
import { Prisma } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { OrderService } from '../order/service/order.service';
import { CheckoutIntentRepository } from './checkout-intent.repository';
import {
  CheckoutAttemptResponse,
  CheckoutIntentQuoteResponse,
  IntentAttemptRequest,
  IntentQuoteRequest,
} from './checkout-intent.dto';

@Injectable()
export class CheckoutIntentService {
  private readonly logger = new Logger(CheckoutIntentService.name);
  constructor(
    private readonly repo: CheckoutIntentRepository,
    private readonly prisma: PrismaService,
    private readonly orders: OrderService,
  ) {}
  async quote(
    actor: AuthenticatedActor,
    id: string,
    body: IntentQuoteRequest,
  ): Promise<CheckoutIntentQuoteResponse> {
    const row = await this.repo.row(actor.userId, id);
    if (row.version !== body.intentVersion)
      throw new BusinessException('CHECKOUT_INTENT_CHANGED', 'Lần mua đã thay đổi, vui lòng tải lại', 409);
    const summary = await this.orders.checkoutSummary(actor, { ...body, checkoutIntentId: id });
    await this.prisma.checkoutIntent.updateMany({
      where: { id, userId: actor.userId, state: 'active', expiresAt: { gt: new Date() } },
      data: { expiresAt: new Date(Date.now() + 30 * 60_000) },
    });
    return { intentId: id, intentVersion: row.version, summary };
  }
  async submit(
    actor: AuthenticatedActor,
    id: string,
    body: IntentAttemptRequest,
    key: string,
  ): Promise<CheckoutAttemptResponse> {
    const hash = IdempotencyService.hashRequest({ intentId: id, ...body });
    const attempt = await this.prisma.$transaction(async (tx) => {
      const intent = await this.repo.row(actor.userId, id, tx, true);
      const old = await tx.checkoutAttempt.findUnique({
        where: { userId_requestKey: { userId: actor.userId, requestKey: key } },
      });
      if (old) {
        if (old.intentId !== id || old.requestHash !== hash)
          throw new BusinessException(
            'COMMON_IDEMPOTENCY_KEY_REUSED',
            'Mã yêu cầu đã dùng cho lần đặt khác',
            409,
          );
        return old;
      }
      const command = JSON.parse(JSON.stringify(body)) as Prisma.InputJsonValue;
      if (intent.state === 'consumed')
        return tx.checkoutAttempt.create({
          data: {
            id: key,
            userId: actor.userId,
            intentId: id,
            requestKey: key,
            requestHash: hash,
            command,
            state: 'succeeded',
            groupCode: intent.resultGroupCode,
          },
        });
      const pending = await tx.checkoutAttempt.findFirst({ where: { intentId: id, state: 'processing' } });
      if (pending)
        throw new BusinessException(
          'CHECKOUT_ATTEMPT_IN_PROGRESS',
          'Lần đặt trước chưa rõ kết quả, hãy kiểm tra lần đặt đó',
          409,
          { attemptId: pending.id },
        );
      if (intent.expiresAt < new Date())
        throw new BusinessException(
          'CHECKOUT_INTENT_EXPIRED',
          'Lần mua đã hết hạn, hãy chọn lại sản phẩm',
          409,
        );
      if (intent.version !== body.intentVersion)
        throw new BusinessException('CHECKOUT_INTENT_CHANGED', 'Lần mua đã thay đổi, hãy tải lại', 409);
      await tx.checkoutIntent.update({ where: { id }, data: { state: 'submitting' } });
      return tx.checkoutAttempt.create({
        data: { id: key, userId: actor.userId, intentId: id, requestKey: key, requestHash: hash, command },
      });
    });
    await this.run(actor, attempt.id);
    return this.read(actor, id, attempt.id, false);
  }
  private async run(actor: AuthenticatedActor, attemptId: string): Promise<void> {
    const won = await this.prisma.checkoutAttempt.updateMany({
      where: {
        id: attemptId,
        userId: actor.userId,
        state: 'processing',
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
      },
      data: { leaseUntil: new Date(Date.now() + 90_000) },
    });
    if (!won.count) return;
    const attempt = await this.prisma.checkoutAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    const command = attempt.command as unknown as IntentAttemptRequest;
    try {
      const group = await this.orders.placeOrder(
        actor,
        { ...command, checkoutIntentId: attempt.intentId },
        'intent:' + attempt.id,
      );
      await this.prisma.checkoutAttempt.update({
        where: { id: attempt.id },
        data: { state: 'succeeded', groupCode: group.code, leaseUntil: null },
      });
    } catch (error: unknown) {
      if (
        error instanceof BusinessException &&
        Number(error.httpStatus) < 500 &&
        !['COMMON_IDEMPOTENCY_IN_PROGRESS', 'COMMON_DUPLICATE'].includes(error.errorCode)
      ) {
        await this.prisma.$transaction(async (tx) => {
          const intent = await this.repo.row(actor.userId, attempt.intentId, tx, true);
          if (intent.state === 'consumed') {
            await tx.checkoutAttempt.update({
              where: { id: attempt.id },
              data: { state: 'succeeded', groupCode: intent.resultGroupCode, leaseUntil: null },
            });
            return;
          }
          await tx.checkoutAttempt.update({
            where: { id: attempt.id },
            data: {
              state: 'failed_known',
              errorCode: error.errorCode,
              message: error.message.slice(0, 500),
              leaseUntil: null,
            },
          });
          await tx.checkoutIntent.update({ where: { id: intent.id }, data: { state: 'active' } });
        });
      }
      else this.logger.warn({ attemptId: attempt.id, errorType: error instanceof Error ? error.name : 'unknown' }, 'Kết quả đặt đơn chưa rõ; giữ attempt để đối soát, không tạo lần mua mới');
      // 5xx/network vẫn processing: sau lease dùng lại command/idempotency, không tạo group mới.
    }
  }
  async read(
    actor: AuthenticatedActor,
    intentId: string,
    id: string,
    resume = true,
  ): Promise<CheckoutAttemptResponse> {
    let a = await this.prisma.checkoutAttempt.findFirst({ where: { id, intentId, userId: actor.userId } });
    if (!a) {
      a = await this.prisma.$transaction(async (tx) => {
        const intent = await this.repo.row(actor.userId, intentId, tx, true);
        const existing = await tx.checkoutAttempt.findFirst({
          where: { id, intentId, userId: actor.userId },
        });
        if (existing) return existing;
        return tx.checkoutAttempt.create({
          data: {
            id,
            intentId,
            userId: actor.userId,
            requestKey: id,
            requestHash: 'FENCED_NOT_RECEIVED',
            command: {},
            state: intent.state === 'consumed' ? 'succeeded' : 'failed_known',
            groupCode: intent.resultGroupCode,
            errorCode: intent.state === 'consumed' ? null : 'CHECKOUT_REQUEST_NOT_RECEIVED',
            message:
              intent.state === 'consumed'
                ? null
                : 'Lệnh đặt chưa được ghi nhận; khoá cũ đã đóng an toàn, bạn có thể xác nhận đặt lại.',
          },
        });
      });
    }
    if (resume && a.state === 'processing' && (!a.leaseUntil || a.leaseUntil < new Date())) {
      await this.run(actor, id);
      a = await this.prisma.checkoutAttempt.findUniqueOrThrow({ where: { id } });
    }
    return {
      id: a.id,
      intentId: a.intentId,
      state: a.state,
      groupCode: a.groupCode,
      group: a.groupCode ? await this.orders.myOrderGroup(actor, a.groupCode) : null,
      errorCode: a.errorCode,
      message: a.message,
    };
  }
}
