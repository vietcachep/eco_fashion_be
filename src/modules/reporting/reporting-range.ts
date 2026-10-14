import { BusinessException } from '@common/exception/business.exception';

/* Mã lỗi 400 chung cho khoảng ngày báo cáo (sàn + shop). */
export const REPORTING_INVALID_RANGE = 'REPORTING_INVALID_RANGE';

/* Trần khoảng báo cáo: `periods()` lặp từng ngày và truy vấn gộp theo ngày, nên khoảng vô hạn (0001-01-01 → 9999-12-31)
 * sinh hàng triệu bucket ⇒ treo tiến trình (DoS). 400 ngày phủ trọn 1 năm + biên; 60 tháng = 5 năm theo tháng. */
export const MAX_REPORT_DAYS = 400;
export const MAX_REPORT_MONTHS = 60;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/* Ngày thật trên lịch: regex đúng dạng + khứ hồi qua Date không bị "tràn" (2026-02-30 hay 2026-13-45 đều trượt;
 * Date.parse của V8 lại dễ dãi với ngày 30/31 của tháng ngắn nên không dựa vào NaN). */
export function isRealDay(day: string): boolean {
  if (!DAY_RE.test(day)) return false;
  const d = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
}

/*
 * Kiểm khoảng [from, to] cho báo cáo theo kỳ: ngày thật, from ≤ to, tối đa 400 ngày (day) / 60 tháng (month).
 * Vi phạm ⇒ BusinessException 400 REPORTING_INVALID_RANGE (không để rơi thành 500).
 */
export function assertReportRange(from: string, to: string, granularity: 'day' | 'month' = 'day'): void {
  if (!isRealDay(from)) throw new BusinessException(REPORTING_INVALID_RANGE, `Ngày bắt đầu không hợp lệ: ${from} (yyyy-mm-dd)`);
  if (!isRealDay(to)) throw new BusinessException(REPORTING_INVALID_RANGE, `Ngày kết thúc không hợp lệ: ${to} (yyyy-mm-dd)`);
  if (from > to) throw new BusinessException(REPORTING_INVALID_RANGE, 'Ngày bắt đầu phải trước hoặc bằng ngày kết thúc');

  if (granularity === 'month') {
    const months = (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + (Number(to.slice(5, 7)) - Number(from.slice(5, 7))) + 1;
    if (months > MAX_REPORT_MONTHS) throw new BusinessException(REPORTING_INVALID_RANGE, `Báo cáo theo tháng tối đa ${MAX_REPORT_MONTHS} tháng`);
    return;
  }
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
  if (days > MAX_REPORT_DAYS) throw new BusinessException(REPORTING_INVALID_RANGE, `Báo cáo theo ngày tối đa ${MAX_REPORT_DAYS} ngày`);
}
