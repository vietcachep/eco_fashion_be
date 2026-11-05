import { Controller, Get, HttpStatus, Req, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ApiError, ApiResponse } from '@common/response/api-response';
import { Public } from '@common/security/decorators';
import { HealthResponse, WorkerHealthResponse } from '../dto/health.response';
import { HealthService, isApiServing } from '../service/health.service';

@ApiTags('system')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /*
   * Healthcheck công khai cho compose/LB/uptime monitor; body theo envelope chuẩn.
   * AUD-12a: DB hoặc Redis DOWN ⇒ HTTP 503 (trước đây 200 + body báo lỗi nên LB không thấy). Body vẫn mang `data` đầy đủ để chẩn đoán.
   * Worker DOWN ⇒ vẫn 200 nhưng `status=DEGRADED`, `worker=DOWN` (xem HealthResponse).
   */
  @Public()
  @Get()
  @ApiOperation({ summary: 'Sức khoẻ hệ thống (DB, Redis, worker) — 503 khi DB hoặc Redis DOWN' })
  @ApiOkResponse({ type: HealthResponse })
  @ApiServiceUnavailableResponse({ type: HealthResponse, description: 'DB hoặc Redis DOWN' })
  async check(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<ApiResponse<HealthResponse>> {
    const h = await this.health.check();
    const body = ApiResponse.ok(h);
    if (!isApiServing(h)) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
      body.success = false;
      body.message = 'Hệ thống chưa sẵn sàng';
      body.error = ApiError.of('SYSTEM_UNHEALTHY', req.originalUrl ?? req.url ?? '/api/v1/health', { database: h.database, redis: h.redis });
    }
    return body;
  }

  /*
   * Sức khoẻ riêng của worker (PLAN-0029 §2.4): 503 khi chưa có nhịp tim trong 60 giây (hoặc không đọc được Redis) — dành cho uptime monitor
   * và healthcheck của container worker. Công khai, KHÔNG lộ chi tiết lỗi (chỉ UP/DOWN/UNKNOWN + thời điểm nhịp cuối).
   */
  @Public()
  @Get('worker')
  @ApiOperation({ summary: 'Sức khoẻ worker (nhịp tim job nền) — 503 khi không phải UP' })
  @ApiOkResponse({ type: WorkerHealthResponse })
  @ApiServiceUnavailableResponse({ type: WorkerHealthResponse, description: 'Worker DOWN hoặc không xác minh được' })
  async checkWorker(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<ApiResponse<WorkerHealthResponse>> {
    const w = await this.health.checkWorker();
    const body = ApiResponse.ok(w);
    if (w.status !== 'UP') {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
      body.success = false;
      body.message = 'Worker không phản hồi';
      body.error = ApiError.of('SYSTEM_WORKER_DOWN', req.originalUrl ?? req.url ?? '/api/v1/health/worker', { worker: w.status });
    }
    return body;
  }
}
