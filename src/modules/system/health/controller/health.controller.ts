import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiResponse } from '@common/response/api-response';
import { Public } from '@common/security/decorators';
import { HealthResponse } from '../dto/health.response';
import { HealthService } from '../service/health.service';

@ApiTags('system')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /* Healthcheck công khai cho compose/LB; body theo envelope chuẩn. */
  @Public()
  @Get()
  @ApiOperation({ summary: 'Sức khoẻ hệ thống (DB, Redis)' })
  @ApiOkResponse({ type: HealthResponse })
  async check(): Promise<ApiResponse<HealthResponse>> {
    return ApiResponse.ok(await this.health.check());
  }
}
