import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BusinessException } from '@common/exception/business.exception';
import { ApiResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor, RequirePermission } from '@common/security/decorators';
import { CollectionAdminResponse } from '../dto/collection.responses';
import { CreateCollectionRequest, UpdateCollectionRequest } from '../request/collection.requests';
import { CollectionService } from '../service/collection.service';

@ApiTags('admin-catalog')
@ApiBearerAuth()
@Controller('admin/collections')
export class AdminCollectionController {
  constructor(private readonly collections: CollectionService) {}

  @Get()
  @RequirePermission('catalog.category.read')
  @ApiOkResponse({ type: [CollectionAdminResponse] })
  async list(): Promise<ApiResponse<CollectionAdminResponse[]>> {
    return ApiResponse.ok(await this.collections.listAdmin());
  }

  @Post()
  @RequirePermission('catalog.collection.manage')
  @ApiOperation({ summary: 'Tạo bộ sưu tập' })
  @ApiOkResponse({ type: CollectionAdminResponse })
  async create(@CurrentActor() actor: AuthenticatedActor, @Body() body: CreateCollectionRequest): Promise<ApiResponse<CollectionAdminResponse>> {
    return ApiResponse.ok(await this.collections.create(actor, body), 'Đã tạo bộ sưu tập');
  }

  @Patch(':id')
  @RequirePermission('catalog.collection.manage')
  @ApiOkResponse({ type: CollectionAdminResponse })
  async update(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateCollectionRequest): Promise<ApiResponse<CollectionAdminResponse>> {
    return ApiResponse.ok(await this.collections.update(actor, id, body), 'Đã cập nhật');
  }

  @Put(':id/image')
  @RequirePermission('catalog.collection.manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
  @ApiOkResponse({ type: CollectionAdminResponse })
  async image(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file?: Express.Multer.File): Promise<ApiResponse<CollectionAdminResponse>> {
    if (!file) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Thiếu file ảnh (field `file`)');
    return ApiResponse.ok(await this.collections.updateImage(actor, id, { buffer: file.buffer, mimetype: file.mimetype, size: file.size }), 'Đã đổi ảnh');
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('catalog.collection.manage')
  async remove(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<null>> {
    await this.collections.remove(actor, id);
    return ApiResponse.ok(null, 'Đã xoá bộ sưu tập');
  }
}
