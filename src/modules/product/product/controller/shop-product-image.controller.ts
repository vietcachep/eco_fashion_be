import { Body, Controller, Delete, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BusinessException } from '@common/exception/business.exception';
import { ApiResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor } from '@common/security/decorators';
import { RateLimit } from '@common/security/rate-limit.guard';
import { CurrentShop, RequireShopPermission, ShopContext } from '@modules/shop/security/shop-permission.decorator';
import { ShopContextGuard } from '@modules/shop/security/shop-context.guard';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { ProductAdminResponse } from '../dto/product.responses';
import { ReorderImagesRequest, UpdateImageRequest } from '../request/product.requests';
import { ShopProductImageService } from '../service/shop-product-image.service';

/*
 * Multipart field yêu cầu class-validator nếu không ValidationPipe(whitelist) lọc mất.
 */
class UploadImageBody {
  @IsOptional() @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/i) @MaxLength(40) colorCode?: string;
  @IsOptional() @IsString() @MaxLength(200) alt?: string;
  @IsOptional() @IsString() isPrimary?: string;
}

/*
 * /shop/products/:id/images — vendor upload ảnh cho sản phẩm của mình (PLAN-0017 bước 2):
 * - POST: upload (Cloudinary)
 * - PATCH :imageId: sửa màu gắn / alt / đặt ảnh chính
 * - PUT order: sắp xếp lại ảnh
 * - DELETE :imageId: xoá ảnh
 * Kiểm ownership: product.shopId = ctx.shopId, nếu không → 404.
 */
@ApiTags('shops')
@ApiBearerAuth()
@Controller('shop/products/:id/images')
@UseGuards(ShopContextGuard)
export class ShopProductImageController {
  constructor(private readonly images: ShopProductImageService) {}

  @Post()
  @RequireShopPermission('shop.product.manage')
  @RateLimit({ name: 'shop-product-image-upload', limit: 60, windowSeconds: 3600, by: 'user' })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, colorCode: { type: 'string', example: 'den' }, alt: { type: 'string' }, isPrimary: { type: 'string', example: 'true' } } } })
  @ApiOperation({ summary: 'Thêm ảnh (JPG/PNG/WEBP/GIF ≤ 5MB, kiểm nội dung thật của file; tối đa 12 ảnh)' })
  @ApiOkResponse({ type: ProductAdminResponse })
  async upload(
    @CurrentActor() actor: AuthenticatedActor,
    @CurrentShop() shop: ShopContext,
    @Param('id', ParseUUIDPipe) productId: string,
    @Body() body: UploadImageBody,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<ApiResponse<ProductAdminResponse>> {
    if (!file) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Thiếu file ảnh (field `file`)');
    const r = await this.images.uploadShop(actor, shop.shopId, productId, { buffer: file.buffer, mimetype: file.mimetype, size: file.size }, { colorCode: body.colorCode || null, alt: body.alt || null, isPrimary: body.isPrimary === 'true' });
    return ApiResponse.ok(r, 'Đã thêm ảnh');
  }

  @Patch(':imageId')
  @RequireShopPermission('shop.product.manage')
  @ApiOperation({ summary: 'Đổi màu gắn / alt / đặt ảnh chính (không bỏ được cờ ảnh chính của ảnh chính hiện tại — chọn ảnh khác làm chính)' })
  @ApiOkResponse({ type: ProductAdminResponse })
  async update(
    @CurrentActor() actor: AuthenticatedActor,
    @CurrentShop() shop: ShopContext,
    @Param('id', ParseUUIDPipe) productId: string,
    @Param('imageId', ParseUUIDPipe) imageId: string,
    @Body() body: UpdateImageRequest,
  ): Promise<ApiResponse<ProductAdminResponse>> {
    return ApiResponse.ok(await this.images.updateShop(actor, shop.shopId, productId, imageId, body), 'Đã cập nhật ảnh');
  }

  @Put('order')
  @RequireShopPermission('shop.product.manage')
  @RateLimit({ name: 'shop-product-image-order', limit: 120, windowSeconds: 3600, by: 'user' })
  @ApiOperation({ summary: 'Sắp xếp lại ảnh (ảnh đầu = ảnh chính)' })
  @ApiOkResponse({ type: ProductAdminResponse })
  async reorder(
    @CurrentActor() actor: AuthenticatedActor,
    @CurrentShop() shop: ShopContext,
    @Param('id', ParseUUIDPipe) productId: string,
    @Body() body: ReorderImagesRequest,
  ): Promise<ApiResponse<ProductAdminResponse>> {
    return ApiResponse.ok(await this.images.reorderShop(actor, shop.shopId, productId, body.imageIds), 'Đã sắp xếp ảnh');
  }

  @Delete(':imageId')
  @HttpCode(HttpStatus.OK)
  @RequireShopPermission('shop.product.manage')
  @ApiOperation({ summary: 'Xoá ảnh (409 PRODUCT_IMAGE_REQUIRED nếu là ảnh cuối của sản phẩm đang bán)' })
  @ApiOkResponse({ type: ProductAdminResponse })
  async remove(
    @CurrentActor() actor: AuthenticatedActor,
    @CurrentShop() shop: ShopContext,
    @Param('id', ParseUUIDPipe) productId: string,
    @Param('imageId', ParseUUIDPipe) imageId: string,
  ): Promise<ApiResponse<ProductAdminResponse>> {
    return ApiResponse.ok(await this.images.removeShop(actor, shop.shopId, productId, imageId), 'Đã xoá ảnh');
  }
}
