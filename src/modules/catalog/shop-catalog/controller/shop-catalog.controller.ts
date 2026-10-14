import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ApiResponse } from '@common/response/api-response';
import { RequireShopPermission } from '@modules/shop/security/shop-permission.decorator';
import { ShopContextGuard } from '@modules/shop/security/shop-context.guard';
import { ShopCategoryTemplateResponse, ShopLeafCategoryResponse } from '../dto/shop-catalog.responses';
import { ShopCatalogService } from '../service/shop-catalog.service';

/*
 * /shop/catalog — vendor ĐỌC ngành hàng + mẫu thuộc tính để dựng form sản phẩm (PLAN-0016 §6). shopId do ShopContextGuard suy từ
 * JWT; dữ liệu catalog là dùng chung (không thuộc riêng shop nào) nên chỉ cần quyền shop.product.read, không có route ghi.
 */
@ApiTags('shops')
@ApiBearerAuth()
@Controller('shop/catalog')
@UseGuards(ShopContextGuard)
export class ShopCatalogController {
  constructor(private readonly catalog: ShopCatalogService) {}

  @Get('categories/leaves')
  @RequireShopPermission('shop.product.read')
  @ApiOperation({ summary: 'Ngành hàng LÁ đang bật (kèm ngành cha) để chọn khi tạo sản phẩm' })
  @ApiOkResponse({ type: [ShopLeafCategoryResponse] })
  async leaves(): Promise<ApiResponse<ShopLeafCategoryResponse[]>> {
    return ApiResponse.ok(await this.catalog.listLeaves());
  }

  @Get('categories/:slug/attribute-template')
  @RequireShopPermission('shop.product.read')
  @ApiOperation({ summary: 'Mẫu thuộc tính của ngành (thuộc tính sản phẩm + trục biến thể + giá trị chọn) để dựng form' })
  @ApiParam({ name: 'slug', example: 'dien-thoai' })
  @ApiOkResponse({ type: ShopCategoryTemplateResponse })
  async attributeTemplate(@Param('slug') slug: string): Promise<ApiResponse<ShopCategoryTemplateResponse>> {
    return ApiResponse.ok(await this.catalog.getTemplateBySlug(slug));
  }
}
