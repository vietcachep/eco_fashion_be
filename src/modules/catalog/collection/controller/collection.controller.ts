import { Controller, Get, Param } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiResponse } from '@common/response/api-response';
import { Public } from '@common/security/decorators';
import { CollectionResponse } from '../dto/collection.responses';
import { CollectionService } from '../service/collection.service';

/* Công khai: bộ sưu tập trang chủ (FE `GET /collections`, `/collections/{slug}`). */
@ApiTags('catalog')
@Controller('collections')
export class CollectionController {
  constructor(private readonly collections: CollectionService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Bộ sưu tập đang hiện (mỗi bộ = một bộ lọc có sẵn)' })
  @ApiOkResponse({ type: [CollectionResponse] })
  async list(): Promise<ApiResponse<CollectionResponse[]>> {
    return ApiResponse.ok(await this.collections.listPublic());
  }

  @Public()
  @Get(':slug')
  @ApiOkResponse({ type: CollectionResponse })
  async get(@Param('slug') slug: string): Promise<ApiResponse<CollectionResponse>> {
    return ApiResponse.ok(await this.collections.getPublic(slug));
  }
}
