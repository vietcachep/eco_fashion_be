import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BusinessException } from '@common/exception/business.exception';
import { ApiResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor, RequirePermission } from '@common/security/decorators';
import { CategoryAdminResponse } from '../dto/category.responses';
import { CreateCategoryRequest, UpdateCategoryRequest } from '../request/category.requests';
import { CategoryService } from '../service/category.service';

@ApiTags('admin-catalog')
@ApiBearerAuth()
@Controller('admin/categories')
export class AdminCategoryController {
  constructor(private readonly categories: CategoryService) {}

  @Get()
  @RequirePermission('catalog.category.read')
  @ApiOperation({ summary: 'Mọi ngành hàng (kể cả đang ẩn)' })
  @ApiOkResponse({ type: [CategoryAdminResponse] })
  async list(): Promise<ApiResponse<CategoryAdminResponse[]>> {
    return ApiResponse.ok(await this.categories.listAdmin());
  }

  @Get(':id')
  @RequirePermission('catalog.category.read')
  @ApiOkResponse({ type: CategoryAdminResponse })
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<CategoryAdminResponse>> {
    return ApiResponse.ok(await this.categories.getAdmin(id));
  }

  @Post()
  @RequirePermission('catalog.category.manage')
  @ApiOperation({ summary: 'Tạo ngành hàng' })
  @ApiOkResponse({ type: CategoryAdminResponse })
  async create(@CurrentActor() actor: AuthenticatedActor, @Body() body: CreateCategoryRequest): Promise<ApiResponse<CategoryAdminResponse>> {
    return ApiResponse.ok(await this.categories.create(actor, body), 'Đã tạo ngành hàng');
  }

  @Patch(':id')
  @RequirePermission('catalog.category.manage')
  @ApiOperation({ summary: 'Sửa ngành hàng (đổi slug/tên → sản phẩm cập nhật theo qua worker)' })
  @ApiOkResponse({ type: CategoryAdminResponse })
  async update(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateCategoryRequest): Promise<ApiResponse<CategoryAdminResponse>> {
    return ApiResponse.ok(await this.categories.update(actor, id, body), 'Đã cập nhật');
  }

  @Put(':id/image')
  @RequirePermission('catalog.category.manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
  @ApiOperation({ summary: 'Đổi ảnh ngành hàng (Cloudinary)' })
  @ApiOkResponse({ type: CategoryAdminResponse })
  async image(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file?: Express.Multer.File): Promise<ApiResponse<CategoryAdminResponse>> {
    if (!file) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Thiếu file ảnh (field `file`)');
    return ApiResponse.ok(await this.categories.updateImage(actor, id, { buffer: file.buffer, mimetype: file.mimetype, size: file.size }), 'Đã đổi ảnh');
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('catalog.category.manage')
  @ApiOperation({ summary: 'Xoá mềm (chỉ khi không còn sản phẩm đang bán)' })
  async remove(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<null>> {
    await this.categories.remove(actor, id);
    return ApiResponse.ok(null, 'Đã xoá ngành hàng');
  }
}
