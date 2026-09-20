import { Injectable, Logger } from '@nestjs/common';
import { NotFoundException } from '@common/exception/business.exception';
import { PrismaService } from '@common/prisma/prisma.service';
import { Prisma } from '@common/prisma/types';
import { StorageService } from '@common/storage/storage.service';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CatalogQueryApi } from '../../catalog/queryapi/catalog.queryapi';
import { ProductCardResponse, ProductQueryApi } from '../../product/queryapi/product.queryapi';
import { AI_ERR, AI_FEATURE, AI_SOURCE, RULE } from '../foundation/ai.constants';
import { OpenAiProvider } from '../provider/openai.provider';

/* Kết quả phân tích — camelCase của FE `AiAnalysisResult` (dang_nguoi, mau_phu_hop, phong_cach, tu_van). */
export interface StyleAnalysisResult {
  dangNguoi: string;
  mauPhuHop: string[];
  phongCach: string;
  tuVan: string;
  gender: 'nam' | 'nu' | 'unisex';
  categories: string[];
  colorCodes: string[];
}

export interface StyleAnalysisResponse {
  id: string;
  imageUrl: string;
  analysis: StyleAnalysisResult;
  products: ProductCardResponse[];
  source: string;
  createdAt: string;
}

interface VisionAnswer {
  dangNguoi?: string;
  mauPhuHop?: string[];
  phongCach?: string;
  tuVan?: string;
  gender?: string;
  categories?: string[];
  colorCodes?: string[];
  isPerson?: boolean;
}

const CATEGORY_SLUGS = ['ao-thun', 'ao-so-mi', 'quan-jean', 'quan-short', 'vay', 'dam', 'ao-khoac'];

/*
 * Upload ảnh người → phân tích dáng/màu/phong cách → gợi ý sản phẩm (PLAN-0013). OpenAI vision trả JSON có
 * ràng buộc mã màu/ngành hàng của catalog; không key/lỗi/hết hạn mức → đường lùi rule (tư vấn chung theo giới khách chọn).
 * Ảnh lưu Cloudinary `ecofashion/ai/style`, dọn sau 7 ngày (worker). Không suy đoán tuổi/sắc tộc/sức khoẻ.
 */
@Injectable()
export class StyleAnalysisService {
  private readonly logger = new Logger(StyleAnalysisService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly openai: OpenAiProvider,
    private readonly products: ProductQueryApi,
    private readonly catalog: CatalogQueryApi,
  ) {}

  async analyze(who: { actor?: AuthenticatedActor; guestKey?: string | null }, file: { buffer: Buffer; mimetype: string; size: number }, hint: { gender?: string | null; occasion?: string | null }): Promise<StyleAnalysisResponse> {
    const uploaded = await this.storage.uploadImage(file, 'ai/style');
    const colors = await this.catalog.colorMap();
    let result: StyleAnalysisResult | null = null;
    let source: string = AI_SOURCE.RULE;
    if (this.openai.isConfigured) {
      try {
        result = await this.analyzeWithVision(uploaded.url, colors, hint, who.actor?.userId ?? null);
        source = AI_SOURCE.LLM;
      } catch (err) {
        this.logger.warn({ err: (err as Error).message }, 'Vision lỗi — dùng đường lùi rule');
      }
    }
    result ??= StyleAnalysisService.ruleResult(hint, colors);
    const products = await this.recommend(result, who.actor?.userId ?? null);
    const saved = await this.prisma.styleAnalysis.create({ data: { userId: who.actor?.userId ?? null, guestKey: who.actor ? null : (who.guestKey ?? null), imageUrl: uploaded.url, imagePublicId: uploaded.publicId, result: result as unknown as Prisma.InputJsonObject, productIds: products.map((p) => p.id), source } });
    this.logger.log({ id: saved.id, source, products: products.length, userId: who.actor?.userId ?? null }, 'Phân tích phong cách xong');
    return { id: saved.id, imageUrl: uploaded.url, analysis: result, products, source, createdAt: saved.createdAt.toISOString() };
  }

  async get(who: { actor?: AuthenticatedActor; guestKey?: string | null }, id: string): Promise<StyleAnalysisResponse> {
    const r = await this.prisma.styleAnalysis.findFirst({ where: { id, ...(who.actor ? { userId: who.actor.userId } : { guestKey: who.guestKey ?? '-' }) } });
    if (!r) throw new NotFoundException(AI_ERR.SESSION_NOT_FOUND, 'Không tìm thấy kết quả phân tích');
    const products = await this.products.cardsByIds(Array.isArray(r.productIds) ? (r.productIds as string[]) : []);
    return { id: r.id, imageUrl: r.imageUrl, analysis: r.result as unknown as StyleAnalysisResult, products, source: r.source, createdAt: r.createdAt.toISOString() };
  }

  private async analyzeWithVision(imageUrl: string, colors: Map<string, { code: string; name: string }>, hint: { gender?: string | null; occasion?: string | null }, userId: string | null): Promise<StyleAnalysisResult> {
    const colorList = [...colors.values()].map((c) => `${c.code}=${c.name}`).join(', ');
    const system = [
      'Bạn là stylist của cửa hàng thời trang Việt Nam. Nhìn ảnh người (toàn thân hoặc nửa người) và tư vấn trang phục.',
      'KHÔNG suy đoán tuổi, sắc tộc, sức khoẻ, cân nặng cụ thể; chỉ mô tả dáng tổng quát (gầy/cân đối/đầy đặn, cao/thấp tương đối) và tông màu da (sáng/trung tính/ngăm) để chọn màu.',
      `Mã màu cửa hàng có: ${colorList}. Ngành hàng: ${CATEGORY_SLUGS.join(', ')}.`,
      'TRẢ VỀ JSON: {"isPerson": boolean, "dangNguoi": string (≤ 60 ký tự), "mauPhuHop": string[] (3-5 tên màu tiếng Việt), "colorCodes": string[] (mã màu tương ứng trong danh sách), "phongCach": string (≤ 40 ký tự, vd "Minimalist & Casual"), "tuVan": string (2-4 câu tiếng Việt, gợi ý kiểu dáng phù hợp), "gender": "nam"|"nu"|"unisex", "categories": string[] (2-4 slug ngành hàng nên ưu tiên)}.',
      'Nếu ảnh không có người, đặt isPerson=false và vẫn điền tư vấn chung.',
    ].join('\n');
    const user = `Khách ${hint.gender === 'nam' ? 'là nam' : hint.gender === 'nu' ? 'là nữ' : 'chưa cho biết giới'}${hint.occasion ? `, dịp mặc: ${hint.occasion}` : ''}. Hãy phân tích ảnh và trả JSON.`;
    const res = await this.openai.visionJson<VisionAnswer>(imageUrl, system, user, { feature: AI_FEATURE.STYLE, userId });
    const d = res.data;
    const gender = (['nam', 'nu', 'unisex'].includes(d.gender ?? '') ? d.gender : (hint.gender ?? 'unisex')) as StyleAnalysisResult['gender'];
    const colorCodes = (d.colorCodes ?? []).filter((c) => colors.has(c));
    const categories = (d.categories ?? []).filter((c) => CATEGORY_SLUGS.includes(c));
    const fallback = StyleAnalysisService.ruleResult({ gender }, colors);
    return {
      dangNguoi: (d.dangNguoi ?? fallback.dangNguoi).slice(0, 80),
      mauPhuHop: (d.mauPhuHop?.length ? d.mauPhuHop : colorCodes.map((c) => colors.get(c)?.name ?? c)).slice(0, 5),
      phongCach: (d.phongCach ?? fallback.phongCach).slice(0, 60),
      tuVan: (d.isPerson === false ? 'Mình chưa nhận ra người trong ảnh, nên tư vấn dưới đây là gợi ý chung. ' : '') + (d.tuVan ?? fallback.tuVan).slice(0, 800),
      gender,
      categories: categories.length ? categories : fallback.categories,
      colorCodes: colorCodes.length ? colorCodes : fallback.colorCodes,
    };
  }

  /* Đường lùi: tư vấn an toàn theo giới (không nhìn ảnh). */
  static ruleResult(hint: { gender?: string | null; occasion?: string | null }, colors: Map<string, { code: string; name: string }>): StyleAnalysisResult {
    const gender = (hint.gender === 'nam' || hint.gender === 'nu' ? hint.gender : 'unisex');
    const codes = gender === 'nam' ? ['trang', 'den', 'xanh', 'denim'] : gender === 'nu' ? ['trang', 'be', 'hong', 'denim'] : ['trang', 'den', 'be', 'denim'];
    const categories = gender === 'nam' ? ['ao-thun', 'ao-so-mi', 'quan-jean'] : gender === 'nu' ? ['ao-thun', 'dam', 'vay', 'quan-jean'] : ['ao-thun', 'quan-jean', 'ao-khoac'];
    return {
      dangNguoi: 'Dáng cân đối',
      mauPhuHop: codes.map((c) => colors.get(c)?.name ?? RULE.COLOR.find((x) => x.code === c)?.words[0] ?? c),
      phongCach: 'Minimalist & Casual',
      tuVan: `Các tông trung tính (trắng, đen, be) và denim dễ phối, hợp hầu hết dáng người${hint.occasion ? ` và dịp ${hint.occasion}` : ''}. Chọn áo vừa vặn, quần ống đứng hoặc thẳng để tôn dáng; thêm một món điểm nhấn màu nổi nếu muốn nổi bật.`,
      gender,
      categories,
      colorCodes: codes,
    };
  }

  /* Sản phẩm theo kết quả: đúng màu + ngành trước, thiếu thì nới màu, rồi nới ngành — tối đa 8, không trùng. */
  private async recommend(r: StyleAnalysisResult, _userId: string | null): Promise<ProductCardResponse[]> {
    const out: ProductCardResponse[] = [];
    const push = (cards: ProductCardResponse[]) => {
      for (const c of cards) if (!out.some((x) => x.id === c.id) && out.length < 8) out.push(c);
    };
    push(await this.products.recommend({ gender: r.gender === 'unisex' ? null : r.gender, categorySlugs: r.categories, colorCodes: r.colorCodes, limit: 8 }));
    if (out.length < 6) push(await this.products.recommend({ gender: r.gender === 'unisex' ? null : r.gender, categorySlugs: r.categories, excludeIds: out.map((x) => x.id), limit: 8 - out.length }));
    if (out.length < 6) push(await this.products.recommend({ gender: r.gender === 'unisex' ? null : r.gender, excludeIds: out.map((x) => x.id), limit: 8 - out.length }));
    return out;
  }
}
