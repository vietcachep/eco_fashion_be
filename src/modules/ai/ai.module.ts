import { Module } from '@nestjs/common';
import { CartModule } from '../cart/cart.module';
import { CatalogModule } from '../catalog/catalog.module';
import { PaymentModule } from '../payment/payment.module';
import { ProductModule } from '../product/product.module';
import { PromotionModule } from '../promotion/promotion.module';
import { ReportingModule } from '../reporting/reporting.module';
import { ReviewModule } from '../review/review.module';
import { SystemModule } from '../system/system.module';
import { AdminAiController, AiController } from './ai.controllers';
import { ChatActionService } from './chat/chat-action.service';
import { ChatService } from './chat/chat.service';
import { EmbeddingService } from './embedding/embedding.service';
import { ProductFaqService } from './faq/product-faq.service';
import { ImageSearchService } from './image-search/image-search.service';
import { AiInsightService } from './insight/ai-insight.service';
import { ChatInsightsService } from './insight/chat-insights.service';
import { MetricsAgentService } from './insight/metrics-agent.service';
import { StaffInsightService } from './insight/staff-insight.service';
import { KnowledgeService } from './knowledge/knowledge.service';
import { RecommendationService } from './recommendation/recommendation.service';
import { SignalService } from './signal/signal.service';
import { OpenAiProvider } from './provider/openai.provider';
import { ReplicateProvider } from './provider/replicate.provider';
import { ReviewAiService } from './review-ai/review-ai.service';
import { StyleAnalysisService } from './style/style-analysis.service';
import { TryOnService } from './tryon/try-on.service';
import { AiUsageService } from './usage/ai-usage.service';

/*
 * Module ai (PLAN-0012 chatbot agent/RAG/gợi ý/so sánh/FAQ/tín hiệu/công cụ nhân viên, PLAN-0013 thử đồ 2D + phân tích ảnh).
 * OrderModule @Global (OrderQueryApi, ORDER_ACTIONS_GATEWAY); IdentityModule cung USER_DIRECTORY_GATEWAY toàn cục.
 * Provider OpenAI/Replicate là chỗ DUY NHẤT dùng key; không key = đường lùi rule.
 */
@Module({
  imports: [ProductModule, CatalogModule, ReviewModule, SystemModule, CartModule, PromotionModule, PaymentModule, ReportingModule],
  controllers: [AiController, AdminAiController],
  providers: [AiUsageService, OpenAiProvider, ReplicateProvider, EmbeddingService, KnowledgeService, ChatActionService, ChatService, StyleAnalysisService, TryOnService, ImageSearchService, ReviewAiService, AiInsightService, RecommendationService, SignalService, ProductFaqService, ChatInsightsService, MetricsAgentService, StaffInsightService],
  exports: [EmbeddingService, KnowledgeService, TryOnService, ImageSearchService, ReviewAiService, AiInsightService, ProductFaqService],
})
export class AiModule {}
