import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor } from '@common/security/decorators';
import { AddressResponse } from '../dto/address.response';
import { CreateAddressRequest, UpdateAddressRequest } from '../request/address.requests';
import { AddressService } from '../service/address.service';

/* /users/me/addresses — sổ địa chỉ của CHÍNH người đăng nhập. */
@ApiTags('users')
@ApiBearerAuth()
@Controller('users/me/addresses')
export class AddressController {
  constructor(private readonly addresses: AddressService) {}

  @Get()
  @ApiOperation({ summary: 'Sổ địa chỉ của tôi (mặc định lên đầu)' })
  @ApiOkResponse({ type: [AddressResponse] })
  async list(@CurrentActor() actor: AuthenticatedActor): Promise<ApiResponse<AddressResponse[]>> {
    return ApiResponse.ok(await this.addresses.list(actor));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Chi tiết một địa chỉ' })
  @ApiOkResponse({ type: AddressResponse })
  async get(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<AddressResponse>> {
    return ApiResponse.ok(await this.addresses.get(actor, id));
  }

  @Post()
  @ApiOperation({ summary: 'Thêm địa chỉ (tối đa 10; địa chỉ đầu tiên tự làm mặc định)' })
  @ApiOkResponse({ type: AddressResponse })
  async create(@CurrentActor() actor: AuthenticatedActor, @Body() body: CreateAddressRequest): Promise<ApiResponse<AddressResponse>> {
    const r = await this.addresses.create(
      actor,
      {
        recipientName: body.recipientName.trim(),
        phone: body.phone,
        provinceCode: body.provinceCode ?? null,
        provinceName: body.provinceName,
        districtName: body.districtName ?? null,
        wardName: body.wardName ?? null,
        street: body.street.trim(),
        note: body.note ?? null,
      },
      body.isDefault === true,
    );
    return ApiResponse.ok(r, 'Đã thêm địa chỉ');
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Sửa địa chỉ' })
  @ApiOkResponse({ type: AddressResponse })
  async update(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateAddressRequest): Promise<ApiResponse<AddressResponse>> {
    return ApiResponse.ok(await this.addresses.update(actor, id, { ...body, recipientName: body.recipientName?.trim(), street: body.street?.trim() }), 'Đã cập nhật địa chỉ');
  }

  @Put(':id/default')
  @ApiOperation({ summary: 'Đặt làm địa chỉ mặc định' })
  @ApiOkResponse({ type: AddressResponse })
  async setDefault(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<AddressResponse>> {
    return ApiResponse.ok(await this.addresses.setDefault(actor, id), 'Đã đặt địa chỉ mặc định');
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Xoá địa chỉ (xoá mềm)' })
  async remove(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<null>> {
    await this.addresses.remove(actor, id);
    return ApiResponse.ok(null, 'Đã xoá địa chỉ');
  }
}
