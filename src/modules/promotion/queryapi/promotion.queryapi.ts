import { Injectable } from '@nestjs/common';
import type { BasketForPromotion } from '@common/gateway/promotion.gateway';
import { PromotionOfferResponse, PromotionService } from '../promotion.service';

export type { PromotionOfferResponse } from '../promotion.service';

/* QueryAPI của promotion — ai (chatbot kể mã đang chạy, tìm mã tốt nhất cho giỏ). Thứ DUY NHẤT module khác import. */
@Injectable()
export class PromotionQueryApi {
  constructor(private readonly promotions: PromotionService) {}

  /* Mã công khai đang chạy, tính giảm thật cho giỏ (giỏ rỗng → chỉ mô tả điều kiện). */
  offersFor(basket: BasketForPromotion): Promise<PromotionOfferResponse[]> {
    return this.promotions.offers(basket);
  }
}
