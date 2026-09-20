/* Phần CÔNG KHAI của ai. Module ai không phát outbox (chỉ tiêu thụ); hằng module dùng cho relay/cache/log. */
export const AI_MODULE = 'ai';

/* Tên job trên hàng đợi BullMQ `ai` (API enqueue, worker xử lý). */
export const AI_JOB = {
  TRY_ON: 'try-on',
  EMBED_PRODUCT: 'embed-product',
  INDEX_DOCUMENT: 'index-document',
  REVIEW_ANALYZE: 'review-analyze',
  PRODUCT_FAQ: 'product-faq',
} as const;
