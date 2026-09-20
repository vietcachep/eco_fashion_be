import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AuditLogResponse {
  @ApiProperty() id: string;
  @ApiPropertyOptional({ nullable: true }) actorUserId: string | null;
  @ApiPropertyOptional({ nullable: true }) actorEmail: string | null;
  @ApiProperty({ example: 'USER_LOCKED' }) action: string;
  @ApiProperty({ example: 'identity' }) moduleCode: string;
  @ApiProperty({ example: 'user' }) entityType: string;
  @ApiPropertyOptional({ nullable: true }) entityId: string | null;
  @ApiPropertyOptional({ nullable: true }) entityCode: string | null;
  @ApiPropertyOptional({ nullable: true }) requestId: string | null;
  @ApiPropertyOptional({ nullable: true, type: 'object', additionalProperties: true }) before: unknown;
  @ApiPropertyOptional({ nullable: true, type: 'object', additionalProperties: true }) after: unknown;
  @ApiPropertyOptional({ nullable: true }) ipAddress: string | null;
  @ApiProperty() createdAt: string;
}
