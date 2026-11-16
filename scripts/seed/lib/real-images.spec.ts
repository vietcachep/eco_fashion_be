import { cropFor, isSampleImage, parseKey, pexelsUrl } from './real-images';

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
});
