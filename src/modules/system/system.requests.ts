import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsNumberString, IsOptional, IsString, IsUUID, Length, Matches, MaxLength, Min } from 'class-validator';
import { PageQuery } from '@common/utils/pagination';
import { NormalizeEmail, ToBoolean } from '@common/utils/transform';

/* Request DTO của module system — gom một file vì mỗi feature chỉ 1–2 DTO nhỏ. */

export class UpdateSettingRequest {
  @ApiProperty({ description: 'Giá trị JSON đúng kiểu với mặc định (số/chuỗi/boolean)' }) value: unknown;
}

export class UpdateProvinceRequest {
  @ApiPropertyOptional({ example: '30000' }) @IsOptional() @IsNumberString() shippingFee?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class BannerFormRequest {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(2, 200) title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) subtitle?: string;
  @ApiPropertyOptional({ example: '/products?category=dam' }) @IsOptional() @IsString() @MaxLength(500) linkUrl?: string;
  @ApiPropertyOptional({ enum: ['hero', 'promo'] }) @IsOptional() @IsIn(['hero', 'promo']) position?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) sortOrder?: number;
  @ApiPropertyOptional() @IsOptional() @ToBoolean() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() startsAt?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() endsAt?: string | null;
}

export class NotificationListQuery extends PageQuery {
  @ApiPropertyOptional() @IsOptional() @ToBoolean() @IsBoolean() unreadOnly?: boolean;
}

export class BroadcastNotificationRequest {
  @ApiProperty({ type: [String] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(1000) @IsUUID('4', { each: true }) userIds: string[];
  @ApiProperty() @IsString() @Length(2, 200) title: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) content?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) link?: string;
}

export class ContactRequest {
  @ApiProperty({ example: 'Nguyễn Văn An' }) @IsString() @Length(2, 120) name: string;
  @ApiProperty({ example: 'an@gmail.com' }) @NormalizeEmail() @IsEmail({}, { message: 'Email không hợp lệ' }) email: string;
  @ApiPropertyOptional({ example: '0901234567' }) @IsOptional() @Matches(/^(0|\+84)(\d{9,10})$/, { message: 'Số điện thoại Việt Nam không hợp lệ' }) phone?: string;
  @ApiProperty() @IsString() @Length(10, 2000) message: string;
  @ApiPropertyOptional({ description: 'Gửi cho GIAN HÀNG này (hỏi về sản phẩm / đơn của shop); bỏ trống = gửi SÀN' }) @IsOptional() @IsUUID() shopId?: string;
  @ApiPropertyOptional({ example: 'fitly-official', description: 'Thay cho shopId khi web chỉ biết slug gian hàng (trang sản phẩm / trang shop)' }) @IsOptional() @IsString() @MaxLength(160) shopSlug?: string;
  @ApiPropertyOptional({ example: 'DH2610040013', description: 'Mã đơn đang hỏi (ngữ cảnh cho người trả lời)' }) @IsOptional() @IsString() @MaxLength(30) orderCode?: string;
  @ApiPropertyOptional({ description: 'Tên sản phẩm đang hỏi (ngữ cảnh cho người trả lời)' }) @IsOptional() @IsString() @MaxLength(200) productName?: string;
}

export class ContactListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: ['new', 'handled'] }) @IsOptional() @IsIn(['new', 'handled']) status?: string;
  @ApiPropertyOptional({ enum: ['platform', 'shops'], description: 'platform = tin gửi sàn (mặc định) · shops = tin gửi các gian hàng (sàn chỉ giám sát)' }) @IsOptional() @IsIn(['platform', 'shops']) scope?: string;
  @ApiPropertyOptional({ description: 'Chỉ tin gửi gian hàng này' }) @IsOptional() @IsUUID() shopId?: string;
}

export class ReplyContactRequest {
  @ApiProperty() @IsString() @Length(5, 2000) reply: string;
}

export class SaveFaqRequest {
  @ApiProperty() @IsString() @Length(5, 300) question: string;
  @ApiProperty() @IsString() @Length(5, 5000) answer: string;
  @ApiPropertyOptional({ example: 'shipping' }) @IsOptional() @Matches(/^[a-z0-9-]+$/) @MaxLength(40) groupCode?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) sortOrder?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class SavePageRequest {
  @ApiProperty() @IsString() @Length(2, 200) title: string;
  @ApiProperty({ description: 'Markdown' }) @IsString() @Length(1, 50000) content: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
