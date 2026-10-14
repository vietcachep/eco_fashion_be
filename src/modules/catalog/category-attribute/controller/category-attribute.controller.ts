import { Body, Controller, Get, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor, RequirePermission } from '@common/security/decorators';
import { CategoryAttributeTemplate } from '../dto/category-attribute.responses';
import { SetCategoryAttributeTemplateRequest } from '../request/category-attribute.requests';
import { CategoryAttributeService } from '../service/category-attribute.service';

@ApiTags('admin-catalog')
@ApiBearerAuth()
@Controller('admin/categories/:categoryId/attributes')
export class AdminCategoryAttributeController {
  constructor(private readonly service: CategoryAttributeService) {}

  @Get()
  @RequirePermission('catalog.category.read')
  @ApiOperation({ summary: 'Xem mẫu thuộc tính của ngành hàng (PLAN-0016)' })
  @ApiOkResponse({ type: CategoryAttributeTemplate })
  async getTemplate(@Param('categoryId', ParseUUIDPipe) categoryId: string): Promise<ApiResponse<CategoryAttributeTemplate>> {
    return ApiResponse.ok(await this.service.getTemplate(categoryId));
  }

  @Put()
  @RequirePermission('catalog.category.manage')
  @ApiOperation({ summary: 'Set mẫu thuộc tính cho ngành hàng (replace toàn bộ, max 2 variant axis)' })
  @ApiOkResponse({ type: CategoryAttributeTemplate })
  async setTemplate(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('categoryId', ParseUUIDPipe) categoryId: string,
    @Body() body: SetCategoryAttributeTemplateRequest,
  ): Promise<ApiResponse<CategoryAttributeTemplate>> {
    return ApiResponse.ok(await this.service.setTemplate(actor, categoryId, body.attributes), 'Đã cập nhật mẫu thuộc tính');
  }
}
