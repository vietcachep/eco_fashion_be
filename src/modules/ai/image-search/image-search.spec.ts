import type { Env } from '@config/env';
import type { ProductCardResponse, ProductQueryApi } from '@modules/product/queryapi/product.queryapi';
import type { OpenAiProvider } from '../provider/openai.provider';
import { ImageSearchService } from './image-search.service';
import type { VisualIndexService } from './visual-index.service';
import { normaliseVisualVector, parseVisualRegions } from './visual.types';

const phone = {
  id: 'phone',
  name: 'iPhone 16',
  imageUrl: '/static/black.jpg',
  categorySlug: 'dien-thoai',
  soldCount: 0,
} as ProductCardResponse;
const file = { buffer: Buffer.from([255, 216, 255]), mimetype: 'image/jpeg', size: 3 };
function fixture() {
  const hit = {
    productId: 'phone',
    imageId: 'img',
    sourceUrl: '/static/white.jpg',
    colorCode: 'white',
    similarity: 0.9,
  };
  const chatJson = jest
    .fn()
    .mockResolvedValueOnce({
      data: {
        description: 'Điện thoại trắng',
        keywords: ['điện thoại'],
        attributes: ['trắng'],
        ocr: ['iPhone 16'],
      },
    })
    .mockResolvedValue({
      data: { matches: [{ id: 'phone', relevance: 'similar', reason: 'Giống hình dáng và màu trắng.' }] },
    });
  const openai = { isConfigured: true, chatJson };
  const products = {
    searchCards: jest.fn(() => Promise.resolve([] as ProductCardResponse[])),
    cardsByIds: jest.fn(() => Promise.resolve([phone])),
    visualImageSources: jest.fn(() =>
      Promise.resolve([
        { id: 'phone', images: [{ id: 'img', url: '/static/white.jpg', colorCode: 'white' }] },
      ]),
    ),
  };
  const visual = {
    encoder: { configured: true },
    retrieve: jest.fn(() => Promise.resolve([hit])),
    images: { download: jest.fn(() => Promise.resolve(file)) },
  };
  const env = {
    EF_OPENAI_VISION_MODEL: 'test',
    EF_VISUAL_RERANK: true,
    EF_VISUAL_MIN_SIMILARITY: 0.65,
  } as Env;
  const service = new ImageSearchService(
    openai as unknown as OpenAiProvider,
    products as unknown as ProductQueryApi,
    visual as unknown as VisualIndexService,
    env,
  );
  return { service, openai, products, visual, env, hit, chatJson };
}
describe('PLAN-0044 visual search', () => {
  it('điện thoại tìm bằng ảnh dù tên iPhone không chứa từ điện thoại; dùng ảnh trắng đã khớp', async () => {
    const f = fixture();
    const r = await f.service.search({}, file);
    expect(r.searchMode).toBe('hybrid');
    expect(r.items).toHaveLength(1);
    expect(r.items[0].imageUrl).toBe('/static/white.jpg');
    expect(r.matches?.[0]).toMatchObject({ colorCode: 'white', relevance: 'similar' });
    expect(f.products.searchCards).toHaveBeenCalledWith('iPhone 16', 10);
  });
  it('rerank xác nhận không có món phù hợp thì không bù kết quả vector', async () => {
    const f = fixture();
    f.chatJson
      .mockReset()
      .mockResolvedValueOnce({ data: { keywords: ['điện thoại'] } })
      .mockResolvedValueOnce({ data: { matches: [] } });
    expect((await f.service.search({}, file)).items).toEqual([]);
  });
  it('AI không được bịa productId hoặc lặp một sản phẩm', async () => {
    const f = fixture();
    f.chatJson
      .mockReset()
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValue({
        data: {
          matches: [
            { id: 'missing', relevance: 'similar', reason: 'bịa' },
            { id: 'phone', relevance: 'similar', reason: 'giống' },
            { id: 'phone', relevance: 'similar', reason: 'trùng' },
          ],
        },
      });
    expect((await f.service.search({}, file)).items.map((p) => p.id)).toEqual(['phone']);
  });
  it('shop/sản phẩm bị ẩn sau truy hồi bị loại trước gửi ảnh cho rerank', async () => {
    const f = fixture();
    f.products.cardsByIds.mockResolvedValue([]);
    expect((await f.service.search({}, file)).items).toEqual([]);
    expect(f.visual.images.download).not.toHaveBeenCalled();
  });
  it('ảnh chỉ mục đã đổi không dùng ảnh cũ cho card', async () => {
    const f = fixture();
    f.hit.sourceUrl = '/static/outdated.jpg';
    f.env.EF_VISUAL_RERANK = false;
    expect((await f.service.search({}, file)).items).toEqual([]);
  });
  it('rerank lỗi chỉ trả vector đủ ngưỡng và giải thích chế độ dự phòng', async () => {
    const f = fixture();
    f.chatJson.mockReset().mockResolvedValueOnce({ data: {} }).mockRejectedValue(new Error('provider down'));
    const r = await f.service.search({}, file);
    expect(r.items).toHaveLength(1);
    expect(r.searchMode).toBe('visual');
    expect(r.message).toContain('chưa có bước');
  });
  it('vector yếu không lấp đầy kết quả khi không rerank được', async () => {
    const f = fixture();
    f.hit.similarity = 0.4;
    f.env.EF_VISUAL_RERANK = false;
    expect((await f.service.search({}, file)).items).toEqual([]);
  });
  it('không key OpenAI vẫn tìm bằng ảnh, không bắt buộc vision', async () => {
    const f = fixture();
    f.openai.isConfigured = false;
    const r = await f.service.search({}, file);
    expect(r.items).toHaveLength(1);
    expect(r.searchMode).toBe('visual');
    expect(f.chatJson).not.toHaveBeenCalled();
  });
  it('không encoder chỉ tìm theo mô tả khi có so ảnh ứng viên và báo degraded', async () => {
    const f = fixture();
    f.visual.encoder.configured = false;
    f.products.searchCards.mockResolvedValue([phone]);
    const r = await f.service.search({}, file);
    expect(r.searchMode).toBe('description');
    expect(r.items).toHaveLength(1);
    expect(r.message).toContain('chỉ mục ảnh chưa sẵn sàng');
  });
  it('không encoder/không key thì unavailable, không bịa sản phẩm', async () => {
    const f = fixture();
    f.visual.encoder.configured = false;
    f.openai.isConfigured = false;
    expect(await f.service.search({}, file)).toMatchObject({ available: false, items: [] });
  });
  it('ảnh người mặc đồ trả vùng áo/quần hợp lệ; vùng ngoài ảnh bị bỏ', async () => {
    const f = fixture();
    f.chatJson.mockReset().mockResolvedValue({
      data: {
        regions: [
          { label: 'Áo', x: 0.2, y: 0.2, width: 0.5, height: 0.3 },
          { label: 'Quần', x: 0.2, y: 0.5, width: 0.5, height: 0.4 },
          { label: 'Sai', x: 2, y: 0, width: 1, height: 1 },
        ],
      },
    });
    expect((await f.service.analyze(file)).regions.map((r) => r.label)).toEqual(['Áo', 'Quần']);
  });
  it('analyze lỗi vẫn cho crop thủ công', async () => {
    const f = fixture();
    f.chatJson.mockReset().mockRejectedValue(new Error('down'));
    const result = await f.service.analyze(file);
    expect(result.available).toBe(true);
    expect(result.regions).toEqual([]);
    expect(result.message).toContain('khoanh vùng');
  });
  it('vector phải đúng768 chiều, hữu hạn, khác0; chuẩn hoá không đổi hướng', () => {
    const v = Array.from({ length: 768 }, (_, i) => (i === 0 ? 2 : 0));
    expect(normaliseVisualVector(v)[0]).toBe(1);
    for (const bad of [[], [1], Array(768).fill(0), Array(768).fill(NaN)])
      expect(() => normaliseVisualVector(bad)).toThrow();
  });
  it('vùng chọn quá nhỏ, NaN, âm hay vượt ảnh không được nhận', () => {
    expect(
      parseVisualRegions([
        { x: 0, y: 0, width: 0.01, height: 1 },
        { x: -1, y: 0, width: 1, height: 1 },
        { x: 0, y: 0, width: NaN, height: 1 },
      ]),
    ).toEqual([]);
  });
  it('WEBP giả header hay PNG thiếu signature bị từ chối', () => {
    expect(ImageSearchService.validateMagicBytes(Buffer.from('RIFFxxxxxxxxNOPE'), 'image/webp')).toBe(false);
    expect(ImageSearchService.validateMagicBytes(Buffer.from([137, 80, 78, 71]), 'image/png')).toBe(false);
  });
});
