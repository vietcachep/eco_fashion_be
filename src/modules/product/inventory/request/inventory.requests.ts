import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
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
  @ApiProperty({ example: 50, minimum: 1, maximum: 100000, description: 'Số lượng nhập — số nguyên 1–100.000' }) @Type(() => Number) @IsInt() @Min(1) @Max(100000) quantity: number;
  /* Chuỗi số nguyên đồng KHÔNG dấu: IsNumberString cũ nhận "-5", "+5", ".5" và số quá lớn → tràn numeric(14,0) thành 500. 12 chữ số × số lượng vẫn có thể vượt trần — service chặn tiếp ở tổng phiếu. */
  @ApiPropertyOptional({ example: '80000', description: 'Giá vốn VND — số nguyên không âm, tối đa 12 chữ số' }) @IsOptional() @IsString() @Matches(/^[0-9]{1,12}$/,{ message: 'unitCost phải là số nguyên đồng không âm, tối đa 12 chữ số' }) unitCost?: string;
}

export class CreateReceiptRequest {
  @ApiPropertyOptional({ example: 'Xưởng may Minh Anh' }) @IsOptional() @IsString() @MaxLength(200) supplierName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
  @ApiProperty({ type: [ReceiptItemInput] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => ReceiptItemInput) items: ReceiptItemInput[];
}

export class AdjustStockRequest {
  @ApiProperty() @IsUUID() variantId: string;
  @ApiProperty({ example: -2, minimum: -100000, maximum: 100000, description: 'Số lượng cộng/trừ (kiểm kê, hư hỏng) — số nguyên khác 0, |delta| ≤ 100.000' }) @Type(() => Number) @IsInt() @Min(-100000) @Max(100000) delta: number;
  @ApiProperty({ example: 'Kiểm kê cuối tháng — thiếu 2', description: 'Lý do điều chỉnh (3–255 ký tự) — ghi vào sổ kho + audit' }) @IsString() @MinLength(3) @MaxLength(255) reason: string;
}
