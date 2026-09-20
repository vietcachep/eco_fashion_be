import { Module } from '@nestjs/common';
import { AdminReportingController } from './reporting.controllers';
import { ReportingQueryApi } from './queryapi/reporting.queryapi';
import { ReportingService } from './reporting.service';

/* Module reporting (PLAN-0011) — chỉ đọc; số liệu ngày do ReportingWorkerModule tính. */
@Module({
  controllers: [AdminReportingController],
  providers: [ReportingService, ReportingQueryApi],
  exports: [ReportingService, ReportingQueryApi],
})
export class ReportingModule {}
