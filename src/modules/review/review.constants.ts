/*
 * Hằng số của module review.
 *
 * Phản hồi dưới đánh giá hiện CÔNG KHAI nên KHÔNG BAO GIỜ được lộ họ tên nhân viên (của sàn hay của shop). Tên đứng dưới phản hồi được TÍNH khi đọc từ
 * `ReviewReply.authorKind`, không đọc cột `staff_name` đã lưu (cột đó có thể còn họ tên thật ở dữ liệu cũ):
 *   - `shop`     — vendor trả lời qua /shop/reviews/:id/reply  ⇒ hiện TÊN GIAN HÀNG hiện tại của shop sở hữu đánh giá;
 *   - `platform` — nhân viên sàn trả lời qua /admin/reviews/:id/reply ⇒ hiện REVIEW_PLATFORM_NAME.
 * Người trả lời thật vẫn lưu ở `staffUserId` + audit REVIEW_REPLIED để truy vết nội bộ.
 */
export const REVIEW_REPLY_AUTHOR = { SHOP: 'shop', PLATFORM: 'platform' } as const;
export type ReviewReplyAuthor = (typeof REVIEW_REPLY_AUTHOR)[keyof typeof REVIEW_REPLY_AUTHOR];

/* Tên trung tính của sàn khi nhân viên sàn trả lời thay cửa hàng (không phải họ tên nhân viên). */
export const REVIEW_PLATFORM_NAME = 'Sàn FITLY';

/* Tên dự phòng khi phản hồi của shop nhưng không tra được tên shop (shop đã bị xoá…) — vẫn không lộ gì về người trả lời. */
export const REVIEW_SHOP_FALLBACK_NAME = 'Cửa hàng';
