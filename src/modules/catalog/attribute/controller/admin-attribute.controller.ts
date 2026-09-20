import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor, Public, RequirePermission } from '@common/security/decorators';
import { AttributeResponse } from '../dto/attribute.responses';
import { SaveAttributeValueRequest } from '../request/attribute.requests';
import { AttributeService } from '../service/attribute.service';

/* GET /attributes công khai (bộ lọc màu/size cho web); ghi ở /admin/attributes. */
@ApiTags('catalog')
@Controller()
export class AttributeController {
  constructor(private readonly attributes: AttributeService) {}

  @Public()
  @Get('attributes')
  @ApiOperation({ summary: 'Thuộc tính màu (hex) / size (nhóm) / chất liệu — cho bộ lọc và form' })
  @ApiOkResponse({ type: [AttributeResponse] })
  async list(): Promise<ApiResponse<AttributeResponse[]>> {
    return ApiResponse.ok(await this.attributes.listAll());
  }

  @ApiBearerAuth()
  @Put('admin/attributes/:code/values')
  @RequirePermission('catalog.attribute.manage')
  @ApiOperation({ summary: 'Thêm / sửa một giá trị (upsert theo mã)' })
  @ApiOkResponse({ type: AttributeResponse })
  async saveValue(@CurrentActor() actor: AuthenticatedActor, @Param('code') code: string, @Body() body: SaveAttributeValueRequest): Promise<ApiResponse<AttributeResponse>> {
    return ApiResponse.ok(await this.attributes.saveValue(actor, code, body), 'Đã lưu giá trị');
  }

  @ApiBearerAuth()
  @Delete('admin/attributes/:code/values/:valueCode')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('catalog.attribute.manage')
  async deleteValue(@CurrentActor() actor: AuthenticatedActor, @Param('code') code: string, @Param('valueCode') valueCode: string): Promise<ApiResponse<null>> {
    await this.attributes.deleteValue(actor, code, valueCode);
    return ApiResponse.ok(null, 'Đã xoá giá trị');
  }
}
