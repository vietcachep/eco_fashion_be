import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { CacheService } from '@common/cache/cache.service';
import { ForbiddenException, NotFoundException } from '@common/exception/business.exception';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { ShopContextGuard } from '@modules/shop/security/shop-context.guard';
import type { RequestWithShop } from '@modules/shop/security/shop-permission.decorator';
import type { CategoryAttributeRepository, CategoryAttributeWithDetailsRow } from '../../category-attribute/repository/category-attribute.repository';
import type { CategoryRepository, CategoryRow } from '../../category/repository/category.repository';
import { ShopCatalogController } from '../controller/shop-catalog.controller';
import { ShopCatalogService } from './shop-catalog.service';

function category(over: Partial<CategoryRow> & Pick<CategoryRow, 'id' | 'name'>): CategoryRow {
  return { slug: over.id, description: null, imageUrl: null, imagePublicId: null, parentId: null, sortOrder: 0, isActive: true, productCount: 0, attributeMode: 'dynamic', createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'), ...over };
}

describe('ShopCatalogService (H2 — vendor đọc ngành + mẫu thuộc tính)', () => {
  const listAll = jest.fn<ReturnType<CategoryRepository['listAll']>, Parameters<CategoryRepository['listAll']>>();
  const findBySlug = jest.fn<ReturnType<CategoryRepository['findBySlug']>, Parameters<CategoryRepository['findBySlug']>>();
  const getByCategoryId = jest.fn<ReturnType<CategoryAttributeRepository['getByCategoryId']>, Parameters<CategoryAttributeRepository['getByCategoryId']>>();
  /* Cache giả: luôn miss → chạy loader (kiểm logic dựng dữ liệu, không kiểm Redis). */
  const getOrSet = jest.fn(async (_spec: unknown, _key: string, loader: () => Promise<unknown>) => loader());
  let service: ShopCatalogService;

  beforeEach(() => {
    jest.resetAllMocks();
    getOrSet.mockImplementation(async (_spec, _key, loader) => loader());
    service = new ShopCatalogService({ listAll, findBySlug } as unknown as CategoryRepository, { getByCategoryId } as unknown as CategoryAttributeRepository, { getOrSet } as unknown as CacheService);
  });

  describe('listLeaves', () => {
    it('chỉ ngành LÁ đang bật, kèm tên ngành cha + đường dẫn; bỏ ngành có con đang bật, ngành tắt và nhánh có tổ tiên bị tắt', async () => {
      listAll.mockResolvedValue([
        category({ id: 'dien-tu', name: 'Điện tử' }), // có con đang bật → không phải lá
        category({ id: 'dien-thoai', name: 'Điện thoại', parentId: 'dien-tu' }), // lá
        category({ id: 'laptop', name: 'Laptop', parentId: 'dien-tu', isActive: false }), // tắt
        category({ id: 'thoi-trang', name: 'Thời trang' }),
        category({ id: 'ao-thun', name: 'Áo thun', parentId: 'thoi-trang', attributeMode: 'legacy_fashion' }), // lá legacy
        category({ id: 'quan', name: 'Quần', parentId: 'thoi-trang', isActive: false }),
        category({ id: 'khac', name: 'Khác' }), // lá gốc, không cha
        category({ id: 'an', name: 'Nhánh ẩn', isActive: false }),
        category({ id: 'con-cua-an', name: 'Con của nhánh ẩn', parentId: 'an' }), // tổ tiên bị tắt → loại
        category({ id: 'chi-con-tat', name: 'Chỉ có con tắt' }), // con duy nhất đã tắt → chính nó là lá
        category({ id: 'con-tat', name: 'Con tắt', parentId: 'chi-con-tat', isActive: false }),
      ]);

      const leaves = await service.listLeaves();

      expect(leaves.map((l) => l.id).sort()).toEqual(['ao-thun', 'chi-con-tat', 'dien-thoai', 'khac']);
      expect(leaves.find((l) => l.id === 'dien-thoai')).toEqual({ id: 'dien-thoai', slug: 'dien-thoai', name: 'Điện thoại', parentName: 'Điện tử', path: 'Điện tử › Điện thoại', attributeMode: 'dynamic' });
      expect(leaves.find((l) => l.id === 'ao-thun')).toMatchObject({ parentName: 'Thời trang', attributeMode: 'legacy_fashion' });
      expect(leaves.find((l) => l.id === 'khac')).toMatchObject({ parentName: null, path: 'Khác' });
    });

    it('đường dẫn đủ nhiều cấp; vòng lặp cha-con trong dữ liệu hỏng không treo vô hạn', async () => {
      listAll.mockResolvedValue([
        category({ id: 'a', name: 'A' }),
        category({ id: 'b', name: 'B', parentId: 'a' }),
        category({ id: 'c', name: 'C', parentId: 'b' }),
        category({ id: 'x', name: 'X', parentId: 'y' }), // x ↔ y trỏ vòng
        category({ id: 'y', name: 'Y', parentId: 'x' }),
      ]);

      const leaves = await service.listLeaves();

      expect(leaves.find((l) => l.id === 'c')).toMatchObject({ parentName: 'B', path: 'A › B › C' });
      expect(leaves.every((l) => l.id !== 'x' && l.id !== 'y')).toBe(true); // x, y đều có con đang bật → không phải lá, và không treo
    });

    it('đi qua cache nhóm categories với khoá riêng cho vendor', async () => {
      listAll.mockResolvedValue([]);

      await service.listLeaves();

      expect(getOrSet).toHaveBeenCalledWith(expect.objectContaining({ module: 'catalog', purpose: 'categories' }), 'shop-leaves', expect.any(Function));
    });
  });

  describe('getTemplateBySlug', () => {
    function attrRow(over: Partial<CategoryAttributeWithDetailsRow> & { attribute: CategoryAttributeWithDetailsRow['attribute'] }): CategoryAttributeWithDetailsRow {
      return { id: 'ca-1', categoryId: 'c1', attributeId: over.attribute.id, required: false, isVariantAxis: false, sortOrder: 0, ...over };
    }

    it('ngành dynamic: trả thuộc tính + trục + giá trị (hex lấy từ extra); text/number không trả values', async () => {
      findBySlug.mockResolvedValue(category({ id: 'c1', name: 'Điện thoại', slug: 'dien-thoai' }));
      getByCategoryId.mockResolvedValue([
        attrRow({ attribute: { id: 'a-color', code: 'color2', name: 'Màu sắc', inputType: 'select', values: [{ id: 'v-den', value: 'Đen', extra: { hex: '#111111' }, sortOrder: 0 }, { id: 'v-trang', value: 'Trắng', extra: null, sortOrder: 1 }] }, isVariantAxis: true, required: true, sortOrder: 0 }),
        attrRow({ attribute: { id: 'a-bh', code: 'warranty', name: 'Bảo hành', inputType: 'text', values: [{ id: 'v-x', value: 'bỏ qua', extra: null, sortOrder: 0 }] }, sortOrder: 1 }),
      ]);

      const t = await service.getTemplateBySlug('dien-thoai');

      expect(t).toMatchObject({ categoryId: 'c1', slug: 'dien-thoai', name: 'Điện thoại', attributeMode: 'dynamic' });
      expect(t.attributes).toEqual([
        { attributeId: 'a-color', code: 'color2', name: 'Màu sắc', inputType: 'select', required: true, isVariantAxis: true, sortOrder: 0, values: [{ id: 'v-den', value: 'Đen', hex: '#111111' }, { id: 'v-trang', value: 'Trắng', hex: null }] },
        { attributeId: 'a-bh', code: 'warranty', name: 'Bảo hành', inputType: 'text', required: false, isVariantAxis: false, sortOrder: 1, values: [] },
      ]);
    });

    it('ngành legacy_fashion: attributes rỗng và KHÔNG đọc bảng mẫu', async () => {
      findBySlug.mockResolvedValue(category({ id: 'c2', name: 'Áo thun', slug: 'ao-thun', attributeMode: 'legacy_fashion' }));

      const t = await service.getTemplateBySlug('ao-thun');

      expect(t).toMatchObject({ attributeMode: 'legacy_fashion', attributes: [] });
      expect(getByCategoryId).not.toHaveBeenCalled();
    });

    it('không có / đang ẩn → 404 CATALOG_CATEGORY_NOT_FOUND', async () => {
      findBySlug.mockResolvedValueOnce(null);
      findBySlug.mockResolvedValueOnce(category({ id: 'c3', name: 'Ẩn', isActive: false }));

      await expect(service.getTemplateBySlug('khong-co')).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.getTemplateBySlug('an')).rejects.toMatchObject({ errorCode: 'CATALOG_CATEGORY_NOT_FOUND' });
    });
  });
});

/*
 * Cách ly theo quyền của controller: dùng ShopContextGuard THẬT đọc metadata THẬT của route (@UseGuards + @RequireShopPermission),
 * chứng minh route chỉ mở cho thành viên gian hàng đã duyệt có shop.product.read — vendor thiếu quyền / người ngoài đều bị 403.
 */
describe('ShopCatalogController — cách ly theo quyền shop.product.read', () => {
  /* Hàm handler của controller (tham số tuỳ route) — guard chỉ đọc metadata gắn trên hàm, không gọi nó. */
  type Handler = (...args: never[]) => unknown;
  /* Kiểu tham số constructor lấy từ chính guard (module catalog không import ruột shop — chỉ security/ được phép). */
  type GuardDeps = ConstructorParameters<typeof ShopContextGuard>;
  const shop = { id: 'shop-a', code: 'SHOP-A', name: 'Gian hàng A', status: 'approved' };
  const member = { id: 'm1', shopId: 'shop-a', userId: 'user-a', roleId: 'role-1', status: 'active' };
  const actor: AuthenticatedActor = { userId: 'user-a', email: 'a@vn', roleCode: 'customer', permissionVersion: 1, tokenId: 't1' };

  function guardWith(opts: { member: typeof member | null; permissionCodes: string[] }): ShopContextGuard {
    const members = { findActiveByUserId: () => Promise.resolve(opts.member) } as unknown as GuardDeps[1];
    const shops = { findById: () => Promise.resolve(shop) } as unknown as GuardDeps[2];
    const identity = { shopRoleContext: () => Promise.resolve({ code: 'shop_staff', name: 'Nhân viên', permissionCodes: opts.permissionCodes }) } as unknown as GuardDeps[3];
    return new ShopContextGuard(new Reflector(), members, shops, identity);
  }

  function contextOf(handler: Handler): ExecutionContext {
    const req = { actor } as unknown as RequestWithShop;
    return { switchToHttp: () => ({ getRequest: () => req }), getHandler: () => handler, getClass: () => ShopCatalogController } as unknown as ExecutionContext;
  }

  const routes: Array<{ name: string; handler: Handler }> = [
    // eslint-disable-next-line @typescript-eslint/unbound-method -- chỉ lấy tham chiếu hàm để đọc metadata, không gọi
    { name: 'GET categories/leaves', handler: ShopCatalogController.prototype.leaves },
    // eslint-disable-next-line @typescript-eslint/unbound-method -- chỉ lấy tham chiếu hàm để đọc metadata, không gọi
    { name: 'GET categories/:slug/attribute-template', handler: ShopCatalogController.prototype.attributeTemplate },
  ];

  it('controller gắn ShopContextGuard', () => {
    const guards = Reflect.getMetadata('__guards__', ShopCatalogController) as unknown[];

    expect(guards).toContain(ShopContextGuard);
  });

  for (const r of routes) {
    describe(r.name, () => {
      it('vai có shop.product.read → qua guard, req.shop gắn đúng shop', async () => {
        const guard = guardWith({ member, permissionCodes: ['shop.product.read'] });
        const ctx = contextOf(r.handler);

        await expect(guard.canActivate(ctx)).resolves.toBe(true);
        expect(ctx.switchToHttp().getRequest<RequestWithShop>().shop?.shopId).toBe('shop-a');
      });

      it('vai thiếu shop.product.read (vd chỉ có quyền đơn hàng) → 403 SHOP_FORBIDDEN kèm mã quyền thiếu', async () => {
        const guard = guardWith({ member, permissionCodes: ['shop.order.read'] });

        const err = await guard.canActivate(contextOf(r.handler)).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(ForbiddenException);
        expect(err).toMatchObject({ details: { required: 'shop.product.read' } });
      });

      it('người không thuộc gian hàng nào → 403', async () => {
        const guard = guardWith({ member: null, permissionCodes: [] });

        await expect(guard.canActivate(contextOf(r.handler))).rejects.toBeInstanceOf(ForbiddenException);
      });
    });
  }
});
