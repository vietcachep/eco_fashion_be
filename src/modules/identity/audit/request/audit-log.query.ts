import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PageQuery } from '@common/utils/pagination';

export class ListAuditLogQuery extends PageQuery {
  @ApiPropertyOptional({ example: 'USER_LOCKED' }) @IsOptional() @IsString() @MaxLength(80) action?: string;
  @ApiPropertyOptional({ example: 'user' }) @IsOptional() @IsString() @MaxLength(80) entityType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) entityId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() actorUserId?: string;
}
