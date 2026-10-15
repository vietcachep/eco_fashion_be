import type { CacheSpec } from '@common/cache/cache.service';
import { AI_MODULE } from '../enums/ai-events';

export { AI_JOB, AI_MODULE } from '../enums/ai-events';

export const AI_ERR = {
  NOT_CONFIGURED: 'AI_NOT_CONFIGURED',
  BUDGET_EXCEEDED: 'AI_BUDGET_EXCEEDED',
  PROVIDER_FAILED: 'AI_PROVIDER_FAILED',
  SESSION_NOT_FOUND: 'AI_SESSION_NOT_FOUND',
  DOCUMENT_NOT_FOUND: 'AI_DOCUMENT_NOT_FOUND',
  SUPPORT_NOT_FOUND: 'AI_SUPPORT_NOT_FOUND',
  JOB_NOT_FOUND: 'AI_TRYON_JOB_NOT_FOUND',
  TRYON_NOT_CONFIGURED: 'AI_TRYON_NOT_CONFIGURED',
  PRODUCT_NOT_FOUND: 'AI_PRODUCT_NOT_FOUND',
  GUEST_KEY_INVALID: 'AI_GUEST_KEY_INVALID',
} as const;

/* Tính năng → ghi usage_logs + cổng ngân sách. */
export const AI_FEATURE = {
  CHAT: 'chat',
  CHAT_FOLLOWUP: 'chat-followup',
  CHAT_INSIGHTS: 'chat-insights',
  METRICS_AGENT: 'metrics-agent',
  RECOMMENDATION: 'recommendation',
  COMPARE: 'compare',
  COLLECTIONS: 'collections',
  PRODUCT_FAQ: 'product-faq',
  STAFF_INSIGHT: 'staff-insight',
  EMBEDDING: 'embedding',
  STYLE: 'style-analysis',
  TRY_ON: 'try-on',
  REVIEW_SUMMARY: 'review-summary',
  MODERATION: 'moderation',
  COPY: 'copy',
  IMAGE_SEARCH: 'image-search',
} as const;

export const AI_PROVIDER = { OPENAI: 'openai', REPLICATE: 'replicate', RULE: 'rule' } as const;
export const AI_SOURCE = { LLM: 'llm', RULE: 'rule' } as const;

export const TRYON_STATUS = { QUEUED: 'queued', PROCESSING: 'processing', DONE: 'done', FAILED: 'failed' } as const;
export const SUPPORT_STATUS = { OPEN: 'open', IN_PROGRESS: 'in_progress', RESOLVED: 'resolved' } as const;
export const INDEX_STATUS = { PENDING: 'pending', READY: 'ready', FAILED: 'failed' } as const;
export const MODERATION_LABEL = { OK: 'ok', SPAM: 'spam', TOXIC: 'toxic', OFF_TOPIC: 'off_topic' } as const;

/* Ngành hàng → vùng thử đồ của IDM-VTON. */
export const TRYON_CATEGORY: Record<string, 'upper_body' | 'lower_body' | 'dresses'> = {
  'ao-thun': 'upper_body',
  'ao-so-mi': 'upper_body',
  'ao-khoac': 'upper_body',
  'quan-jean': 'lower_body',
  'quan-short': 'lower_body',
  vay: 'lower_body',
  dam: 'dresses',
};

/* Giá ước tính USD / 1M token (chỉ để theo dõi chi phí tương đối, không phải hoá đơn). */
export const TOKEN_PRICE_USD_PER_M: Record<string, { in: number; out: number }> = {
  'text-embedding-3-small': { in: 0.02, out: 0 },
  default: { in: 0.15, out: 0.6 },
};

/* Replicate IDM-VTON: ~0.03 USD / lần (ghi vào cost_estimate để hạn mức ngày có ý nghĩa). */
export const TRYON_COST_USD = 0.03;
export const TRYON_MAX_WAIT_MS = 4 * 60_000;
/* Số lần BullMQ thử chạy một job thử đồ (lỗi mạng tạm thời tới Replicate/Cloudinary được thử lại). */
export const TRYON_MAX_ATTEMPTS = 2;
export const TRYON_POLL_MS = 4_000;

export const AI_CACHE = {
  reviewSummary: { module: AI_MODULE, purpose: 'review-summary', ttlSeconds: 600 } satisfies CacheSpec,
  recommend: { module: AI_MODULE, purpose: 'recommend', ttlSeconds: 300 } satisfies CacheSpec,
  similar: { module: AI_MODULE, purpose: 'similar', ttlSeconds: 600 } satisfies CacheSpec,
  boughtTogether: { module: AI_MODULE, purpose: 'bought-together', ttlSeconds: 600 } satisfies CacheSpec,
  collections: { module: AI_MODULE, purpose: 'collections', ttlSeconds: 24 * 3600 } satisfies CacheSpec,
  compare: { module: AI_MODULE, purpose: 'compare', ttlSeconds: 6 * 3600 } satisfies CacheSpec,
  chatInsights: { module: AI_MODULE, purpose: 'chat-insights', ttlSeconds: 3600 } satisfies CacheSpec,
  recStats: { module: AI_MODULE, purpose: 'rec-stats', ttlSeconds: 600 } satisfies CacheSpec,
  staffInsight: { module: AI_MODULE, purpose: 'staff-insight', ttlSeconds: 6 * 3600 } satisfies CacheSpec,
};

/* Nguồn dải gợi ý hợp lệ (trùng tên dải ở FE) — nguồn lạ bị bỏ, không 400 (telemetry). */
export const REC_SOURCES = ['for_you', 'similar', 'bought_together', 'cart', 'chat', 'collection', 'search', 'compare', 'style', 'faq'] as const;
export const EVENT_TYPES = ['view', 'add_to_cart', 'click', 'impression'] as const;

/* Từ khoá thô cho đường lùi chatbot / phân tích (không LLM). */
export const RULE = {
  HUMAN: ['gặp nhân viên', 'gặp người', 'nhân viên hỗ trợ', 'tư vấn viên', 'người thật', 'hotline', 'khiếu nại'],
  /* Chỉ khi hỏi về ĐƠN cụ thể — từ chung như 'ship', 'giao hàng' để LLM/kho tri thức trả lời chính sách. */
  ORDER: ['đơn hàng của tôi', 'đơn của tôi', 'đơn của mình', 'kiểm tra đơn', 'tra đơn', 'trạng thái đơn', 'theo dõi đơn', 'mã đơn', 'đơn mình đặt', 'đơn tôi đặt', 'đơn đã đặt', 'dhdemo', 'dh26'],
  POLICY: ['đổi trả', 'hoàn tiền', 'bảo hành', 'chính sách', 'phí ship', 'miễn phí', 'thanh toán', 'chuyển khoản', 'payos', 'cod', 'size', 'kích cỡ', 'bảng size', 'giặt'],
  GREETING: ['xin chào', 'chào', 'hello', 'hi ', 'alo'],
  CATEGORY: [
    { slugs: ['ao-thun'], words: ['áo thun', 'ao thun', 'tee', 't-shirt', 'polo', 'croptop'] },
    { slugs: ['ao-so-mi', 'ao-khoac'], words: ['sơ mi', 'so mi', 'công sở', 'cong so', 'blazer', 'áo khoác', 'ao khoac', 'bomber'] },
    { slugs: ['quan-jean', 'quan-short'], words: ['jean', 'quần', 'quan ', 'short'] },
    { slugs: ['vay', 'dam'], words: ['váy', 'vay', 'đầm', 'dam ', 'dự tiệc', 'du tiec'] },
  ],
  COLOR: [
    { code: 'den', words: ['đen', 'den', 'black'] },
    { code: 'trang', words: ['trắng', 'trang', 'white'] },
    { code: 'xam', words: ['xám', 'xam', 'grey', 'gray'] },
    { code: 'be', words: ['be ', 'beige', 'kem'] },
    { code: 'xanh', words: ['navy', 'xanh navy', 'xanh đậm'] },
    { code: 'hong', words: ['hồng', 'hong', 'pink', 'pastel'] },
    { code: 'do', words: ['đỏ', 'do ', 'red'] },
    { code: 'nau', words: ['nâu', 'nau', 'brown'] },
    { code: 'xanhla', words: ['rêu', 'reu', 'xanh lá', 'olive', 'green'] },
    { code: 'denim', words: ['denim', 'xanh jean'] },
  ],
};
