import { Injectable } from '@nestjs/common';
import { ShippingService } from '../shipment/shipping.service';
export type { ShippingQuoteSnapshot, ShipmentSummary } from '../foundation/shipping.types';

/* Cổng chỉ đọc, không gọi mạng/tự ghi khi lấy quote hay lịch sử đơn. */
@Injectable()
export class ShippingQueryApi {
  constructor(private readonly shipping: ShippingService) {}
  quote(id: string, userId: string) { return this.shipping.getQuote(id, userId); }
  latest(code: string) { return this.shipping.latest(code); }
  history(code: string) { return this.shipping.history(code); }
  summaries(codes: string[]) { return this.shipping.summaries(codes); }
}

export { ShipmentResponse } from '../shipment/shipping.dto';
