import { Injectable } from '@nestjs/common';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import type { Tx } from '@common/prisma/types';
import type { QuoteInput } from '../foundation/shipping.types';
import { ShippingService } from '../shipment/shipping.service';
export type { QuoteInput, ShippingQuoteSnapshot, ShipmentSummary } from '../foundation/shipping.types';

/* Cổng command shipping; caller giữ thứ tự khoá đơn→shipment khi dùng barrier trong tx. */
@Injectable()
export class ShippingApplicationApi {
  constructor(private readonly shipping: ShippingService) {}
  quote(input: QuoteInput) { return this.shipping.quote(input); }
  ship(actor: AuthenticatedActor | null, shopId: string, code: string) { return this.shipping.ship(actor, shopId, code); }
  reconcile(actor: AuthenticatedActor | null, shopId: string, code: string) { return this.shipping.reconcile(actor, shopId, code); }
  cancel(actor: AuthenticatedActor | null, shopId: string, code: string) { return this.shipping.cancel(actor, shopId, code); }
  barrier(code: string, tx: Tx) { return this.shipping.barrier(code, tx); }
}
