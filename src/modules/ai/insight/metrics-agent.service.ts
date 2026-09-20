import { Injectable } from '@nestjs/common';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { ReportingQueryApi } from '../../reporting/queryapi/reporting.queryapi';
import { argStr } from '../foundation/arg';
import { AI_FEATURE } from '../foundation/ai.constants';
import { ChatToolSpec, OpenAiProvider } from '../provider/openai.provider';
import { SignalService } from '../signal/signal.service';
import { AiUsageService } from '../usage/ai-usage.service';
import { ChatInsightsService } from './chat-insights.service';

function tool(name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []): ChatToolSpec {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } };
}

const TOOLS: ChatToolSpec[] = [
  tool('get_dashboard', 'Tổng quan hôm nay / tháng này / 7 ngày gần nhất: đơn, doanh thu, khách mới, hoàn tiền, việc đang chờ (xác nhận, đóng gói, giao, đổi trả, chuyển khoản chờ đối soát, hỗ trợ), trạng thái đơn, phương thức thanh toán, top 5 sản phẩm.'),
  tool('get_revenue', 'Doanh thu theo ngày hoặc tháng trong một kỳ.', { range: { type: 'string', enum: ['7d', '30d', '90d', 'this_month', 'last_month'] }, granularity: { type: 'string', enum: ['day', 'month'] } }, ['range']),
  tool('get_top_products', 'Sản phẩm bán chạy trong kỳ (số lượng, doanh thu, số đơn).', { range: { type: 'string', enum: ['7d', '30d', '90d'] }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, ['range']),
  tool('get_low_stock', 'Biến thể sắp hết (khả dụng ≤ ngưỡng).', { threshold: { type: 'integer', minimum: 0, maximum: 100 } }),
  tool('get_ai_usage', 'Chi phí AI: token, lượt gọi, lỗi theo tính năng và theo ngày; hôm nay vs ngân sách.', { days: { type: 'integer', minimum: 1, maximum: 90 } }),
  tool('get_recommendation_stats', 'Hiệu quả dải gợi ý theo nguồn: hiển thị, click, CTR, thêm giỏ, mua, chuyển đổi.', { days: { type: 'integer', minimum: 1, maximum: 90 } }),
  tool('get_chat_insights', 'Chatbot: số phiên, câu hỏi, lượt thiếu dữ liệu, chuyển người thật, cụm câu hỏi bot bí.', { days: { type: 'integer', minimum: 1, maximum: 90 } }),
];

/*
 * HỎI SỐ LIỆU BẰNG NGÔN NGỮ TỰ NHIÊN cho nhân viên quản lý: "tuần này bán chạy gì?", "còn bao nhiêu đơn chờ xác nhận?" → agent
 * gọi TOOL BÁO CÁO CÓ SẴN (ReportingQueryApi/usage/stats — đã có test) rồi diễn giải. ★ KHÔNG SINH SQL: không câu lệnh nào do
 * model viết chạm vào DB. Tối đa 4 vòng tool, không stream (câu trả lời ngắn).
 */
@Injectable()
export class MetricsAgentService {
  constructor(
    private readonly openai: OpenAiProvider,
    private readonly reports: ReportingQueryApi,
    private readonly usage: AiUsageService,
    private readonly signals: SignalService,
    private readonly chatInsights: ChatInsightsService,
  ) {}

  get available(): boolean {
    return this.openai.isConfigured;
  }

  private range(r: string): { from: string; to: string } {
    const today = this.reports.vnDay(new Date());
    const day = (d: number) => this.reports.vnDay(new Date(Date.now() - d * 86_400_000));
    if (r === 'this_month') return { from: `${today.slice(0, 7)}-01`, to: today };
    if (r === 'last_month') {
      const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() - 1);
      const from = d.toISOString().slice(0, 10);
      const end = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
      end.setUTCDate(0);
      return { from, to: end.toISOString().slice(0, 10) };
    }
    const n = r === '7d' ? 7 : r === '90d' ? 90 : 30;
    return { from: day(n - 1), to: today };
  }

  async ask(actor: AuthenticatedActor, question: string): Promise<{ answer: string; tools: string[]; source: string }> {
    if (!this.openai.isConfigured) {
      const d = await this.reports.dashboard();
      return { answer: `AI chưa bật. Số nhanh hôm nay: ${d.today.orderCount} đơn, doanh thu ${d.today.revenue.display}; tháng này ${d.month.orderCount} đơn, ${d.month.revenue.display}; đang chờ xác nhận ${d.pending.awaitingConfirm}, đang giao ${d.pending.shipping}, sắp hết hàng ${d.pending.lowStock}.`, tools: ['get_dashboard'], source: 'rule' };
    }
    const execute = async (call: { name: string; args: Record<string, unknown> }): Promise<string> => {
      const a = call.args;
      switch (call.name) {
        case 'get_dashboard':
          return JSON.stringify(await this.reports.dashboard());
        case 'get_revenue': {
          const { from, to } = this.range((argStr(a.range) || '30d'));
          return JSON.stringify(await this.reports.revenue(from, to, a.granularity === 'month' ? 'month' : 'day'));
        }
        case 'get_top_products': {
          const { from, to } = this.range((argStr(a.range) || '30d'));
          return JSON.stringify(await this.reports.topProducts(from, to, Number(a.limit ?? 10)));
        }
        case 'get_low_stock':
          return JSON.stringify(await this.reports.lowStock(Number(a.threshold ?? 5), 30));
        case 'get_ai_usage':
          return JSON.stringify(await this.usage.summary(Number(a.days ?? 14)));
        case 'get_recommendation_stats':
          return JSON.stringify(await this.signals.stats(Number(a.days ?? 30)));
        case 'get_chat_insights':
          return JSON.stringify(await this.chatInsights.insights(Number(a.days ?? 14)));
        default:
          return JSON.stringify({ error: 'tool không tồn tại' });
      }
    };
    const res = await this.openai.runAgent(
      [
        { role: 'system', content: `Bạn là trợ lý vận hành cho NHÂN VIÊN QUẢN LÝ cửa hàng quần áo. Trả lời câu hỏi số liệu BẰNG CÁCH GỌI TOOL rồi diễn giải — không bịa số, không đoán khi tool không có dữ liệu (nói "chưa có số liệu"). Hôm nay ${new Date().toLocaleDateString('vi-VN')}. Tiếng Việt, ngắn gọn (3-8 câu hoặc gạch đầu dòng), nêu con số cụ thể kèm kỳ tính; tiền dạng 1.234.000 ₫ (dùng đúng trường display). Có thể gọi nhiều tool một lượt. Không nhắc tên tool. VĂN BẢN THUẦN, không Markdown.` },
        { role: 'user', content: question.slice(0, 1000) },
      ],
      TOOLS,
      execute,
      { feature: AI_FEATURE.METRICS_AGENT, userId: actor.userId, maxRounds: 4, maxTokens: 600, temperature: 0.2 },
    );
    return { answer: res.text || 'Mình chưa lấy được số liệu cho câu hỏi này.', tools: res.toolsUsed, source: 'llm' };
  }
}
