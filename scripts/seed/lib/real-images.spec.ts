import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { alreadyRealAssetPaths, alreadyRealProductSlugs, bannerSamplePaths, cropFor, isSampleImage, parseKey, pexelsUrl } from './real-images';

describe('real-images', () => {
  it('chỉ coi ảnh mẫu là được phép thay', () => {
    expect(isSampleImage('https://api.x/static/seed/product/a/a.jpg')).toBe(true);
    expect(isSampleImage('https://res.cloudinary.com/c/image/upload/ecofashion/seed/product/a/a.jpg', 'ecofashion/seed/product/a/a')).toBe(true);
    expect(isSampleImage('https://res.cloudinary.com/c/image/upload/ecofashion/real/product/a/a.jpg', 'ecofashion/real/product/a/a')).toBe(false);
    expect(isSampleImage('https://res.cloudinary.com/c/image/upload/v1/shop-owner-upload.jpg', 'owner/abc')).toBe(false);
    expect(isSampleImage(null)).toBe(false);
  });

  it('phân tích khoá manifest', () => {
    expect(parseKey('product/ao-thun/a')).toEqual({ kind: 'product', slug: 'ao-thun', slot: 'a' });
    expect(parseKey('shop/pet-world/logo')).toEqual({ kind: 'shop', slug: 'pet-world', slot: 'logo' });
    expect(parseKey('shop/pet-world/a')).toBeNull();
    expect(parseKey('product/x/logo')).toBeNull();
    expect(parseKey('../etc/passwd')).toBeNull();
  });

  it('cắt ảnh đúng tỉ lệ từng loại và dựng URL CDN Pexels', () => {
    expect(cropFor('shop/x/banner')).toEqual({ w: 1600, h: 533 });
    expect(cropFor('shop/x/logo')).toEqual({ w: 400, h: 400 });
    expect(cropFor('product/x/a')).toEqual({ w: 800, h: 1000 });
    expect(pexelsUrl(123, 'product/x/a')).toBe('https://images.pexels.com/photos/123/pexels-photo-123.jpeg?auto=compress&cs=tinysrgb&fit=crop&w=800&h=1000');
  });

  it('nhận ra sản phẩm đã có ảnh thật từ NGUON-ANH.md và chịu được thiếu file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nguon-'));
    const f = path.join(dir, 'NGUON-ANH.md');
    fs.writeFileSync(f, ['| `product/ao-thun-cotton-nam-basic/main.jpg` | x |', '| `product/ao-thun-cotton-nam-basic/hover.jpg` | y |', '| `product/quan-jean/main.jpg` | z |'].join('\n'));
    expect([...alreadyRealProductSlugs(f)].sort()).toEqual(['ao-thun-cotton-nam-basic', 'quan-jean']);
    expect(alreadyRealProductSlugs(path.join(dir, 'khong-co.md')).size).toBe(0);
  });

  it('khoá ngành hàng / bộ sưu tập / banner và khung cắt của chúng', () => {
    expect(parseKey('category/laptop')).toEqual({ kind: 'category', slug: 'laptop', slot: 'main' });
    expect(parseKey('collection/thoi-trang')).toEqual({ kind: 'collection', slug: 'thoi-trang', slot: 'main' });
    expect(parseKey('banner/home-1')).toEqual({ kind: 'banner', slug: 'home-1', slot: 'main' });
    expect(parseKey('category/a/b')).toBeNull();
    expect(parseKey('Category/x')).toBeNull();
    expect(cropFor('banner/home-1')).toEqual({ w: 1600, h: 520 });
    expect(cropFor('collection/nu')).toEqual({ w: 900, h: 600 });
    expect(cropFor('category/laptop')).toEqual({ w: 600, h: 600 });
    // khoá banner của SHOP vẫn cắt theo khung shop
    expect(cropFor('shop/x/banner')).toEqual({ w: 1600, h: 533 });
  });

  it('ảnh thật chọn tay của ngành hàng/bộ sưu tập được nhận ra; banner dùng lại ảnh bộ sưu tập', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nguon2-'));
    const f = path.join(dir, 'NGUON-ANH.md');
    fs.writeFileSync(f, ['| `catalog/categories/ao-thun.jpg` | x |', '| `catalog/collections/nu.jpg` | y |', '| `product/a/main.jpg` | z |'].join('\n'));
    const set = alreadyRealAssetPaths(f);
    expect(set.has('catalog/categories/ao-thun')).toBe(true);
    expect(set.has('catalog/collections/nu')).toBe(true);
    expect(set.has('product/a/main')).toBe(false);
    expect(bannerSamplePaths('nu')).toEqual(['banners/nu', 'catalog/collections/nu']);
  });
});
