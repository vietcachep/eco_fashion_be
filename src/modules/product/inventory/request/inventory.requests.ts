import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsNumberString, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { PageQuery } from '@common/utils/pagination';
import { ToBoolean } from '@common/utils/transform';
import { RECEIPT_STATUS } from '../../foundation/product.constants';

export class StockListQuery extends PageQuery {
  @ApiPropertyOptional({ description: 'Tìm theo tên sản phẩm / SKU' }) @IsOptional() @IsString() @MaxLength(100) q?: string;
  @ApiPropertyOptional({ description: 'true = chỉ hàng sắp hết' }) @IsOptional() @ToBoolean() @IsBoolean() lowStockOnly?: boolean;
}

export class ReceiptListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: Object.values(RECEIPT_STATUS) }) @IsOptional() @IsIn(Object.values(RECEIPT_STATUS)) status?: string;
}

export class ReceiptItemInput {
  @ApiProperty() @IsUUID() variantId: string;
  @ApiProperty({ example: 50 }) @Type(() => Number) @IsInt() @Min(1) @Max(100000) quantity: number;
  @ApiPropertyOptional({ example: '80000', description: 'Giá vốn VND' }) @IsOptional() @IsNumberString() unitCost?: string;
}

export class CreateReceiptRequest {
  @ApiPropertyOptional({ example: 'Xưởng may Minh Anh' }) @IsOptional() @IsString() @MaxLength(200) supplierName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
  @ApiProperty({ type: [ReceiptItemInput] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => ReceiptItemInput) items: ReceiptItemInput[];
}

export class AdjustStockRequest {
  @ApiProperty() @IsUUID() variantId: string;
  @ApiProperty({ example: -2, description: 'Số lượng cộng/trừ (kiểm kê, hư hỏng)' }) @Type(() => Number) @IsInt() @Min(-100000) @Max(100000) delta: number;
  @ApiProperty({ example: 'Kiểm kê cuối tháng — thiếu 2' }) @IsString() @MaxLength(255) reason: string;
}
