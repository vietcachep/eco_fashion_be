import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsInt, IsUUID, Max, Min, ValidateNested } from 'class-validator';
import { ApiResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor } from '@common/security/decorators';
import { RateLimit } from '@common/security/rate-limit.guard';
import type { ProductCardResponse } from '../product/queryapi/product.queryapi';
import { CartResponse, CartService } from './cart.service';
import { WishlistService } from './wishlist.service';

class AddCartItemRequest {
  @ApiProperty() @IsUUID() variantId: string;
  @ApiProperty({ example: 1 }) @Type(() => Number) @IsInt() @Min(1) @Max(100) quantity: number;
}
class UpdateCartItemRequest {
  @ApiProperty({ example: 2, description: '0 = xoá dòng' }) @Type(() => Number) @IsInt() @Min(0) @Max(100) quantity: number;
}
class SelectCartItemRequest {
  @ApiProperty() @IsBoolean() selected: boolean;
}
class GuestLine {
  @IsUUID() variantId: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) quantity: number;
}
class MergeCartRequest {
  @ApiProperty({ type: [GuestLine] }) @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => GuestLine) lines: GuestLine[];
}

/* /cart — giỏ của CHÍNH người đăng nhập (docs/06 mục cart). Khách vãng lai giữ giỏ ở FE, đăng nhập thì POST /cart/merge. */
@ApiTags('cart')
@ApiBearerAuth()
@Controller('cart')
export class CartController {
  constructor(private readonly cart: CartService) {}

  @Get() @ApiOperation({ summary: 'Giỏ hiện tại (giá/tồn sống, cảnh báo hết hàng)' })
  async get(@CurrentActor() actor: AuthenticatedActor): Promise<ApiResponse<CartResponse>> {
    return ApiResponse.ok(await this.cart.getCart(actor.userId));
  }

  @Post('items') @RateLimit({ name: 'cart-add', limit: 60, windowSeconds: 60, by: 'user' }) @ApiOperation({ summary: 'Thêm biến thể vào giỏ (cộng dồn)' })
  async add(@CurrentActor() actor: AuthenticatedActor, @Body() body: AddCartItemRequest): Promise<ApiResponse<CartResponse>> {
    return ApiResponse.ok(await this.cart.addItem(actor.userId, body.variantId, body.quantity), 'Đã thêm vào giỏ');
  }

  @Patch('items/:variantId') @ApiOperation({ summary: 'Đổi số lượng (0 = xoá)' })
  async update(@CurrentActor() actor: AuthenticatedActor, @Param('variantId', ParseUUIDPipe) variantId: string, @Body() body: UpdateCartItemRequest): Promise<ApiResponse<CartResponse>> {
    return ApiResponse.ok(await this.cart.updateQuantity(actor.userId, variantId, body.quantity));
  }

  @Patch('items/:variantId/select') @ApiOperation({ summary: 'Tick / bỏ tick dòng để thanh toán' })
  async select(@CurrentActor() actor: AuthenticatedActor, @Param('variantId', ParseUUIDPipe) variantId: string, @Body() body: SelectCartItemRequest): Promise<ApiResponse<CartResponse>> {
    return ApiResponse.ok(await this.cart.setSelected(actor.userId, variantId, body.selected));
  }

  @Delete('items/:variantId') @HttpCode(HttpStatus.OK)
  async remove(@CurrentActor() actor: AuthenticatedActor, @Param('variantId', ParseUUIDPipe) variantId: string): Promise<ApiResponse<CartResponse>> {
    return ApiResponse.ok(await this.cart.removeItem(actor.userId, variantId), 'Đã xoá khỏi giỏ');
  }

  @Delete() @HttpCode(HttpStatus.OK)
  async clear(@CurrentActor() actor: AuthenticatedActor): Promise<ApiResponse<CartResponse>> {
    return ApiResponse.ok(await this.cart.clear(actor.userId), 'Đã xoá giỏ');
  }

  @Post('merge') @HttpCode(HttpStatus.OK) @ApiOperation({ summary: 'Gộp giỏ khách vãng lai (FE) vào giỏ server sau đăng nhập' })
  async merge(@CurrentActor() actor: AuthenticatedActor, @Body() body: MergeCartRequest): Promise<ApiResponse<CartResponse>> {
    return ApiResponse.ok(await this.cart.merge(actor.userId, body.lines));
  }
}

@ApiTags('wishlist')
@ApiBearerAuth()
@Controller('wishlist')
export class WishlistController {
  constructor(private readonly wishlist: WishlistService) {}

  @Get() @ApiOperation({ summary: 'Sản phẩm yêu thích (thẻ) + danh sách id' })
  async list(@CurrentActor() actor: AuthenticatedActor): Promise<ApiResponse<{ productIds: string[]; products: ProductCardResponse[] }>> {
    return ApiResponse.ok(await this.wishlist.list(actor.userId));
  }

  @Post(':productId') @HttpCode(HttpStatus.OK)
  async add(@CurrentActor() actor: AuthenticatedActor, @Param('productId', ParseUUIDPipe) productId: string): Promise<ApiResponse<string[]>> {
    return ApiResponse.ok(await this.wishlist.add(actor.userId, productId), 'Đã thêm vào yêu thích');
  }

  @Post(':productId/toggle') @HttpCode(HttpStatus.OK)
  async toggle(@CurrentActor() actor: AuthenticatedActor, @Param('productId', ParseUUIDPipe) productId: string): Promise<ApiResponse<{ added: boolean; productIds: string[] }>> {
    const r = await this.wishlist.toggle(actor.userId, productId);
    return ApiResponse.ok(r, r.added ? 'Đã thêm vào yêu thích' : 'Đã bỏ yêu thích');
  }

  @Delete(':productId') @HttpCode(HttpStatus.OK)
  async remove(@CurrentActor() actor: AuthenticatedActor, @Param('productId', ParseUUIDPipe) productId: string): Promise<ApiResponse<string[]>> {
    return ApiResponse.ok(await this.wishlist.remove(actor.userId, productId), 'Đã bỏ yêu thích');
  }
}
