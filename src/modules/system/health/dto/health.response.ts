import { ApiProperty } from '@nestjs/swagger';

export class HealthResponse {
  @ApiProperty({ example: 'UP' })
  status: 'UP' | 'DEGRADED';

  @ApiProperty({ example: 'UP' })
  database: 'UP' | 'DOWN';

  @ApiProperty({ example: 'UP' })
  redis: 'UP' | 'DOWN';

  @ApiProperty({ example: '0.1.0' })
  version: string;

  @ApiProperty()
  timestamp: string;
}
