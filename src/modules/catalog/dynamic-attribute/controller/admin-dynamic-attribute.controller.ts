import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor, RequirePermission } from '@common/security/decorators';
import { DynamicAttributeResponse } from '../dto/dynamic-attribute.responses';
import { CreateDynamicAttributeRequest, CreateDynamicAttributeValueRequest, UpdateDynamicAttributeValueRequest } from '../request/dynamic-attribute.requests';
import { DynamicAttributeService } from '../service/dynamic-attribute.service';

@ApiTags('admin-catalog')
@ApiBearerAuth()
@Controller('admin/dynamic-attributes')
export class AdminDynamicAttributeController {
  constructor(private readonly service: DynamicAttributeService) {}

  @Get()
  @RequirePermission('catalog.dynamic_attribute.read')
  @ApiOperation({ summary: 'Danh sách thuộc tính động (PLAN-0016)' })
  @ApiOkResponse({ type: [DynamicAttributeResponse] })
  async list(): Promise<ApiResponse<DynamicAttributeResponse[]>> {
    return ApiResponse.ok(await this.service.list());
  }

  @Get(':id')
  @RequirePermission('catalog.dynamic_attribute.read')
  @ApiOperation({ summary: 'Chi tiết thuộc tính động' })
  @ApiOkResponse({ type: DynamicAttributeResponse })
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<DynamicAttributeResponse>> {
    return ApiResponse.ok(await this.service.getById(id));
  }

  @Post()
  @RequirePermission('catalog.dynamic_attribute.manage')
  @ApiOperation({ summary: 'Tạo thuộc tính động mới' })
  @ApiOkResponse({ type: DynamicAttributeResponse })
  async create(@CurrentActor() actor: AuthenticatedActor, @Body() body: CreateDynamicAttributeRequest): Promise<ApiResponse<DynamicAttributeResponse>> {
    return ApiResponse.ok(await this.service.create(actor, body), 'Đã tạo thuộc tính');
  }

  @Post(':id/values')
  @RequirePermission('catalog.dynamic_attribute.manage')
  @ApiOperation({ summary: 'Thêm giá trị cho thuộc tính' })
  @ApiOkResponse({ type: DynamicAttributeResponse })
  async addValue(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateDynamicAttributeValueRequest,
  ): Promise<ApiResponse<DynamicAttributeResponse>> {
    return ApiResponse.ok(await this.service.addValue(actor, id, body), 'Đã thêm giá trị');
  }

  @Put(':id/values/:valueId')
  @RequirePermission('catalog.dynamic_attribute.manage')
  @ApiOperation({ summary: 'Sửa giá trị thuộc tính' })
  @ApiOkResponse({ type: DynamicAttributeResponse })
  async updateValue(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('valueId', ParseUUIDPipe) valueId: string,
    @Body() body: UpdateDynamicAttributeValueRequest,
  ): Promise<ApiResponse<DynamicAttributeResponse>> {
    return ApiResponse.ok(await this.service.updateValue(actor, id, valueId, body), 'Đã cập nhật');
  }

  @Delete(':id/values/:valueId')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('catalog.dynamic_attribute.manage')
  @ApiOperation({ summary: 'Xoá giá trị thuộc tính' })
  async deleteValue(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @Param('valueId', ParseUUIDPipe) valueId: string): Promise<ApiResponse<null>> {
    await this.service.deleteValue(actor, id, valueId);
    return ApiResponse.ok(null, 'Đã xoá giá trị');
  }
}
