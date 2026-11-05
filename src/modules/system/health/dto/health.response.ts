import { ApiProperty } from '@nestjs/swagger';

export class HealthResponse {
  /* UP = DB + Redis + worker đều ổn; DEGRADED = có thành phần DOWN (xem 3 trường dưới). HTTP 503 chỉ khi DB hoặc Redis DOWN (API không phục vụ đúng được). */
  @ApiProperty({ example: 'UP', enum: ['UP', 'DEGRADED'] })
  status: 'UP' | 'DEGRADED';

  @ApiProperty({ example: 'UP', enum: ['UP', 'DOWN'] })
  database: 'UP' | 'DOWN';

  @ApiProperty({ example: 'UP', enum: ['UP', 'DOWN'] })
  redis: 'UP' | 'DOWN';

  /* Tiến trình worker (job nền, email, outbox): UP = có nhịp tim mới; DOWN = chưa từng có/quá 60 giây; UNKNOWN = không đọc được Redis. Worker DOWN ⇒ status=DEGRADED nhưng vẫn HTTP 200 (API vẫn phục vụ khách) — theo dõi worker bằng GET /health/worker. */
  @ApiProperty({ example: 'UP', enum: ['UP', 'DOWN', 'UNKNOWN'] })
  worker: 'UP' | 'DOWN' | 'UNKNOWN';

  @ApiProperty({ nullable: true, type: String, description: 'Thời điểm worker ghi nhịp tim gần nhất (ISO-8601); null nếu chưa từng có' })
  workerLastSeenAt: string | null;

  @ApiProperty({ example: '0.1.0' })
  version: string;

  @ApiProperty()
  timestamp: string;
}

/* GET /health/worker — dành cho uptime monitor / healthcheck của container worker. */
export class WorkerHealthResponse {
  @ApiProperty({ example: 'UP', enum: ['UP', 'DOWN', 'UNKNOWN'] })
  status: 'UP' | 'DOWN' | 'UNKNOWN';

  @ApiProperty({ nullable: true, type: String })
  lastSeenAt: string | null;

  @ApiProperty({ example: 60, description: 'Quá số giây này không có nhịp tim thì coi là DOWN' })
  staleAfterSeconds: number;

  @ApiProperty()
  timestamp: string;
}
