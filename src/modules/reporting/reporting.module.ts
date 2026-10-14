import { Module } from '@nestjs/common';
import { ShopModule } from '@modules/shop/shop.module';
import { AdminReportingController } from './reporting.controllers';
import { ReportingQueryApi } from './queryapi/reporting.queryapi';
import { ReportingService } from './reporting.service';
import { ShopReportingController } from './shop-reporting.controller';
import { ShopReportingService } from './shop-reporting.service';

/* Module reporting (PLAN-0011) — chỉ đọc; số liệu ngày do ReportingWorkerModule tính.
 * (PLAN-0017 B4) + ShopReportingService/Controller — vendor xem báo cáo gian hàng của mình.
 */
@Module({
  imports: [ShopModule],
  controllers: [AdminReportingController, ShopReportingController],
  providers: [ReportingService, ReportingQueryApi, ShopReportingService],
  exports: [ReportingService, ReportingQueryApi, ShopReportingService],
})
export class ReportingModule {}
