import { Injectable, Logger } from '@nestjs/common';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CatalogQueryApi, CategoryBrief } from '../../catalog/queryapi/catalog.queryapi';
import { ProductCardResponse, ProductQueryApi } from '../../product/queryapi/product.queryapi';
import { AI_FEATURE } from '../foundation/ai.constants';
import { OpenAiProvider } from '../provider/openai.provider';
import { ImageSearchResponse } from './image-search.response';

export { ImageSearchResponse } from './image-search.response';

/* Thông điệp kèm kết quả (FE hiện dưới ô kết quả). */
export const IMAGE_SEARCH_MESSAGE = {
  NOT_FOUND: 'Không tìm thấy sản phẩm giống ảnh',
  CATEGORY_ONLY: 'Chưa có sản phẩm khớp chính xác với ảnh — gợi ý các sản phẩm cùng ngành',
  FEW: 'Chỉ có rất ít sản phẩm khớp với ảnh — thử ảnh rõ nét hơn hoặc tìm bằng từ khoá',
  VISION_FAILED: 'Không phân tích được ảnh lúc này, vui lòng thử lại hoặc dùng ảnh khác',
} as const;

const RESULT_LIMIT = 12;
const PER_KEYWORD_LIMIT = 12;
/* Từ chừng này sản phẩm trở xuống (và chẳng có gì "cùng ngành" để gợi ý thêm) thì kèm lời nhắn "rất ít kết quả". */
export const IMAGE_SEARCH_FEW_RESULTS = 2;
/* Số ngành tối đa đưa vào prompt vision (chặn chi phí khi cây ngành phình to). */
const MAX_CATEGORIES_IN_PROMPT = 150;

interface VisionAnswer {
  description?: string;
  keywords?: string[];
  attributes?: string[];
  categorySlugHint?: string;
}

const MAGIC_BYTES = {
  jpeg: [0xff, 0xd8, 0xff],
  png: [0x89, 0x50, 0x4e, 0x47],
  webp: [0x52, 0x49, 0x46, 0x46],
};

/* Từ chỉ MÀU / sắc độ — từ khoá chỉ gồm những từ này (hoặc "màu …") quá chung để tự nó kết luận "cùng loại sản phẩm" (xem isGenericKeyword). */
const COLOR_WORDS = new Set(['trắng', 'đen', 'xám', 'ghi', 'đỏ', 'vàng', 'xanh', 'tím', 'nâu', 'navy', 'đậm', 'nhạt', 'sáng', 'tối', 'pastel', 'neon']);
/* Vừa là màu vừa là TÊN sản phẩm (cam, kem, hồng, bạc, đồng...) — chỉ coi là màu khi có chữ "màu" đi kèm ("màu cam"), đứng một mình ("cam", "kem") là sản phẩm. */
const COLOR_WORDS_NEED_PREFIX = new Set(['hồng', 'cam', 'be', 'kem', 'bạc', 'đồng']);
/* Chỉ là sắc độ khi đi cùng "xanh" ("xanh lá", "xanh dương"...) — đứng một mình ("lá trà") là tên sản phẩm. */
const BLUE_GREEN_SHADES = new Set(['lá', 'dương', 'rêu', 'ngọc', 'biển', 'than', 'lam', 'lục']);
const COLOR_PREFIX = 'màu';

/** Một phép tìm ảnh: ngành được vision chọn (đã kiểm tra có sản phẩm) + các thẻ sản phẩm "cùng ngành" để gợi ý. */
export interface ImageSearchScope {
  slug: string;
  name: string;
  cards: ProductCardResponse[];
}

/* Kết quả tra MỘT từ khoá loại sản phẩm: từ khoá thật sự đã tra (cụm 2 từ đầu nếu phải rút gọn) + thẻ sản phẩm (đã xếp theo độ liên quan). */
export interface KeywordHits {
  keyword: string;
  cards: ProductCardResponse[];
}

export interface RankedImageSearch {
  items: ProductCardResponse[];
  /* Số sản phẩm trong `items` khớp theo LOẠI sản phẩm (từ khoá không-chung). 0 = chỉ có gợi ý cùng ngành. */
  strong: number;
}

/* Bỏ thẻ trùng id, giữ thứ tự xuất hiện đầu tiên. */
function dedupeCards(cards: ProductCardResponse[]): ProductCardResponse[] {
  const seen = new Set<string>();
  return cards.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}

/**
 * Upload ảnh → phân tích bằng vision → gợi ý sản phẩm (PLAN-0XXX B9 ai-image-search).
 * OpenAI vision trả JSON {description, keywords, attributes, categorySlugHint}; validate shape + trim lengths.
 * Ảnh KHÔNG được lưu lại (không persist buffer).
 *
 * LIÊN QUAN, KHÔNG ĐỆM: kết quả chỉ gồm sản phẩm có LÝ DO liên quan tới ảnh, trả ít hơn RESULT_LIMIT nếu chỉ có ít — không bao giờ "đệm cho đủ".
 *  - Vision nhận danh sách ngành thật của sàn và chọn `categorySlugHint` trong đó (không còn bịa slug). Ngành hợp lệ + có sản phẩm = PHẠM VI ngành.
 *  - `keywords` = LOẠI sản phẩm (vd "giày sneaker"); màu/chất liệu/phong cách nằm ở `attributes` — chỉ để hiển thị, KHÔNG dùng để tìm (nếu không "màu tím"
 *    kéo về hộp màu, đèn xe, thuốc bổ). Từ khoá chỉ gồm màu bị coi là CHUNG (isGenericKeyword) và cũng không được tìm, phòng khi vision lỡ đưa màu vào keywords.
 *  - Mỗi từ khoá loại sản phẩm tra RIÊNG (tsvector + trigram, ProductQueryApi.searchCards). Tìm kiếm khớp mờ nên trả cả cái chỉ giống một phần ("giày thể thao" ra "Áo thể
 *    thao nam"): chỉ sản phẩm mà TÊN phủ đủ mọi từ của từ khoá mới là khớp theo loại ("mạnh") — keywordCoversName.
 *  - Xếp hạng + ngưỡng: xem rankRelevant. Tóm tắt: khớp mạnh trước (cùng ngành lên đầu), rồi — chỉ khi từ khoá xác nhận ngành vision chọn — gợi ý cùng ngành;
 *    khớp một từ khoá nhưng khác ngành mà không phải loại sản phẩm thì BỊ BỎ. Không có khớp mạnh nào: lùi về gợi ý THEO NGÀNH (kèm message), không có ngành
 *    thì danh sách rỗng + message. Rất ít kết quả cũng kèm message gợi ý.
 * Không dùng độ tương đồng vector: đo thực tế (text-embedding-3-small, tiếng Việt) khoảng cách của sản phẩm đúng (0.38–0.57) chồng lên sản phẩm sai (0.55–0.61),
 * không có ngưỡng nào tách được — ngành + loại sản phẩm đáng tin hơn và không tốn thêm một lần gọi OpenAI.
 */
@Injectable()
export class ImageSearchService {
  private readonly logger = new Logger(ImageSearchService.name);

  constructor(
    private readonly openai: OpenAiProvider,
    private readonly products: ProductQueryApi,
    private readonly catalog: CatalogQueryApi,
  ) {}

  async search(who: { actor?: AuthenticatedActor; guestKey?: string | null }, file: { buffer: Buffer; mimetype: string; size: number }): Promise<ImageSearchResponse> {
    // Không lưu ảnh — chỉ xử lý, không persist buffer
    if (!this.openai.isConfigured) {
      return { available: false, description: null, keywords: [], items: [], message: null };
    }

    try {
      // Chuyển buffer sang data URL để gửi tới vision
      const base64 = file.buffer.toString('base64');
      const mediaType = this.mimetypeToMediaType(file.mimetype);
      const dataUrl = `data:${mediaType};base64,${base64}`;

      const categories = await this.catalog.listActiveCategories();
      const { description, keywords, attributes, categorySlugHint } = await this.analyzeWithVision(dataUrl, who.actor?.userId ?? null, categories);

      // Ngành vision chọn chỉ dùng khi là ngành có thật, đang hoạt động (nằm trong danh sách đã đưa cho vision) và còn sản phẩm đang bán
      const picked = categorySlugHint ? categories.find((c) => c.slug === categorySlugHint && c.isActive) : undefined;
      const [perKeyword, scopeCards] = await Promise.all([this.searchByKeywords(keywords), picked ? this.products.recommend({ categorySlugs: [picked.slug], limit: RESULT_LIMIT }) : Promise.resolve([])]);
      const scope: ImageSearchScope | null = picked && scopeCards.length > 0 ? { slug: picked.slug, name: picked.name, cards: scopeCards } : null;

      const { items, strong } = ImageSearchService.rankRelevant(perKeyword, scope, RESULT_LIMIT);
      const message = ImageSearchService.messageFor(items.length, strong, scope?.name ?? null);

      // Log usage
      this.logger.log(
        {
          userId: who.actor?.userId ?? null,
          guestKey: who.actor ? null : (who.guestKey ?? null),
          keywords: keywords.length,
          itemsFound: items.length,
          itemsStrong: strong,
          categoryHint: categorySlugHint,
          categoryUsed: scope?.slug ?? null,
        },
        'Tìm kiếm ảnh xong'
      );

      return { available: true, description: description.slice(0, 500), keywords: ImageSearchService.dedupeKeywords([...keywords, ...attributes]), items, message };
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, 'Vision tìm kiếm ảnh lỗi');
      // Vision/tìm kiếm lỗi: không làm hỏng trang — available=true, rỗng, kèm message để FE báo người dùng thử lại
      return { available: true, description: null, keywords: [], items: [], message: IMAGE_SEARCH_MESSAGE.VISION_FAILED };
    }
  }

  /*
   * Tìm sản phẩm bằng TỪNG từ khoá loại sản phẩm (OR). Từ khoá CHUNG (chỉ màu…) không được tìm: chúng không nói gì về LOẠI sản phẩm. Vòng 1: mỗi từ khoá nguyên
   * cụm. Vòng 2 (chỉ từ khoá ≥3 từ mà vòng 1 trả rỗng): thử lại bằng cụm 2 từ đầu ("áo thun trắng" → "áo thun") vì tìm tsvector đòi khớp mọi từ.
   * Không có từ khoá nào ⇒ mảng rỗng, không chạm DB. Trả mỗi từ khoá một mảng (đã xếp theo độ liên quan).
   */
  private async searchByKeywords(keywords: string[]): Promise<KeywordHits[]> {
    const terms = ImageSearchService.dedupeKeywords(keywords).filter((t) => !ImageSearchService.isGenericKeyword(t));
    if (terms.length === 0) return [];

    return Promise.all(
      terms.map(async (t): Promise<KeywordHits> => {
        const cards = await this.products.searchCards(t, PER_KEYWORD_LIMIT);
        const head = ImageSearchService.headPhrase(t);
        if (cards.length === 0 && head) return { keyword: head, cards: await this.products.searchCards(head, PER_KEYWORD_LIMIT) };
        return { keyword: t, cards };
      }),
    );
  }

  /* Bỏ từ khoá trùng (không phân biệt hoa/thường, khoảng trắng thừa) giữ thứ tự; tối đa 6. */
  static dedupeKeywords(keywords: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const k of keywords) {
      const t = k.replace(/\s+/g, ' ').trim();
      const key = t.toLowerCase();
      if (t.length === 0 || seen.has(key)) continue;
      seen.add(key);
      out.push(t);
      if (out.length === 6) break;
    }
    return out;
  }

  /* Cụm 2 từ đầu của từ khoá ≥3 từ; null nếu từ khoá chỉ 1–2 từ (không có gì để rút gọn). */
  static headPhrase(keyword: string): string | null {
    const words = keyword.split(/\s+/).filter(Boolean);
    return words.length >= 3 ? words.slice(0, 2).join(' ') : null;
  }

  /*
   * Từ khoá CHUNG = chỉ gồm màu / sắc độ (có thể kèm "màu", "xanh lá"…) hoặc quá ngắn (< 2 ký tự chữ): khớp nó chẳng chứng tỏ cùng LOẠI sản phẩm
   * ("màu tím" trùng hộp bút màu, đèn LED, thuốc bổ…). Từ khoá chung không được tìm và không đủ để một sản phẩm "khớp mạnh".
   */
  static isGenericKeyword(keyword: string): boolean {
    const words = keyword.toLowerCase().normalize('NFC').split(/\s+/).filter(Boolean);
    if (words.join('').length < 2) return true;
    const hasPrefix = words.includes(COLOR_PREFIX);
    const hasBlue = words.includes('xanh');
    const rest = words.filter((w) => w !== COLOR_PREFIX);
    if (rest.length === 0) return true; // chỉ có chữ "màu"
    return rest.every((w) => COLOR_WORDS.has(w) || (hasPrefix && COLOR_WORDS_NEED_PREFIX.has(w)) || (hasBlue && BLUE_GREEN_SHADES.has(w)));
  }

  /*
   * Từ khoá "phủ" tên sản phẩm khi MỌI từ của từ khoá đều là tiền tố của một từ trong tên (bỏ dấu, không phân biệt hoa/thường): "giày thể thao" phủ "Giày thể
   * thao SOLESTRIDE" nhưng KHÔNG phủ "Áo thể thao nam" / "Dép thể thao". Tìm kiếm của product khớp mờ (trigram) nên trả cả cái chỉ giống một phần — đây là ngưỡng
   * độ khớp từ khoá để loại chúng.
   */
  static keywordCoversName(keyword: string, name: string): boolean {
    const kw = ImageSearchService.matchTokens(keyword);
    if (kw.length === 0) return false;
    const nameTokens = ImageSearchService.matchTokens(name);
    return kw.every((k) => nameTokens.some((n) => n.startsWith(k)));
  }

  private static matchTokens(text: string): string[] {
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/đ/g, 'd')
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
  }

  /*
   * Xếp hạng + NGƯỠNG liên quan (hàm thuần). `perKeyword`: mỗi từ khoá loại sản phẩm một mảng thẻ (đã xếp theo độ liên quan). `scope`: ngành vision chọn
   * (null nếu không có/không hợp lệ/không còn hàng) kèm thẻ sản phẩm nổi bật của ngành đó.
   *  1. Gộp theo productId. "Khớp mạnh" = tên sản phẩm PHỦ ít nhất một từ khoá (keywordCoversName); khớp mờ không phủ thì không tính. Xếp: số từ khoá phủ ↓,
   *     cùng ngành trước, độ nổi bật (soldCount) ↓, thứ hạng liên quan ↑.
   *  2. Có khớp mạnh VÀ có ít nhất một cái thuộc ngành vision chọn (từ khoá xác nhận ngành) ⇒ nối thêm các sản phẩm CÙNG NGÀNH còn lại (khớp mờ trong ngành rồi
   *     nổi bật của ngành) cho phong phú. Khớp mờ KHÁC ngành thì bỏ.
   *  3. Có khớp mạnh nhưng khác ngành vision chọn (vision chọn sai ngành) ⇒ chỉ trả khớp mạnh; KHÔNG nối gợi ý của ngành sai.
   *  4. Không có khớp mạnh ⇒ chỉ gợi ý cùng ngành (nếu có ngành), còn không thì rỗng.
   * Không bao giờ thêm sản phẩm chỉ vì "cho đủ limit".
   */
  static rankRelevant(perKeyword: KeywordHits[], scope: ImageSearchScope | null, limit: number): RankedImageSearch {
    const agg = new Map<string, { card: ProductCardResponse; hits: number; weak: number; pos: number }>();
    for (const { keyword, cards } of perKeyword) {
      const seenInKeyword = new Set<string>();
      cards.forEach((card, pos) => {
        if (seenInKeyword.has(card.id)) return;
        seenInKeyword.add(card.id);
        const covers = ImageSearchService.keywordCoversName(keyword, card.name);
        const e = agg.get(card.id) ?? { card, hits: 0, weak: 0, pos };
        if (covers) e.hits += 1;
        else e.weak += 1;
        e.pos = Math.min(e.pos, pos);
        agg.set(card.id, e);
      });
    }
    const inScope = (c: ProductCardResponse): boolean => scope !== null && c.categorySlug === scope.slug;
    const entries = [...agg.values()];
    const strong = entries
      .filter((e) => e.hits > 0)
      .sort((a, b) => b.hits - a.hits || Number(inScope(b.card)) - Number(inScope(a.card)) || b.card.soldCount - a.card.soldCount || a.pos - b.pos)
      .map((e) => e.card);
    // Cùng ngành nhưng chỉ khớp mờ: đứng trước phần "nổi bật của ngành" thuần túy.
    const weakInScope = entries
      .filter((e) => e.hits === 0 && inScope(e.card))
      .sort((a, b) => b.weak - a.weak || b.card.soldCount - a.card.soldCount || a.pos - b.pos)
      .map((e) => e.card);

    if (strong.length === 0) {
      return { items: scope ? dedupeCards([...weakInScope, ...scope.cards]).slice(0, limit) : [], strong: 0 };
    }
    const confirmed = scope !== null && strong.some(inScope);
    const strongIds = new Set(strong.map((c) => c.id));
    const fill = confirmed ? dedupeCards([...weakInScope, ...scope.cards]).filter((c) => !strongIds.has(c.id)) : [];
    const items = [...strong, ...fill].slice(0, limit);
    return { items, strong: Math.min(strong.length, items.length) };
  }

  /* Lời nhắn cho FE: không có gì / chỉ gợi ý cùng ngành / rất ít kết quả khớp / đủ tốt (null). */
  static messageFor(total: number, strong: number, categoryName: string | null): string | null {
    if (total === 0) return IMAGE_SEARCH_MESSAGE.NOT_FOUND;
    if (strong === 0) return categoryName ? `${IMAGE_SEARCH_MESSAGE.CATEGORY_ONLY} "${categoryName}"` : IMAGE_SEARCH_MESSAGE.CATEGORY_ONLY;
    if (total <= IMAGE_SEARCH_FEW_RESULTS) return IMAGE_SEARCH_MESSAGE.FEW;
    return null;
  }

  private mimetypeToMediaType(mimetype: string): string {
    if (mimetype === 'image/jpeg') return 'image/jpeg';
    if (mimetype === 'image/png') return 'image/png';
    if (mimetype === 'image/webp') return 'image/webp';
    return 'image/jpeg'; // fallback
  }

  private async analyzeWithVision(dataUrl: string, userId: string | null, categories: CategoryBrief[]): Promise<{ description: string; keywords: string[]; attributes: string[]; categorySlugHint: string | null }> {
    const categoryList = categories
      .filter((c) => c.isActive)
      .slice(0, MAX_CATEGORIES_IN_PROMPT)
      .map((c) => `${c.slug}: ${c.name}`)
      .join('; ');
    const system = [
      'Bạn là trợ lý tìm kiếm ảnh cho sàn thương mại điện tử nhiều ngành hàng (thời trang, điện tử, gia dụng, mỹ phẩm, giày dép, đồng hồ, thể thao, mẹ & bé, sách, thú cưng, xe cộ...).',
      'Phân tích ảnh sản phẩm và trả JSON strict: {"description": string (mô tả ngắn ≤ 100 ký tự), "keywords": string[] (≤4), "attributes": string[] (≤3), "categorySlugHint": string | null}.',
      '- keywords: tên LOẠI SẢN PHẨM trong ảnh, ngắn (≤3 từ), tiếng Việt, từ cụ thể nhất tới tổng quát (vd ["giày sneaker", "giày thể thao"], ["áo thun", "áo cotton"], ["điện thoại"]). TUYỆT ĐỐI không đưa màu sắc, chất liệu, kích cỡ, giới tính hay phong cách vào keywords.',
      '- attributes: màu sắc/chất liệu/phong cách nổi bật (vd ["màu xám", "da"]); chỉ để hiển thị, không dùng để tìm kiếm.',
      '- categorySlugHint: CHỌN MỘT slug trong danh sách ngành bên dưới (ngành cụ thể nhất khớp với sản phẩm); không có ngành nào hợp thì null. Không tự bịa slug.',
      'Nếu ảnh không rõ hoặc không phải sản phẩm (người, phong cảnh, thú vật, ảnh chụp màn hình...), đặt keywords=[], attributes=[], categorySlugHint=null.',
      `Danh sách ngành (slug: tên): ${categoryList}`,
    ].join('\n');
    const user = 'Phân tích ảnh này và trả JSON strict.';

    const res = await this.openai.chatJson<VisionAnswer>(
      [
        { role: 'system', content: system },
        {
          role: 'user',
          content: [
            { type: 'text', text: user },
            { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
          ],
        },
      ],
      { feature: AI_FEATURE.IMAGE_SEARCH, userId, maxTokens: 300 }
    );

    const d = res.data;
    return {
      description: ImageSearchService.sanitizeDescription(d.description ?? ''),
      keywords: ImageSearchService.sanitizeKeywords(d.keywords ?? []),
      attributes: ImageSearchService.sanitizeKeywords(d.attributes ?? [], 3),
      categorySlugHint: ImageSearchService.sanitizeCategorySlug(d.categorySlugHint ?? null),
    };
  }

  static sanitizeDescription(desc: string): string {
    if (!desc || typeof desc !== 'string') return '';
    // Xoá instruction-like patterns; cắt tối đa 100 ký tự
    const cleaned = desc
      .replace(/\{.*?\}/g, '') // Xoá {...}
      .replace(/\[.*?\]/g, '') // Xoá [...]
      .replace(/`[^`]*`/g, '') // Xoá code blocks
      .trim();
    return cleaned.slice(0, 100);
  }

  static sanitizeKeywords(keywords: unknown[], max = 6): string[] {
    if (!Array.isArray(keywords)) return [];
    const result: string[] = [];
    for (const k of keywords) {
      if (typeof k !== 'string') continue;
      // Từ ngắn max 30 ký tự; xoá instruction-like patterns
      const cleaned = k
        .replace(/[{}[\]`]/g, '')
        .slice(0, 30)
        .trim();
      if (cleaned.length > 0 && result.length < max) {
        result.push(cleaned);
      }
    }
    return result;
  }

  static sanitizeCategorySlug(slug: unknown): string | null {
    if (typeof slug !== 'string') return null;
    // Slug format: kebab-case, max 50 ký tự, chỉ chứa a-z, 0-9, - (quá dài thì bỏ, KHÔNG cắt: slug bị cắt cụt là slug khác)
    const cleaned = slug.trim();
    if (cleaned.length > 50 || !/^[a-z0-9-]+$/.test(cleaned)) return null;
    return cleaned;
  }

  static validateMagicBytes(buffer: Buffer, mimetype: string): boolean {
    if (buffer.length < 4) return false;

    if (mimetype === 'image/jpeg') {
      // JPEG: FF D8 FF
      return buffer[0] === MAGIC_BYTES.jpeg[0] && buffer[1] === MAGIC_BYTES.jpeg[1] && buffer[2] === MAGIC_BYTES.jpeg[2];
    }

    if (mimetype === 'image/png') {
      // PNG: 89 50 4E 47
      return (
        buffer[0] === MAGIC_BYTES.png[0] &&
        buffer[1] === MAGIC_BYTES.png[1] &&
        buffer[2] === MAGIC_BYTES.png[2] &&
        buffer[3] === MAGIC_BYTES.png[3]
      );
    }

    if (mimetype === 'image/webp') {
      // WEBP: 52 49 46 46 (RIFF) ... 57 45 42 50 (WEBP)
      if (
        buffer[0] === MAGIC_BYTES.webp[0] &&
        buffer[1] === MAGIC_BYTES.webp[1] &&
        buffer[2] === MAGIC_BYTES.webp[2] &&
        buffer[3] === MAGIC_BYTES.webp[3]
      ) {
        // Check for WEBP signature at offset 8-12
        if (buffer.length >= 12) {
          return buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50;
        }
        return true; // Không thể verify WEBP signature
      }
      return false;
    }

    return false;
  }
}
