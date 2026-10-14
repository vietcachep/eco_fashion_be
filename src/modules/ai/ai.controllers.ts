import { Body, Controller, Delete, Get, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BusinessException } from '@common/exception/business.exception';
import { ApiResponse, PageResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor, OptionalAuth, Public, RequirePermission } from '@common/security/decorators';
import { RateLimit } from '@common/security/rate-limit.guard';
import { PageQuery } from '@common/utils/pagination';
import { ProductCardResponse } from '../product/queryapi/product.queryapi';
import { ChatActionResult } from './chat/chat-action.service';
import { ChatReply, ChatService } from './chat/chat.service';
import { EmbeddingService } from './embedding/embedding.service';
import { ProductFaqResponse, ProductFaqService } from './faq/product-faq.service';
import { AiInsightService, SupportRequestResponse } from './insight/ai-insight.service';
import { ChatInsightsResponse, ChatInsightsService } from './insight/chat-insights.service';
import { MetricsAgentService } from './insight/metrics-agent.service';
import { ClassifyProductResponse, ComboSuggestionsResponse, InventoryInsightsResponse, PrecheckResponse, RevenueInsightResponse, StaffInsightService } from './insight/staff-insight.service';
import { ImageSearchResponse, ImageSearchService } from './image-search/image-search.service';
import { AiDocumentResponse, KnowledgeService } from './knowledge/knowledge.service';
import { OpenAiProvider } from './provider/openai.provider';
import { CollectionsResponse, CompareResponse, RecommendationResponse, RecommendationService } from './recommendation/recommendation.service';
import { ReviewAiService, ReviewSummaryResponse } from './review-ai/review-ai.service';
import { RecommendationStatsResponse, SignalService } from './signal/signal.service';
import { StyleAnalysisResponse, StyleAnalysisService } from './style/style-analysis.service';
import { TryOnJobResponse, TryOnService } from './tryon/try-on.service';
import { AiUsageService } from './usage/ai-usage.service';
import { AskRequest, ChatRequestV2, ClassifyRequest, CompareRequest, CopyRequest, DaysQuery, DocumentListQuery, FlagListQuery, LimitQuery, RecommendQuery, SaveDocumentRequest, SignalBatchRequest, SignalEventRequest, StyleAnalysisBody, SupportListQuery, SupportRequestBody, TryOnBody, UpdateDocumentRequest, UpdateSupportRequest, UsageQuery, ViewEventRequest } from './ai.requests';

const GUEST_HEADER = { name: 'X-Guest-Key', description: 'Khách vãng lai: khoá 8–64 ký tự FE tự sinh và lưu localStorage; bỏ trống lần đầu → BE cấp trong response', required: false };
const IMAGE_LIMIT = { limits: { fileSize: 5 * 1024 * 1024 } };
const GUEST_RE = /^[A-Za-z0-9_-]{8,64}$/;
const softGuest = (h: string | undefined): string | null => (h && GUEST_RE.test(h) ? h : null);

/*
 * /ai — chatbot agent (tool + hành động xác nhận), thử đồ 2D, phân tích phong cách, gợi ý (cá nhân / tương tự / mua cùng /
 * giỏ / bộ sưu tập), so sánh, FAQ sản phẩm, tín hiệu, tóm tắt đánh giá (docs/06 mục ai). Dùng được khi chưa đăng nhập
 * (@OptionalAuth + X-Guest-Key). Endpoint gọi AI có rate limit riêng vì tốn tiền.
 */
@ApiTags('ai')
@Controller('ai')
export class AiController {
  constructor(
    private readonly chat: ChatService,
    private readonly style: StyleAnalysisService,
    private readonly tryOn: TryOnService,
    private readonly imageSearch: ImageSearchService,
    private readonly insight: AiInsightService,
    private readonly recommendation: RecommendationService,
    private readonly faq: ProductFaqService,
    private readonly signals: SignalService,
    private readonly reviewAi: ReviewAiService,
    private readonly openai: OpenAiProvider,
  ) {}

  @Public() @Get('status') @ApiOperation({ summary: 'Tính năng AI nào đang bật (FE ẩn/hiện nút)' })
  status(): ApiResponse<{ chat: boolean; chatLlm: boolean; chatActions: boolean; styleAnalysis: boolean; styleAnalysisLlm: boolean; tryOn: boolean; imageSearch: boolean; compare: boolean; collections: boolean; productFaq: boolean }> {
    const llm = this.openai.isConfigured;
    return ApiResponse.ok({ chat: true, chatLlm: llm, chatActions: llm, styleAnalysis: true, styleAnalysisLlm: llm, tryOn: this.tryOn.isAvailable, imageSearch: llm, compare: llm, collections: true, productFaq: llm });
  }

  // ------------------------------------------------------------ chatbot

  @OptionalAuth() @Post('chat') @HttpCode(HttpStatus.OK) @ApiBearerAuth() @ApiHeader(GUEST_HEADER)
  @RateLimit({ name: 'ai-chat', limit: 30, windowSeconds: 600, by: 'auto' })
  @ApiOperation({ summary: 'Gửi tin cho trợ lý — trả lời + thẻ sản phẩm + đề xuất hành động (Xác nhận) + gợi ý câu hỏi tiếp' })
  async send(@CurrentActor() actor: AuthenticatedActor | undefined, @Headers('x-guest-key') guestHeader: string | undefined, @Body() body: ChatRequestV2): Promise<ApiResponse<ChatReply>> {
    const guestKey = ChatService.resolveGuestKey(guestHeader, actor);
    return ApiResponse.ok(await this.chat.chat({ actor, guestKey }, { sessionId: body.sessionId, message: body.message, contextProductSlug: body.contextProductSlug ?? null }));
  }

  @OptionalAuth() @Get('chat/sessions') @ApiBearerAuth() @ApiHeader(GUEST_HEADER)
  async sessions(@CurrentActor() actor: AuthenticatedActor | undefined, @Headers('x-guest-key') guestHeader: string | undefined) {
    return ApiResponse.ok(await this.chat.mySessions({ actor, guestKey: ChatService.resolveGuestKey(guestHeader, actor) }));
  }

  @OptionalAuth() @Get('chat/sessions/:id') @ApiBearerAuth() @ApiHeader(GUEST_HEADER)
  async history(@CurrentActor() actor: AuthenticatedActor | undefined, @Headers('x-guest-key') guestHeader: string | undefined, @Param('id', ParseUUIDPipe) id: string) {
    return ApiResponse.ok(await this.chat.history({ actor, guestKey: ChatService.resolveGuestKey(guestHeader, actor) }, id));
  }

  @ApiBearerAuth() @Post('chat/sessions/:id/actions/:actionId/confirm') @HttpCode(HttpStatus.OK) @ApiOperation({ summary: 'Khách XÁC NHẬN đề xuất của trợ lý (thêm giỏ / huỷ đơn) — lúc này mới ghi' })
  async confirmAction(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @Param('actionId', ParseUUIDPipe) actionId: string): Promise<ApiResponse<ChatActionResult>> {
    const r = await this.chat.confirmAction(actor, id, actionId);
    return ApiResponse.ok(r, r.kind === 'add_to_cart' ? 'Đã thêm vào giỏ' : 'Đã huỷ đơn');
  }

  @ApiBearerAuth() @Post('chat/sessions/:id/actions/:actionId/reject') @HttpCode(HttpStatus.OK) @ApiOperation({ summary: 'Khách bỏ qua đề xuất' })
  async rejectAction(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @Param('actionId', ParseUUIDPipe) actionId: string): Promise<ApiResponse<null>> {
    await this.chat.rejectAction(actor, id, actionId);
    return ApiResponse.ok(null, 'Đã bỏ qua đề xuất');
  }

  @OptionalAuth() @Post('support') @ApiBearerAuth() @ApiHeader(GUEST_HEADER)
  @RateLimit({ name: 'ai-support', limit: 5, windowSeconds: 3600, by: 'auto' })
  @ApiOperation({ summary: 'Yêu cầu gặp nhân viên (ngoài luồng chat)' })
  async support(@CurrentActor() actor: AuthenticatedActor | undefined, @Headers('x-guest-key') guestHeader: string | undefined, @Body() body: SupportRequestBody): Promise<ApiResponse<{ supportRequestId: string }>> {
    return ApiResponse.ok(await this.chat.requestSupport({ actor, guestKey: ChatService.resolveGuestKey(guestHeader, actor) }, body), 'Đã gửi yêu cầu, nhân viên sẽ liên hệ sớm');
  }

  // ------------------------------------------------------------ phân tích phong cách

  @OptionalAuth() @Post('style-analysis') @HttpCode(HttpStatus.OK) @ApiBearerAuth() @ApiHeader(GUEST_HEADER)
  @RateLimit({ name: 'ai-style', limit: 10, windowSeconds: 3600, by: 'auto' })
  @UseInterceptors(FileInterceptor('image', IMAGE_LIMIT))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { image: { type: 'string', format: 'binary' }, gender: { type: 'string', enum: ['nam', 'nu'] }, occasion: { type: 'string' } }, required: ['image'] } })
  @ApiOperation({ summary: 'Upload ảnh người → dáng, màu hợp, phong cách, tư vấn + sản phẩm gợi ý (AI vision; lùi = rule)' })
  async styleAnalysis(@CurrentActor() actor: AuthenticatedActor | undefined, @Headers('x-guest-key') guestHeader: string | undefined, @Body() body: StyleAnalysisBody, @UploadedFile() file?: Express.Multer.File): Promise<ApiResponse<StyleAnalysisResponse & { guestKey: string | null }>> {
    if (!file) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Thiếu ảnh (field `image`)');
    const guestKey = ChatService.resolveGuestKey(guestHeader, actor);
    const r = await this.style.analyze({ actor, guestKey }, { buffer: file.buffer, mimetype: file.mimetype, size: file.size }, { gender: body.gender ?? null, occasion: body.occasion ?? null });
    return ApiResponse.ok({ ...r, guestKey });
  }

  @OptionalAuth() @Get('style-analysis/:id') @ApiBearerAuth() @ApiHeader(GUEST_HEADER)
  async styleResult(@CurrentActor() actor: AuthenticatedActor | undefined, @Headers('x-guest-key') guestHeader: string | undefined, @Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<StyleAnalysisResponse>> {
    return ApiResponse.ok(await this.style.get({ actor, guestKey: ChatService.resolveGuestKey(guestHeader, actor) }, id));
  }

  // ------------------------------------------------------------ tìm kiếm ảnh

  @OptionalAuth() @Post('image-search') @HttpCode(HttpStatus.OK) @ApiBearerAuth() @ApiHeader(GUEST_HEADER)
  @RateLimit({ name: 'ai-image-search', limit: 10, windowSeconds: 3600, by: 'auto' })
  @UseInterceptors(FileInterceptor('image', IMAGE_LIMIT))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { image: { type: 'string', format: 'binary' } }, required: ['image'] } })
  @ApiOperation({ summary: 'Upload ảnh sản phẩm → phân tích bằng vision + tìm sản phẩm tương tự (không có khoá OpenAI → available=false; không thấy gì → items rỗng + message)' })
  @ApiOkResponse({ type: ImageSearchResponse })
  async search(@CurrentActor() actor: AuthenticatedActor | undefined, @Headers('x-guest-key') guestHeader: string | undefined, @UploadedFile() file?: Express.Multer.File): Promise<ApiResponse<ImageSearchResponse>> {
    if (!file) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Thiếu ảnh (field `image`)');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      throw new BusinessException('COMMON_VALIDATION_ERROR', 'Chỉ nhận ảnh JPEG/PNG/WEBP');
    }
    if (!ImageSearchService.validateMagicBytes(file.buffer, file.mimetype)) {
      throw new BusinessException('COMMON_VALIDATION_ERROR', 'Ảnh không hợp lệ (magic bytes không khớp)');
    }
    const guestKey = ChatService.resolveGuestKey(guestHeader, actor);
    const r = await this.imageSearch.search({ actor, guestKey }, { buffer: file.buffer, mimetype: file.mimetype, size: file.size });
    return ApiResponse.ok(r);
  }

  // ------------------------------------------------------------ thử đồ 2D

  @OptionalAuth() @Post('try-on') @HttpCode(HttpStatus.ACCEPTED) @ApiBearerAuth() @ApiHeader(GUEST_HEADER)
  @RateLimit({ name: 'ai-tryon', limit: 10, windowSeconds: 3600, by: 'auto' })
  @UseInterceptors(FileInterceptor('image', IMAGE_LIMIT))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { image: { type: 'string', format: 'binary' }, productId: { type: 'string', format: 'uuid' }, colorCode: { type: 'string' } }, required: ['image', 'productId'] } })
  @ApiOperation({ summary: 'Ảnh người + sản phẩm → job thử đồ (202); FE poll GET /ai/try-on/:jobId tới status=done' })
  async createTryOn(@CurrentActor() actor: AuthenticatedActor | undefined, @Headers('x-guest-key') guestHeader: string | undefined, @Body() body: TryOnBody, @UploadedFile() file?: Express.Multer.File): Promise<ApiResponse<TryOnJobResponse & { guestKey: string | null }>> {
    if (!file) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Thiếu ảnh (field `image`)');
    const guestKey = ChatService.resolveGuestKey(guestHeader, actor);
    const job = await this.tryOn.create({ actor, guestKey }, { buffer: file.buffer, mimetype: file.mimetype, size: file.size }, { productId: body.productId, colorCode: body.colorCode ?? null });
    return ApiResponse.ok({ ...job, guestKey }, 'Đang xử lý, vui lòng đợi khoảng 30–90 giây');
  }

  @OptionalAuth() @Get('try-on') @ApiBearerAuth() @ApiHeader(GUEST_HEADER)
  async myTryOns(@CurrentActor() actor: AuthenticatedActor | undefined, @Headers('x-guest-key') guestHeader: string | undefined): Promise<ApiResponse<TryOnJobResponse[]>> {
    return ApiResponse.ok(await this.tryOn.mine({ actor, guestKey: ChatService.resolveGuestKey(guestHeader, actor) }));
  }

  @OptionalAuth() @Get('try-on/:jobId') @ApiBearerAuth() @ApiHeader(GUEST_HEADER)
  async tryOnStatus(@CurrentActor() actor: AuthenticatedActor | undefined, @Headers('x-guest-key') guestHeader: string | undefined, @Param('jobId', ParseUUIDPipe) jobId: string): Promise<ApiResponse<TryOnJobResponse>> {
    return ApiResponse.ok(await this.tryOn.get({ actor, guestKey: ChatService.resolveGuestKey(guestHeader, actor) }, jobId));
  }

  // ------------------------------------------------------------ gợi ý / so sánh / bộ sưu tập / FAQ

  @OptionalAuth() @Get('recommendations') @ApiBearerAuth() @ApiHeader(GUEST_HEADER) @ApiOperation({ summary: '"Có thể bạn thích" — theo lượt xem, đơn đã mua, vector tương tự (source: for_you)' })
  async recommendations(@CurrentActor() actor: AuthenticatedActor | undefined, @Headers('x-guest-key') guestHeader: string | undefined, @Query() q: RecommendQuery): Promise<ApiResponse<ProductCardResponse[]>> {
    return ApiResponse.ok(await this.insight.recommendations({ actor, guestKey: softGuest(guestHeader) }, q.limit ?? 8));
  }

  @Public() @Get('products/:slug/similar') @ApiOperation({ summary: 'Sản phẩm tương tự (láng giềng vector; lùi = cùng ngành)' })
  async similar(@Param('slug') slug: string, @Query() q: LimitQuery): Promise<ApiResponse<RecommendationResponse>> {
    return ApiResponse.ok(await this.recommendation.similar(slug, q.limit ?? 8));
  }

  @Public() @Get('products/:slug/bought-together') @ApiOperation({ summary: 'Thường mua cùng (đồng đơn; lùi = ngành phối đồ)' })
  async boughtTogether(@Param('slug') slug: string, @Query() q: LimitQuery): Promise<ApiResponse<RecommendationResponse>> {
    return ApiResponse.ok(await this.recommendation.boughtTogether(slug, q.limit ?? 6));
  }

  @ApiBearerAuth() @Get('cart-suggestions') @ApiOperation({ summary: 'Gợi ý cho giỏ hiện tại (mua cùng + tương tự, trừ món đã có)' })
  async cartSuggestions(@CurrentActor() actor: AuthenticatedActor, @Query() q: LimitQuery): Promise<ApiResponse<RecommendationResponse>> {
    return ApiResponse.ok(await this.recommendation.forCart(actor, q.limit ?? 6));
  }

  @Public() @Get('collections') @ApiOperation({ summary: 'Bộ sưu tập theo dịp hôm nay (AI đặt chủ đề, cache 24h; lùi = chủ đề rule)' })
  async collections(): Promise<ApiResponse<CollectionsResponse>> {
    return ApiResponse.ok(await this.recommendation.collections());
  }

  @Public() @Post('compare') @HttpCode(HttpStatus.OK) @RateLimit({ name: 'ai-compare', limit: 20, windowSeconds: 600, by: 'auto' }) @ApiOperation({ summary: 'So sánh 2–3 sản phẩm: bảng tiêu chí + kết luận hợp ai (cache 6h)' })
  async compare(@Body() body: CompareRequest): Promise<ApiResponse<CompareResponse>> {
    return ApiResponse.ok(await this.recommendation.compare(body.slugs));
  }

  @Public() @Get('products/:slug/faq') @ApiOperation({ summary: 'FAQ tự sinh cho sản phẩm — pending: FE thăm dò lại sau vài giây' })
  async productFaq(@Param('slug') slug: string): Promise<ApiResponse<ProductFaqResponse>> {
    return ApiResponse.ok(await this.faq.getForProduct(slug));
  }

  @Public() @Get('review-summary/:productId') @ApiOperation({ summary: 'Tóm tắt AI các đánh giá của sản phẩm (null khi chưa đủ 3 đánh giá / chưa có LLM)' })
  async reviewSummary(@Param('productId', ParseUUIDPipe) productId: string): Promise<ApiResponse<ReviewSummaryResponse | null>> {
    return ApiResponse.ok(await this.reviewAi.summary(productId));
  }

  // ------------------------------------------------------------ tín hiệu

  @OptionalAuth() @Post('events') @HttpCode(HttpStatus.ACCEPTED) @ApiBearerAuth() @ApiHeader(GUEST_HEADER)
  @RateLimit({ name: 'ai-events', limit: 240, windowSeconds: 600, by: 'auto' })
  @ApiOperation({ summary: 'Ghi một sự kiện: view | add_to_cart | click | impression (+ source dải gợi ý)' })
  async event(@CurrentActor() actor: AuthenticatedActor | undefined, @Headers('x-guest-key') guestHeader: string | undefined, @Body() body: SignalEventRequest): Promise<ApiResponse<{ accepted: number }>> {
    return ApiResponse.ok({ accepted: await this.signals.track({ actor, guestKey: softGuest(guestHeader) }, [body]) });
  }

  @OptionalAuth() @Post('events/batch') @HttpCode(HttpStatus.ACCEPTED) @ApiBearerAuth() @ApiHeader(GUEST_HEADER)
  @RateLimit({ name: 'ai-events', limit: 240, windowSeconds: 600, by: 'auto' })
  @ApiOperation({ summary: 'Ghi nhiều sự kiện một lần (≤ 50) — impression của cả dải' })
  async eventBatch(@CurrentActor() actor: AuthenticatedActor | undefined, @Headers('x-guest-key') guestHeader: string | undefined, @Body() body: SignalBatchRequest): Promise<ApiResponse<{ accepted: number }>> {
    return ApiResponse.ok({ accepted: await this.signals.track({ actor, guestKey: softGuest(guestHeader) }, body.events) });
  }

  @OptionalAuth() @Post('events/view') @HttpCode(HttpStatus.ACCEPTED) @ApiBearerAuth() @ApiHeader(GUEST_HEADER)
  @RateLimit({ name: 'ai-view', limit: 120, windowSeconds: 600, by: 'auto' })
  @ApiOperation({ summary: 'Ghi lượt xem sản phẩm (alias của POST /ai/events eventType=view)' })
  async view(@CurrentActor() actor: AuthenticatedActor | undefined, @Headers('x-guest-key') guestHeader: string | undefined, @Body() body: ViewEventRequest): Promise<ApiResponse<null>> {
    await this.signals.track({ actor, guestKey: softGuest(guestHeader) }, [{ productId: body.productId, eventType: 'view' }]);
    return ApiResponse.ok(null);
  }
}

/* ===== Quản trị: kho tri thức + chỉ mục, hỗ trợ, hội thoại, bot bí, kiểm duyệt, soạn nội dung, hỏi số liệu, công cụ nhân viên, chi phí ===== */
@ApiTags('admin-ai')
@ApiBearerAuth()
@Controller('admin/ai')
export class AdminAiController {
  constructor(
    private readonly knowledge: KnowledgeService,
    private readonly embeddings: EmbeddingService,
    private readonly chat: ChatService,
    private readonly chatInsights: ChatInsightsService,
    private readonly insight: AiInsightService,
    private readonly staff: StaffInsightService,
    private readonly metrics: MetricsAgentService,
    private readonly reviewAi: ReviewAiService,
    private readonly signals: SignalService,
    private readonly usage: AiUsageService,
  ) {}

  // ---- kho tri thức & chỉ mục
  @Get('documents') @RequirePermission('ai.knowledge.manage')
  async documents(@Query() q: DocumentListQuery): Promise<ApiResponse<PageResponse<AiDocumentResponse>>> {
    return ApiResponse.ok(await this.knowledge.list(q.page, q.size, { kind: q.kind, q: q.q }));
  }

  @Get('documents/:id') @RequirePermission('ai.knowledge.manage')
  async document(@Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<AiDocumentResponse>> {
    return ApiResponse.ok(await this.knowledge.get(id));
  }

  @Post('documents') @RequirePermission('ai.knowledge.manage') @ApiOperation({ summary: 'Thêm tài liệu — worker cắt đoạn + nhúng' })
  async createDocument(@CurrentActor() actor: AuthenticatedActor, @Body() body: SaveDocumentRequest): Promise<ApiResponse<AiDocumentResponse>> {
    return ApiResponse.ok(await this.knowledge.create(actor, body), 'Đã thêm tài liệu, đang nhúng');
  }

  @Patch('documents/:id') @RequirePermission('ai.knowledge.manage')
  async updateDocument(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateDocumentRequest): Promise<ApiResponse<AiDocumentResponse>> {
    return ApiResponse.ok(await this.knowledge.update(actor, id, body), 'Đã cập nhật tài liệu');
  }

  @Delete('documents/:id') @HttpCode(HttpStatus.OK) @RequirePermission('ai.knowledge.manage')
  async deleteDocument(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<null>> {
    await this.knowledge.remove(actor, id);
    return ApiResponse.ok(null, 'Đã xoá tài liệu');
  }

  @Post('documents/:id/reindex') @HttpCode(HttpStatus.OK) @RequirePermission('ai.knowledge.manage') @ApiOperation({ summary: 'Nhúng lại một bài' })
  async reindexDocument(@Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<null>> {
    await this.knowledge.reindexOne(id);
    return ApiResponse.ok(null, 'Đã xếp hàng nhúng lại');
  }

  @Get('index/status') @RequirePermission('ai.knowledge.manage') @ApiOperation({ summary: 'Chỉ mục AI đang thế nào (tài liệu, sản phẩm, FAQ, tóm tắt)' })
  async indexStatus() {
    return ApiResponse.ok({ ...(await this.knowledge.indexStatus()), embeddingEnabled: this.embeddings.enabled });
  }

  @Post('index/rebuild') @HttpCode(HttpStatus.OK) @RequirePermission('ai.knowledge.manage') @ApiOperation({ summary: 'Nhúng lại toàn bộ tài liệu (worker) + sản phẩm (tại chỗ, bỏ qua cái không đổi)' })
  async rebuild(): Promise<ApiResponse<{ documents: number; products: { updated: number; skipped: number; failed: number } }>> {
    const documents = await this.knowledge.reindexAll();
    const products = await this.embeddings.reindexProducts();
    return ApiResponse.ok({ documents, products }, 'Đã xếp hàng nhúng lại');
  }

  @Post('reindex') @HttpCode(HttpStatus.OK) @RequirePermission('ai.knowledge.manage') @ApiOperation({ summary: 'Alias của POST /admin/ai/index/rebuild' })
  async reindex() {
    return this.rebuild();
  }

  // ---- hỗ trợ & hội thoại
  @Get('support') @RequirePermission('ai.support.read')
  async supportList(@Query() q: SupportListQuery): Promise<ApiResponse<PageResponse<SupportRequestResponse>>> {
    return ApiResponse.ok(await this.insight.listSupport(q.page, q.size, q.status));
  }

  @Get('support/:id') @RequirePermission('ai.support.read')
  async supportGet(@Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<SupportRequestResponse>> {
    return ApiResponse.ok(await this.insight.getSupport(id));
  }

  @Put('support/:id') @RequirePermission('ai.support.resolve')
  async supportUpdate(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateSupportRequest): Promise<ApiResponse<SupportRequestResponse>> {
    return ApiResponse.ok(await this.insight.updateSupport(actor, id, body), 'Đã cập nhật yêu cầu hỗ trợ');
  }

  @Post('support/:id/draft-reply') @HttpCode(HttpStatus.OK) @RequirePermission('ai.support.read') @RateLimit({ name: 'ai-draft', limit: 30, windowSeconds: 3600, by: 'user' }) @ApiOperation({ summary: 'AI soạn nháp trả lời khách từ hội thoại (nhân viên sửa rồi gửi)' })
  async draftReply(@CurrentActor() actor: AuthenticatedActor, @Param('id', ParseUUIDPipe) id: string): Promise<ApiResponse<{ draft: string; source: string }>> {
    return ApiResponse.ok(await this.chat.draftSupportReply(actor, id));
  }

  @Get('chat/sessions') @RequirePermission('ai.chat.read')
  async chatSessions(@Query() q: PageQuery) {
    return ApiResponse.ok(await this.chat.listSessionsAdmin(q.page, q.size));
  }

  @Get('chat/sessions/:id') @RequirePermission('ai.chat.read') @ApiOperation({ summary: 'Hội thoại đã che email/số điện thoại, kèm tool đã dùng' })
  async chatSession(@Param('id', ParseUUIDPipe) id: string) {
    return ApiResponse.ok(await this.chat.sessionAdmin(id));
  }

  @Get('chat-insights') @RequirePermission('ai.chat.read') @ApiOperation({ summary: 'Khách hỏi gì mà bot bí? — cụm câu hỏi thiếu dữ liệu + bài kho tri thức nên viết' })
  async chatInsightsGet(@Query() q: DaysQuery): Promise<ApiResponse<ChatInsightsResponse>> {
    return ApiResponse.ok(await this.chatInsights.insights(q.days ?? 14));
  }

  // ---- kiểm duyệt & tóm tắt đánh giá
  @Get('moderation-flags') @RequirePermission('ai.moderation.read') @ApiOperation({ summary: 'Nhãn AI đề xuất cho đánh giá (nhân viên quyết ở /admin/reviews)' })
  async flags(@Query() q: FlagListQuery) {
    return ApiResponse.ok(await this.reviewAi.listFlags(q.page, q.size, q.label));
  }

  @Post('reviews/:reviewId/moderate') @HttpCode(HttpStatus.OK) @RequirePermission('ai.moderation.read') @ApiOperation({ summary: 'Chạy kiểm duyệt AI lại cho một đánh giá' })
  async moderateNow(@Param('reviewId', ParseUUIDPipe) reviewId: string) {
    return ApiResponse.ok(await this.reviewAi.moderate(reviewId));
  }

  @Post('review-summaries/:productId') @HttpCode(HttpStatus.OK) @RequirePermission('ai.insight.read') @ApiOperation({ summary: 'Tạo lại tóm tắt đánh giá cho sản phẩm' })
  async summarizeNow(@Param('productId', ParseUUIDPipe) productId: string): Promise<ApiResponse<ReviewSummaryResponse | null>> {
    return ApiResponse.ok(await this.reviewAi.summarize(productId));
  }

  // ---- soạn nội dung & công cụ nhân viên
  @Post('copy') @HttpCode(HttpStatus.OK) @RequirePermission('ai.copy.create') @RateLimit({ name: 'ai-copy', limit: 30, windowSeconds: 3600, by: 'user' }) @ApiOperation({ summary: 'AI soạn mô tả sản phẩm / trả lời đánh giá / nội dung KM' })
  async copy(@CurrentActor() actor: AuthenticatedActor, @Body() body: CopyRequest): Promise<ApiResponse<{ text: string; source: string }>> {
    return ApiResponse.ok(await this.insight.generateCopy(actor, body));
  }

  @Post('classify-product') @HttpCode(HttpStatus.OK) @RequirePermission('ai.copy.create') @RateLimit({ name: 'ai-classify', limit: 60, windowSeconds: 3600, by: 'user' }) @ApiOperation({ summary: 'Gợi ý ngành hàng / giới / tag / chất liệu từ tên + mô tả' })
  async classify(@CurrentActor() actor: AuthenticatedActor, @Body() body: ClassifyRequest): Promise<ApiResponse<ClassifyProductResponse>> {
    return ApiResponse.ok(await this.staff.classify(actor, body));
  }

  @Post('precheck-product/:productId') @HttpCode(HttpStatus.OK) @RequirePermission('ai.copy.create') @RateLimit({ name: 'ai-precheck', limit: 60, windowSeconds: 3600, by: 'user' }) @ApiOperation({ summary: 'Kiểm listing trước khi đăng bán: thiếu gì, câu nào nên sửa (không đổi trạng thái)' })
  async precheck(@CurrentActor() actor: AuthenticatedActor, @Param('productId', ParseUUIDPipe) productId: string): Promise<ApiResponse<PrecheckResponse>> {
    return ApiResponse.ok(await this.staff.precheck(actor, productId));
  }

  @Get('inventory-insights') @RequirePermission('ai.insight.read') @ApiOperation({ summary: 'Tốc độ bán 30 ngày theo biến thể → sắp hết / bán chậm / hết hàng + nhận xét AI' })
  async inventoryInsights(@CurrentActor() actor: AuthenticatedActor): Promise<ApiResponse<InventoryInsightsResponse>> {
    return ApiResponse.ok(await this.staff.inventoryInsights(actor));
  }

  @Get('revenue-insight') @RequirePermission('ai.insight.read') @ApiOperation({ summary: '30 ngày qua vs 30 ngày trước + top sản phẩm + nhận xét AI (cache 6h)' })
  async revenueInsight(@CurrentActor() actor: AuthenticatedActor): Promise<ApiResponse<RevenueInsightResponse>> {
    return ApiResponse.ok(await this.staff.revenueInsight(actor));
  }

  @Get('combo-suggestions') @RequirePermission('ai.insight.read') @ApiOperation({ summary: 'Combo từ cặp đồng mua 90 ngày (AI đặt tên + % giảm) — bấm tạo KM ở /admin/promotions' })
  async combos(@CurrentActor() actor: AuthenticatedActor): Promise<ApiResponse<ComboSuggestionsResponse>> {
    return ApiResponse.ok(await this.staff.comboSuggestions(actor));
  }

  @Post('ask') @HttpCode(HttpStatus.OK) @RequirePermission('ai.insight.read') @RateLimit({ name: 'ai-ask', limit: 30, windowSeconds: 3600, by: 'user' }) @ApiOperation({ summary: 'Hỏi số liệu bằng ngôn ngữ tự nhiên — agent gọi báo cáo có sẵn, KHÔNG sinh SQL' })
  async ask(@CurrentActor() actor: AuthenticatedActor, @Body() body: AskRequest): Promise<ApiResponse<{ answer: string; tools: string[]; source: string }>> {
    return ApiResponse.ok(await this.metrics.ask(actor, body.question));
  }

  // ---- chi phí & hiệu quả
  @Get('usage') @RequirePermission('ai.usage.read') @ApiOperation({ summary: 'Token/chi phí AI theo ngày và tính năng; hạn mức ngày' })
  async usageSummary(@Query() q: UsageQuery) {
    return ApiResponse.ok(await this.usage.summary(q.days ?? 14));
  }

  @Get('recommendation-stats') @RequirePermission('ai.usage.read') @ApiOperation({ summary: 'Hiệu quả dải gợi ý theo nguồn: hiển thị → click → thêm giỏ → mua' })
  async recStats(@Query() q: DaysQuery): Promise<ApiResponse<RecommendationStatsResponse>> {
    return ApiResponse.ok(await this.signals.stats(q.days ?? 30));
  }
}
