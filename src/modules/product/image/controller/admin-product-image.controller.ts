import { Body, Controller, Delete, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BusinessException } from '@common/exception/business.exception';
import { ApiResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor, RequirePermission } from '@common/security/decorators';
import { RateLimit } from '@common/security/rate-limit.guard';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { ProductAdminResponse } from '../../product/dto/product.responses';
import { ReorderImagesRequest, UpdateImageRequest } from '../../product/request/product.requests';
import { ProductImageService } from '../service/product-image.service';

/* Field multipart đi kèm file — phải có decorator validator, nếu không ValidationPipe(whitelist) lọc mất. */
class UploadImageBody {
  @IsOptional() @Matches(/^[a-z0-9-]+$/) @MaxLength(40) colorCode?: string;
  @IsOptional() @IsString() @MaxLength(200) alt?: string;
  @IsOptional() @IsString() isPrimary?: string;
}

/* /admin/products/:id/images — upload Cloudinary (multipart `file`, kèm colorCode/alt/isPrimary), sắp xếp, xoá. */
@ApiTags('admin-products')
@ApiBearerAuth()
@Controller('admin/products/:id/images')
export class AdminProductImageController {
  constructor(private readonly images: ProductImageService) {}

  @Post()
  @RequirePermission('product.product.update')
  @RateLimit({ name: 'product-image-upload', limit: 60, windowSeconds: 600, by: 'user' })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, colorCode: { type: 'string', example: 'den' }, alt: { type: 'string' }, isPrimary: { type: 'string', example: 'true' } } } })
  @ApiOperation({ summary: 'Thêm ảnh (JPG/PNG/WEBP ≤ 5MB, tối đa 12 ảnh) — gắn màu để thẻ đổi ảnh theo màu' })
  @ApiOkResponse({ type: ProductAdminResponse })
  async upload(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: UploadImageBody, @UploadedFile() file?: Express.Multer.File): Promise<ApiResponse<ProductAdminResponse>> {
    if (!file) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Thiếu file ảnh (field `file`)');
    const r = await this.images.upload(actor, id, { buffer: file.buffer, mimetype: file.mimetype, size: file.size }, { colorCode: body.colorCode || null, alt: body.alt || null, isPrimary: body.isPrimary === 'true' });
    return ApiResponse.ok(r, 'Đã thêm ảnh');
  }

  @Patch(':imageId')
  @RequirePermission('product.product.update')
  @ApiOperation({ summary: 'Đổi màu gắn / alt / đặt ảnh chính' })
  @ApiOkResponse({ type: ProductAdminResponse })
  async update(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @Param('imageId', ParseUUIDPipe) imageId: string, @Body() body: UpdateImageRequest): Promise<ApiResponse<ProductAdminResponse>> {
    return ApiResponse.ok(await this.images.update(actor, id, imageId, body), 'Đã cập nhật ảnh');
  }

  @Put('order')
  @RequirePermission('product.product.update')
  @ApiOperation({ summary: 'Sắp xếp lại ảnh (ảnh đầu = ảnh chính)' })
  @ApiOkResponse({ type: ProductAdminResponse })
  async reorder(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReorderImagesRequest): Promise<ApiResponse<ProductAdminResponse>> {
    return ApiResponse.ok(await this.images.reorder(actor, id, body.imageIds), 'Đã sắp xếp ảnh');
  }

  @Delete(':imageId')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('product.product.update')
  @ApiOkResponse({ type: ProductAdminResponse })
  async remove(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @Param('imageId', ParseUUIDPipe) imageId: string): Promise<ApiResponse<ProductAdminResponse>> {
    return ApiResponse.ok(await this.images.remove(actor, id, imageId), 'Đã xoá ảnh');
  }
}
