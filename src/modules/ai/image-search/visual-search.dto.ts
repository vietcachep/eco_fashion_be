import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
export class VisualSearchRequest {
  @ApiPropertyOptional({ description: 'Tên món/vùng khách đã chọn', maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  target?: string;
}
export class VisualRegionResponse {
  @ApiProperty() id: string;
  @ApiProperty() label: string;
  @ApiProperty({ minimum: 0, maximum: 1 }) x: number;
  @ApiProperty({ minimum: 0, maximum: 1 }) y: number;
  @ApiProperty({ minimum: 0, maximum: 1 }) width: number;
  @ApiProperty({ minimum: 0, maximum: 1 }) height: number;
}
export class VisualAnalyzeResponse {
  @ApiProperty() available: boolean;
  @ApiProperty({ type: [VisualRegionResponse] }) regions: VisualRegionResponse[];
  @ApiPropertyOptional({ type: String, nullable: true }) message: string | null;
}
export class VisualMatchResponse {
  @ApiProperty() productId: string;
  @ApiProperty() imageUrl: string;
  @ApiPropertyOptional({ type: String, nullable: true }) colorCode: string | null;
  @ApiProperty({ enum: ['similar', 'related'] }) relevance: 'similar' | 'related';
  @ApiProperty() reason: string;
}
