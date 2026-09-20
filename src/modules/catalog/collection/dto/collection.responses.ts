import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CollectionQuery {
  @ApiPropertyOptional({ example: 'dam' }) category?: string;
  @ApiPropertyOptional({ example: 'nu' }) gender?: string;
  @ApiPropertyOptional({ example: 'new' }) tag?: string;
}

/* Bộ sưu tập = bộ lọc có sẵn (FE `CollectionResponse`): bấm vào là ra danh sách với `query`. */
export class CollectionResponse {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'hang-moi' }) slug: string;
  @ApiProperty({ example: 'Hàng mới về' }) name: string;
  @ApiPropertyOptional({ nullable: true }) tagline: string | null;
  @ApiPropertyOptional({ nullable: true }) imageUrl: string | null;
  @ApiProperty({ type: CollectionQuery }) query: CollectionQuery;
}

export class CollectionAdminResponse extends CollectionResponse {
  @ApiProperty() sortOrder: number;
  @ApiProperty() isActive: boolean;
  @ApiProperty() createdAt: string;
  @ApiProperty() updatedAt: string;
}
