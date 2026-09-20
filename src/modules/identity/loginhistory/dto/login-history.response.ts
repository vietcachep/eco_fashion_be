import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class LoginHistoryResponse {
  @ApiProperty() id: string;
  @ApiPropertyOptional({ nullable: true }) userId: string | null;
  @ApiProperty() email: string;
  @ApiProperty() success: boolean;
  @ApiPropertyOptional({ nullable: true, example: 'INVALID_CREDENTIALS' }) reason: string | null;
  @ApiPropertyOptional({ nullable: true }) ipAddress: string | null;
  @ApiPropertyOptional({ nullable: true }) userAgent: string | null;
  @ApiProperty() createdAt: string;
}
