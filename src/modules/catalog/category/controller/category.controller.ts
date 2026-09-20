import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiResponse } from '@common/response/api-response';
import { Public } from '@common/security/decorators';
import { CategoryResponse } from '../dto/category.responses';
import { CategoryService } from '../service/category.service';

/* Công khai: ngành hàng đang bán cho menu/trang chủ/bộ lọc (FE `GET /categories`). */
@ApiTags('catalog')
@Controller('categories')
export class CategoryController {
  constructor(private readonly categories: CategoryService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Ngành hàng đang bán (kèm số sản phẩm)' })
  @ApiOkResponse({ type: [CategoryResponse] })
  async list(): Promise<ApiResponse<CategoryResponse[]>> {
    return ApiResponse.ok(await this.categories.listPublic());
  }
}
