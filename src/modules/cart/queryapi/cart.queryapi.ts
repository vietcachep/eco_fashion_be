import { Injectable } from '@nestjs/common';
import { Basket, CartService } from '../cart.service';

export type { Basket } from '../cart.service';

/* QueryAPI của cart — order/promotion đọc giỏ (dòng đã tick) với tiền bigint. Thứ DUY NHẤT module khác import từ cart. */
@Injectable()
export class CartQueryApi {
  constructor(private readonly cart: CartService) {}

  basketOf(userId: string, onlySelected = true): Promise<Basket> {
    return this.cart.basket(userId, onlySelected);
  }
}
