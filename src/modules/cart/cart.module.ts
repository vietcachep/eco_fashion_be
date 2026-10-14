import { Module } from '@nestjs/common';
import { CART_GATEWAY } from '@common/gateway/cart.gateway';
import { ProductModule } from '../product/product.module';
import { ShopModule } from '../shop/shop.module';
import { SystemModule } from '../system/system.module';
import { CartController, WishlistController } from './cart.controllers';
import { CartService } from './cart.service';
import { CartQueryApi } from './queryapi/cart.queryapi';
import { WishlistService } from './wishlist.service';

/* Module cart (PLAN-0005): giỏ theo user + yêu thích. Export CartQueryApi (đọc giỏ) và CART_GATEWAY (order xoá dòng đã mua). */
@Module({
  imports: [ProductModule, SystemModule, ShopModule],
  controllers: [CartController, WishlistController],
  providers: [CartService, WishlistService, CartQueryApi, { provide: CART_GATEWAY, useExisting: CartService }],
  exports: [CartQueryApi, CART_GATEWAY],
})
export class CartModule {}
