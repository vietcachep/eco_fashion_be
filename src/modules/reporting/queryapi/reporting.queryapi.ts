import { Injectable } from '@nestjs/common';
import { DashboardResponse, LowStockRow, ReportingService, RevenueResponse, TopProductRow } from '../reporting.service';

export type { DashboardResponse, LowStockRow, RevenueResponse, TopProductRow } from '../reporting.service';

/* QueryAPI của reporting — ai (agent hỏi số liệu, nhận xét doanh thu/tồn kho) đọc báo cáo ĐÃ CÓ, không sinh SQL. */
@Injectable()
export class ReportingQueryApi {
  constructor(private readonly reports: ReportingService) {}

  dashboard(): Promise<DashboardResponse> {
    return this.reports.dashboard();
  }

  revenue(from: string, to: string, granularity: 'day' | 'month' = 'day'): Promise<RevenueResponse> {
    return this.reports.revenue(from, to, granularity);
  }

  topProducts(from: string, to: string, limit = 10): Promise<TopProductRow[]> {
    return this.reports.topProducts(from, to, limit);
  }

  lowStock(threshold = 5, limit = 50): Promise<LowStockRow[]> {
    return this.reports.lowStock(threshold, limit);
  }

  vnDay(d: Date): string {
    return ReportingService.vnDay(d);
  }
}
