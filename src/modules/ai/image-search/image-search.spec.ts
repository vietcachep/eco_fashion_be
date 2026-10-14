import { Logger } from '@nestjs/common';
import type { CatalogQueryApi, CategoryBrief } from '../../catalog/queryapi/catalog.queryapi';
import type { ProductCardResponse, ProductQueryApi } from '../../product/queryapi/product.queryapi';
import type { OpenAiProvider } from '../provider/openai.provider';
import { IMAGE_SEARCH_MESSAGE, ImageSearchScope, ImageSearchService } from './image-search.service';

/* Thẻ sản phẩm tối thiểu cho test xếp hạng/lọc (chỉ các trường service đọc: id, categorySlug, soldCount). */
function card(id: string, overrides: Partial<ProductCardResponse> = {}): ProductCardResponse {
  return { id, slug: id, name: id, categorySlug: 'ao-thun', soldCount: 0, ...overrides } as ProductCardResponse;
}

describe('ImageSearchService', () => {
  describe('magic byte validation', () => {
    it('nhận diện JPEG magic bytes (FF D8 FF)', () => {
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
      expect(ImageSearchService.validateMagicBytes(jpeg, 'image/jpeg')).toBe(true);
    });

    it('nhận diện PNG magic bytes (89 50 4E 47)', () => {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
      expect(ImageSearchService.validateMagicBytes(png, 'image/png')).toBe(true);
    });

    it('nhận diện WEBP magic bytes (RIFF...WEBP)', () => {
      const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
      expect(ImageSearchService.validateMagicBytes(webp, 'image/webp')).toBe(true);
    });

    it('từ chối JPEG buffer với magic bytes sai', () => {
      const fake = Buffer.from([0x00, 0x00, 0x00, 0x00]);
      expect(ImageSearchService.validateMagicBytes(fake, 'image/jpeg')).toBe(false);
    });

    it('từ chối PNG buffer với magic bytes sai', () => {
      const fake = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
      expect(ImageSearchService.validateMagicBytes(fake, 'image/png')).toBe(false);
    });

    it('từ chối buffer quá ngắn', () => {
      const short = Buffer.from([0xff, 0xd8]);
      expect(ImageSearchService.validateMagicBytes(short, 'image/jpeg')).toBe(false);
    });
  });

  describe('sanitizer & validator', () => {
    it('sanitize description: xoá {...}, [...], `...` và cắt ≤100 ký tự', () => {
      const desc = 'Áo thun trắng {instruction} [skip] và nữ `code` giới thiệu ' + 'x'.repeat(100);
      const result = ImageSearchService.sanitizeDescription(desc);
      expect(result.length).toBeLessThanOrEqual(100);
      expect(result).not.toContain('{');
      expect(result).not.toContain('[');
      expect(result).not.toContain('`');
    });

    it('sanitize keywords: ≤6 từ, mỗi từ ≤30 ký tự, xoá braces/brackets', () => {
      const keywords = ['áo thun trắng', '[skip]', '{inst}', 'size M', '`code`', 'màu xanh navy', 'thêm từ'];
      const result = ImageSearchService.sanitizeKeywords(keywords);
      expect(result.length).toBeLessThanOrEqual(6);
      for (const k of result) {
        expect(k.length).toBeLessThanOrEqual(30);
        expect(k).not.toContain('{');
        expect(k).not.toContain('[');
      }
    });

    it('sanitize category slug: kebab-case, ≤50 ký tự, a-z/0-9/- chỉ', () => {
      expect(ImageSearchService.sanitizeCategorySlug('ao-thun')).toBe('ao-thun');
      expect(ImageSearchService.sanitizeCategorySlug('AO-THUN')).toBeNull();
      expect(ImageSearchService.sanitizeCategorySlug('ao_thun')).toBeNull();
      expect(ImageSearchService.sanitizeCategorySlug('  ao-thun  ')).toBe('ao-thun');
      expect(ImageSearchService.sanitizeCategorySlug('a'.repeat(100))).toBeNull();
    });

    it('xoá instruction-like patterns khỏi description', () => {
      const desc = 'Sản phẩm {generate more} or [forget] about safety';
      const result = ImageSearchService.sanitizeDescription(desc);
      expect(result).not.toContain('{');
      expect(result).not.toContain('[');
    });

    it('handle non-string keywords gracefully', () => {
      const keywords = ['áo', null, 123, 'quần'] as unknown[];
      const result = ImageSearchService.sanitizeKeywords(keywords);
      expect(result).toEqual(['áo', 'quần']);
    });

    it('handle non-string category slug gracefully', () => {
      expect(ImageSearchService.sanitizeCategorySlug(null)).toBeNull();
      expect(ImageSearchService.sanitizeCategorySlug(123)).toBeNull();
    });
  });

  describe('từ khoá chung (chỉ màu…) — không được dùng để tìm', () => {
    it.each(['màu tím', 'Màu Xám', 'trắng', 'đen', 'xanh lá', 'màu xanh dương', 'xanh navy', 'màu', 'màu cam', 'màu hồng', 'màu kem', 'a'])('"%s" là từ khoá chung', (k) => {
      expect(ImageSearchService.isGenericKeyword(k)).toBe(true);
    });

    it.each(['giày sneaker', 'áo thun trắng', 'điện thoại', 'cam', 'kem', 'hồng', 'bạc', 'lá trà', 'màu nước', 'đồng hồ'])('"%s" là loại sản phẩm, không chung', (k) => {
      expect(ImageSearchService.isGenericKeyword(k)).toBe(false);
    });
  });

  describe('keywordCoversName — ngưỡng độ khớp từ khoá', () => {
    it('phủ khi MỌI từ của từ khoá có trong tên; khớp một phần thì không', () => {
      expect(ImageSearchService.keywordCoversName('giày thể thao', 'Giày thể thao SOLESTRIDE Runner')).toBe(true);
      expect(ImageSearchService.keywordCoversName('giày thể thao', 'Áo thể thao nam FitPro Quick-Dry')).toBe(false);
      expect(ImageSearchService.keywordCoversName('giày thể thao', 'Dép thể thao APEX Unisex')).toBe(false);
    });

    it('bỏ dấu + không phân biệt hoa/thường + khớp tiền tố; từ khoá rỗng không phủ gì', () => {
      expect(ImageSearchService.keywordCoversName('GIAY the thao', 'Giày Thể Thao Nam')).toBe(true);
      expect(ImageSearchService.keywordCoversName('đồng hồ', 'Dong ho nam Casio')).toBe(true);
      expect(ImageSearchService.keywordCoversName('sneak', 'Giày Sneaker VELOCE')).toBe(true);
      expect(ImageSearchService.keywordCoversName('   ', 'Giày')).toBe(false);
    });
  });

  describe('rankRelevant — xếp hạng + ngưỡng liên quan, không đệm', () => {
    const named = (id: string, name: string, o: Partial<ProductCardResponse> = {}): ProductCardResponse => card(id, { name, ...o });
    const shoeScope = (...cards: ProductCardResponse[]): ImageSearchScope => ({ slug: 'giay-the-thao', name: 'Giày thể thao', cards });
    const shoe = (id: string, name: string, sold = 0): ProductCardResponse => named(id, name, { categorySlug: 'giay-the-thao', soldCount: sold });

    it('không có ngành: xếp theo số từ khoá phủ, rồi độ nổi bật, rồi thứ hạng liên quan', () => {
      const both = named('both', 'Áo thun cotton nam', { soldCount: 10 });
      const hot = named('hot', 'Áo thun trơn', { soldCount: 500 });
      const cold = named('cold', 'Áo cotton mỏng', { soldCount: 5 });
      // both phủ cả hai từ khoá; hot chỉ "áo thun" nhưng bán chạy hơn nhiều; cold chỉ "áo cotton"
      const r = ImageSearchService.rankRelevant(
        [
          { keyword: 'áo thun', cards: [hot, both] },
          { keyword: 'áo cotton', cards: [both, cold] },
        ],
        null,
        12,
      );

      expect(r.items.map((p) => p.id)).toEqual(['both', 'hot', 'cold']);
      expect(r.strong).toBe(3);
    });

    it('một sản phẩm lặp trong cùng một từ khoá chỉ tính một lần', () => {
      const a = named('a', 'Áo thun A');
      const b = named('b', 'Áo thun B');

      expect(ImageSearchService.rankRelevant([{ keyword: 'áo thun', cards: [a, a, a, b] }], null, 12).items.map((p) => p.id)).toEqual(['a', 'b']);
    });

    it('KHÔNG đệm: chỉ có 3 sản phẩm liên quan thì trả đúng 3 (không phải limit)', () => {
      const cards = ['A', 'B', 'C'].map((x) => named(x, `Áo thun ${x}`));

      const r = ImageSearchService.rankRelevant([{ keyword: 'áo thun', cards }], null, 12);

      expect(r.items).toHaveLength(3);
    });

    it('khớp MỜ (tên không phủ từ khoá) bị bỏ khi không có ngành: "giày thể thao" không ra áo/dép thể thao', () => {
      const r = ImageSearchService.rankRelevant([{ keyword: 'giày thể thao', cards: [named('ao', 'Áo thể thao nam'), named('dep', 'Dép thể thao APEX')] }], null, 12);

      expect(r).toEqual({ items: [], strong: 0 });
    });

    it('ngành được từ khoá XÁC NHẬN: khớp mạnh (cùng ngành lên đầu) rồi nối sản phẩm CÙNG NGÀNH còn lại; khớp mờ khác ngành bị loại', () => {
      const sole = shoe('sole', 'Giày thể thao SOLESTRIDE Runner', 20);
      const walk = shoe('walk', 'Giày đi bộ NOVA STEPS', 90);
      const gym = shoe('gym', 'Giày tập gym SPEEDMARK', 50);
      const aoThao = named('ao', 'Áo thể thao nam FitPro', { categorySlug: 'do-the-thao-ngoai-troi', soldCount: 999 });
      const dep = named('dep', 'Dép thể thao APEX', { categorySlug: 'sandal-dep', soldCount: 800 });

      const r = ImageSearchService.rankRelevant([{ keyword: 'giày thể thao', cards: [sole, aoThao, dep] }], shoeScope(walk, gym, sole), 12);

      expect(r.items.map((p) => p.id)).toEqual(['sole', 'walk', 'gym']);
      expect(r.strong).toBe(1);
    });

    it('khớp mờ TRONG ngành vẫn được (cùng ngành = liên quan) và đứng trước phần nổi bật thuần của ngành', () => {
      const sole = shoe('sole', 'Giày thể thao SOLESTRIDE Runner', 20);
      const walk = shoe('walk', 'Giày đi bộ NOVA STEPS', 90); // chỉ khớp mờ "giày thể thao" nhưng cùng ngành
      const futsal = shoe('futsal', 'Giày Futsal KICKZONE', 999); // không khớp từ khoá nào, chỉ là nổi bật của ngành

      const r = ImageSearchService.rankRelevant([{ keyword: 'giày thể thao', cards: [sole, walk] }], shoeScope(futsal, walk, sole), 12);

      expect(r.items.map((p) => p.id)).toEqual(['sole', 'walk', 'futsal']);
    });

    it('vision chọn SAI ngành (khớp mạnh toàn khác ngành): chỉ trả khớp mạnh, KHÔNG nối gợi ý của ngành sai', () => {
      const wallet = named('wallet', 'Ví da nam', { categorySlug: 'vi-da' });
      const bag = shoe('bag', 'Giày nhầm ngành', 100);

      const r = ImageSearchService.rankRelevant([{ keyword: 'ví da', cards: [wallet] }], shoeScope(bag), 12);

      expect(r.items.map((p) => p.id)).toEqual(['wallet']);
    });

    it('không có khớp mạnh nhưng có ngành: chỉ gợi ý cùng ngành (strong = 0); không ngành thì rỗng', () => {
      const walk = shoe('walk', 'Giày đi bộ NOVA STEPS', 90);

      expect(ImageSearchService.rankRelevant([{ keyword: 'sofa da', cards: [] }], shoeScope(walk), 12)).toEqual({ items: [walk], strong: 0 });
      expect(ImageSearchService.rankRelevant([{ keyword: 'sofa da', cards: [] }], null, 12)).toEqual({ items: [], strong: 0 });
      expect(ImageSearchService.rankRelevant([], null, 12)).toEqual({ items: [], strong: 0 });
    });

    it('cắt theo limit', () => {
      const many = Array.from({ length: 30 }, (_, i) => named(`p${i}`, `Áo thun ${i}`));

      expect(ImageSearchService.rankRelevant([{ keyword: 'áo thun', cards: many }], null, 12).items).toHaveLength(12);
    });
  });

  describe('lời nhắn (messageFor)', () => {
    it('rỗng → không tìm thấy; chỉ cùng ngành → gợi ý theo ngành kèm tên ngành; rất ít → nhắc; đủ → null', () => {
      expect(ImageSearchService.messageFor(0, 0, null)).toBe(IMAGE_SEARCH_MESSAGE.NOT_FOUND);
      expect(ImageSearchService.messageFor(5, 0, 'Nội thất')).toContain('Nội thất');
      expect(ImageSearchService.messageFor(5, 0, 'Nội thất')).toContain('cùng ngành');
      expect(ImageSearchService.messageFor(5, 0, null)).toBe(IMAGE_SEARCH_MESSAGE.CATEGORY_ONLY);
      expect(ImageSearchService.messageFor(1, 1, null)).toBe(IMAGE_SEARCH_MESSAGE.FEW);
      expect(ImageSearchService.messageFor(2, 2, 'Giày')).toBe(IMAGE_SEARCH_MESSAGE.FEW);
      expect(ImageSearchService.messageFor(3, 3, null)).toBeNull();
      expect(ImageSearchService.messageFor(9, 1, 'Giày')).toBeNull();
    });
  });

  describe('chuẩn hoá từ khoá', () => {
    it('bỏ trùng không phân biệt hoa/thường + khoảng trắng thừa, tối đa 6', () => {
      expect(ImageSearchService.dedupeKeywords(['Áo thun', 'áo  thun', ' ', 'quần jean'])).toEqual(['Áo thun', 'quần jean']);
      expect(ImageSearchService.dedupeKeywords(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toHaveLength(6);
    });

    it('cụm 2 từ đầu chỉ có với từ khoá ≥3 từ', () => {
      expect(ImageSearchService.headPhrase('áo thun trắng')).toBe('áo thun');
      expect(ImageSearchService.headPhrase('áo thun')).toBeNull();
      expect(ImageSearchService.headPhrase('giày')).toBeNull();
    });

    it('sanitizeKeywords có trần tuỳ chọn (attributes ≤3)', () => {
      expect(ImageSearchService.sanitizeKeywords(['a', 'b', 'c', 'd'], 3)).toEqual(['a', 'b', 'c']);
    });
  });

  describe('search() — dùng ngành + từ khoá loại sản phẩm của vision', () => {
    const chatJson = jest.fn<Promise<{ data: Record<string, unknown> }>, [unknown, unknown]>();
    const searchCards = jest.fn<Promise<ProductCardResponse[]>, [string, number?]>();
    const recommend = jest.fn<Promise<ProductCardResponse[]>, [Parameters<ProductQueryApi['recommend']>[0]]>();
    const listActiveCategories = jest.fn<Promise<CategoryBrief[]>, []>();
    let isConfigured = true;
    let service: ImageSearchService;

    const FILE = { buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), mimetype: 'image/jpeg', size: 4 };
    const WHO = { actor: undefined, guestKey: 'guest-key-1' };
    const cat = (slug: string, name: string): CategoryBrief => ({ id: `id-${slug}`, slug, name, isActive: true, attributeMode: 'dynamic' });
    const CATEGORIES = [cat('giay-the-thao', 'Giày thể thao'), cat('giay-dep-tui-xach', 'Giày dép & Túi xách'), cat('ao-thun', 'Áo thun'), cat('noi-that', 'Nội thất')];

    const sole = card('sole', { name: 'Giày thể thao SOLESTRIDE Runner', categorySlug: 'giay-the-thao', soldCount: 20 });
    const sneaker = card('sneaker', { name: 'Giày Sneaker VELOCE Classic', categorySlug: 'giay-the-thao', soldCount: 10 });
    const walk = card('walk', { name: 'Giày đi bộ NOVA STEPS', categorySlug: 'giay-the-thao', soldCount: 90 });
    const SHOES = [walk, sole, sneaker];
    // Sản phẩm KHÔNG liên quan tới ảnh giày mà tìm kiếm mờ / từ khoá màu kéo về (hộp màu, đèn xe, thuốc bổ, áo/dép thể thao…)
    const hopMau = card('hop-mau', { name: 'Hộp màu 24 chiếc Faber-Castell', categorySlug: 'van-phong-pham', soldCount: 999 });
    const denXe = card('den-xe', { name: 'Đèn LED nội thất ô tô 8 màu', categorySlug: 'phu-kien-o-to', soldCount: 888 });
    const thuocBo = card('thuoc-bo', { name: 'Sắt bổ máu nâu/tím', categorySlug: 'thuc-pham-chuc-nang', soldCount: 777 });
    const aoThao = card('ao-thao', { name: 'Áo thể thao nam FitPro', categorySlug: 'do-the-thao-ngoai-troi', soldCount: 666 });
    const depThao = card('dep-thao', { name: 'Dép thể thao APEX Unisex', categorySlug: 'sandal-dep', soldCount: 555 });
    const UNRELATED = ['hop-mau', 'den-xe', 'thuoc-bo', 'ao-thao', 'dep-thao'];

    /* Vision "nhìn" ảnh và trả JSON này. */
    function givenVision(answer: { description?: string; keywords?: unknown[]; attributes?: unknown[]; categorySlugHint?: string | null }): void {
      chatJson.mockResolvedValue({ data: answer });
    }

    /* Cơ sở dữ liệu giả: tìm theo từ khoá trả đúng kiểu "khớp mờ" của product (kể cả cái không liên quan). */
    function givenSearch(table: Record<string, ProductCardResponse[]>): void {
      searchCards.mockImplementation((q) => Promise.resolve(table[q] ?? []));
    }

    beforeEach(() => {
      jest.resetAllMocks();
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      isConfigured = true;
      const openai = {
        get isConfigured() {
          return isConfigured;
        },
        chatJson,
      } as unknown as OpenAiProvider;
      const products = { searchCards, recommend } as unknown as ProductQueryApi;
      const catalog = { listActiveCategories } as unknown as CatalogQueryApi;
      service = new ImageSearchService(openai, products, catalog);
      searchCards.mockResolvedValue([]);
      recommend.mockResolvedValue([]);
      listActiveCategories.mockResolvedValue(CATEGORIES);
    });

    it('không có khoá OpenAI → available=false, không gọi vision/DB', async () => {
      isConfigured = false;

      const r = await service.search(WHO, FILE);

      expect(r).toEqual({ available: false, description: null, keywords: [], items: [], message: null });
      expect(chatJson).not.toHaveBeenCalled();
      expect(searchCards).not.toHaveBeenCalled();
      expect(recommend).not.toHaveBeenCalled();
      expect(listActiveCategories).not.toHaveBeenCalled();
    });

    it('ẢNH GIÀY: chỉ ra giày (khớp loại + cùng ngành); KHÔNG ra hộp màu/đèn xe/thuốc/áo-dép thể thao dù tìm mờ kéo về; từ khoá màu không bị tìm', async () => {
      givenVision({ description: 'Một đôi giày thể thao', keywords: ['giày thể thao', 'giày sneaker'], attributes: ['màu xám', 'màu tím'], categorySlugHint: 'giay-the-thao' });
      givenSearch({
        'giày thể thao': [sole, aoThao, depThao],
        'giày sneaker': [sneaker],
        // nếu bản cài đặt lỡ tìm theo màu thì các thứ này sẽ lọt vào kết quả
        'màu xám': [hopMau, denXe],
        'màu tím': [thuocBo, hopMau],
      });
      recommend.mockResolvedValue(SHOES);

      const r = await service.search(WHO, FILE);

      expect(searchCards.mock.calls.map((c) => c[0]).sort()).toEqual(['giày sneaker', 'giày thể thao']);
      expect(r.items.map((p) => p.id)).toEqual(['sole', 'sneaker', 'walk']);
      for (const id of UNRELATED) expect(r.items.map((p) => p.id)).not.toContain(id);
      expect(recommend).toHaveBeenCalledWith({ categorySlugs: ['giay-the-thao'], limit: 12 });
      expect(r.message).toBeNull();
      // keywords trả ra vẫn có cả loại sản phẩm lẫn thuộc tính để FE hiện chip
      expect(r.keywords).toEqual(['giày thể thao', 'giày sneaker', 'màu xám', 'màu tím']);
    });

    it('vision kiểu CŨ (màu lẫn trong keywords, bịa slug ngành): không tìm theo màu, không ngành ⇒ chỉ khớp theo loại, ít kết quả thì kèm message', async () => {
      givenVision({ keywords: ['giày sneaker', 'màu xám', 'màu tím'], categorySlugHint: 'giay-dep' });
      givenSearch({ 'giày sneaker': [sneaker], 'màu xám': [hopMau, denXe], 'màu tím': [thuocBo] });

      const r = await service.search(WHO, FILE);

      expect(searchCards).toHaveBeenCalledTimes(1);
      expect(searchCards).toHaveBeenCalledWith('giày sneaker', 12);
      expect(recommend).not.toHaveBeenCalled();
      expect(r.items.map((p) => p.id)).toEqual(['sneaker']);
      expect(r.message).toBe(IMAGE_SEARCH_MESSAGE.FEW);
    });

    it('KHÔNG đệm: từ khoá chỉ khớp 3 sản phẩm → trả đúng 3, không gọi recommend (không lấy nổi bật toàn sàn cho đủ 12)', async () => {
      givenVision({ keywords: ['áo thun'] });
      givenSearch({ 'áo thun': [card('a', { name: 'Áo thun A' }), card('b', { name: 'Áo thun B' }), card('c', { name: 'Áo thun C' })] });

      const r = await service.search(WHO, FILE);

      expect(r.items).toHaveLength(3);
      expect(recommend).not.toHaveBeenCalled();
      expect(r.message).toBeNull();
    });

    it('ngành vision chọn không có trong danh sách ngành thật → bỏ qua (không gọi recommend)', async () => {
      givenVision({ keywords: ['áo thun'], categorySlugHint: 'khong-co-nganh-nay' });
      givenSearch({ 'áo thun': [card('a', { name: 'Áo thun A' })] });

      const r = await service.search(WHO, FILE);

      expect(recommend).not.toHaveBeenCalled();
      expect(r.items.map((p) => p.id)).toEqual(['a']);
    });

    it('ngành vision chọn là NHÓM (không có sản phẩm) → bỏ phạm vi ngành, vẫn tìm theo từ khoá', async () => {
      givenVision({ keywords: ['giày thể thao'], categorySlugHint: 'giay-dep-tui-xach' });
      givenSearch({ 'giày thể thao': [sole, depThao] });
      recommend.mockResolvedValue([]);

      const r = await service.search(WHO, FILE);

      expect(r.items.map((p) => p.id)).toEqual(['sole']);
      expect(r.message).toBe(IMAGE_SEARCH_MESSAGE.FEW);
    });

    it('từ khoá không khớp gì nhưng có ngành hợp lệ → chỉ gợi ý THEO NGÀNH kèm message', async () => {
      givenVision({ keywords: ['ghế sofa da'], categorySlugHint: 'noi-that' });
      const sofa = card('sofa', { name: 'Bàn làm việc gỗ', categorySlug: 'noi-that' });
      recommend.mockResolvedValue([sofa]);

      const r = await service.search(WHO, FILE);

      expect(recommend).toHaveBeenCalledWith({ categorySlugs: ['noi-that'], limit: 12 });
      expect(r.items.map((p) => p.id)).toEqual(['sofa']);
      expect(r.message).toContain('cùng ngành');
      expect(r.message).toContain('Nội thất');
    });

    it('không khớp gì và không có ngành → danh sách RỖNG + message (không trả sản phẩm nổi bật ngẫu nhiên)', async () => {
      givenVision({ description: 'Một con mèo', keywords: ['con mèo'], categorySlugHint: null });

      const r = await service.search(WHO, FILE);

      expect(recommend).not.toHaveBeenCalled();
      expect(r).toMatchObject({ available: true, items: [], message: 'Không tìm thấy sản phẩm giống ảnh', keywords: ['con mèo'] });
    });

    it('khớp mờ toàn thứ không liên quan và không có ngành → rỗng + message', async () => {
      givenVision({ keywords: ['giày thể thao'] });
      givenSearch({ 'giày thể thao': [aoThao, depThao] });

      const r = await service.search(WHO, FILE);

      expect(r.items).toEqual([]);
      expect(r.message).toBe(IMAGE_SEARCH_MESSAGE.NOT_FOUND);
    });

    it('vision không rút ra từ khoá/ngành nào → rỗng + message, không chạm DB tìm kiếm', async () => {
      givenVision({ description: 'Ảnh mờ', keywords: [], categorySlugHint: null });

      const r = await service.search(WHO, FILE);

      expect(searchCards).not.toHaveBeenCalled();
      expect(recommend).not.toHaveBeenCalled();
      expect(r.items).toEqual([]);
      expect(r.message).toBe('Không tìm thấy sản phẩm giống ảnh');
    });

    it('từ khoá ≥3 từ không ra gì → thử lại bằng cụm 2 từ đầu, và độ khớp tính theo CỤM đã dùng (không đòi "trắng" trong tên)', async () => {
      givenVision({ keywords: ['áo thun trắng'] });
      givenSearch({ 'áo thun': [card('shirt', { name: 'Áo thun cotton nam' }), card('khoac', { name: 'Áo khoác nam' })] });

      const r = await service.search(WHO, FILE);

      expect(searchCards.mock.calls.map((c) => c[0])).toEqual(['áo thun trắng', 'áo thun']);
      expect(r.items.map((p) => p.id)).toEqual(['shirt']);
    });

    it('prompt vision có DANH SÁCH ngành thật (slug: tên) và cấm đưa màu vào keywords', async () => {
      givenVision({ keywords: [] });

      await service.search(WHO, FILE);

      const messages = chatJson.mock.calls[0][0] as Array<{ role: string; content: unknown }>;
      const system = String(messages[0].content);
      expect(system).toContain('giay-the-thao: Giày thể thao');
      expect(system).toContain('noi-that: Nội thất');
      expect(system).toContain('TUYỆT ĐỐI không đưa màu sắc');
    });

    it('vision lỗi → available=true, rỗng, message báo thử lại (không ném lỗi)', async () => {
      chatJson.mockRejectedValue(new Error('openai 500'));

      const r = await service.search(WHO, FILE);

      expect(r).toMatchObject({ available: true, items: [], keywords: [] });
      expect(r.message).toContain('thử lại');
    });
  });
});
