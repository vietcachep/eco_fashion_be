import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { isUUID } from 'class-validator';
import { BusinessException } from '@common/exception/business.exception';
import { ApiResponse } from '@common/response/api-response';
import { CurrentActor } from '@common/security/decorators';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { RateLimit } from '@common/security/rate-limit.guard';
import { CheckoutIntentRepository } from './checkout-intent.repository';
import { CheckoutIntentService } from './checkout-intent.service';
import {
  CheckoutAttemptResponse,
  CheckoutIntentQuoteResponse,
  CheckoutIntentResponse,
  CreateCheckoutIntentRequest,
  IntentAttemptRequest,
  IntentQuoteRequest,
} from './checkout-intent.dto';

@ApiTags('checkout-intents')
@ApiBearerAuth()
@Controller('checkout/intents')
export class CheckoutIntentController {
  constructor(
    private readonly repo: CheckoutIntentRepository,
    private readonly service: CheckoutIntentService,
  ) {}
  private key(key: string | undefined): string {
    if (!key || !isUUID(key))
      throw new BusinessException('CHECKOUT_KEY_REQUIRED', 'Vui lòng gửi Idempotency-Key dạng UUID');
    return key;
  }
  @Post()
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOkResponse({ type: CheckoutIntentResponse })
  @RateLimit({ name: 'checkout-intent', limit: 40, windowSeconds: 60, by: 'user' })
  async create(
    @CurrentActor() actor: AuthenticatedActor,
    @Body() body: CreateCheckoutIntentRequest,
    @Headers('idempotency-key') key?: string,
  ) {
    return ApiResponse.ok(await this.repo.create(actor.userId, body, this.key(key)));
  }
  @Get(':id')
  @ApiOkResponse({ type: CheckoutIntentResponse })
  async get(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string) {
    return ApiResponse.ok(await this.repo.response(actor.userId, id));
  }
  @Post(':id/quote')
  @ApiOkResponse({ type: CheckoutIntentQuoteResponse })
  @RateLimit({ name: 'intent-quote', limit: 40, windowSeconds: 60, by: 'user' })
  async quote(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: IntentQuoteRequest,
  ) {
    return ApiResponse.ok(await this.service.quote(actor, id, body));
  }
  @Post(':id/attempts')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOkResponse({ type: CheckoutAttemptResponse })
  @RateLimit({ name: 'intent-place', limit: 10, windowSeconds: 600, by: 'user' })
  async attempt(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: IntentAttemptRequest,
    @Headers('idempotency-key') key?: string,
  ) {
    return ApiResponse.ok(await this.service.submit(actor, id, body, this.key(key)));
  }
  @Get(':id/attempts/:attemptId')
  @ApiOkResponse({ type: CheckoutAttemptResponse })
  @RateLimit({ name: 'intent-status', limit: 60, windowSeconds: 60, by: 'user' })
  async status(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attemptId', ParseUUIDPipe) attemptId: string,
  ) {
    return ApiResponse.ok(await this.service.read(actor, id, attemptId));
  }
}
