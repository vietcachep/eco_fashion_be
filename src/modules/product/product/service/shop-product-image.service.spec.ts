import { BusinessException, ConflictException, NotFoundException } from '@common/exception/business.exception';
import type { PrismaService } from '@common/prisma/prisma.service';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import type { ProductImageService } from '../../image/service/product-image.service';
import { PRODUCT_ERR } from '../../foundation/product.constants';
import type { ProductAdminResponse } from '../dto/product.responses';
import { detectImageType } from './image-signature';
import { ShopProductImageService } from './shop-product-image.service';

/* Đầu file thật của từng định dạng (đủ ≥ 12 byte như detectImageType đòi). */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00', 'latin1');
const WEBP = Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 ', 'latin1');

/* Test quy tắc ownership — product phải thuộc shop, nếu không trả 404 — và các luật riêng của vendor ở lớp bọc ảnh. */
describe('ShopProductImageService', () => {
  let service: ShopProductImageService;

  /*
   * Mỗi mock giữ trong BIẾN RIÊNG (không đọc lại qua `obj.method`) để assert không dính `unbound-method`;
   * kiểu tham số/giá trị trả lấy thẳng từ service thật nên đổi chữ ký production là test báo đỏ ngay.
   */
  const findProduct = jest.fn<Promise<{ id: string; status?: string; _count?: { images: number } } | null>, [unknown]>();
  const findImage = jest.fn<Promise<{ isPrimary: boolean } | null>, [unknown]>();
  const upload = jest.fn<Promise<ProductAdminResponse>, Parameters<ProductImageService['upload']>>();
  const update = jest.fn<Promise<ProductAdminResponse>, Parameters<ProductImageService['update']>>();
  const reorder = jest.fn<Promise<ProductAdminResponse>, Parameters<ProductImageService['reorder']>>();
  const remove = jest.fn<Promise<ProductAdminResponse>, Parameters<ProductImageService['remove']>>();

  /* Service chỉ chuyển tiếp kết quả nên chỉ cần một giá trị "dấu" nhận ra được bằng toBe. */
  const imageResult = { id: 'p1', name: 'Product', status: 'active' } as ProductAdminResponse;

  const actor: AuthenticatedActor = { userId: 'u1', email: 'u1@vn', roleCode: 'admin', permissionVersion: 1, tokenId: 't1' };
  const shopId = 'shop-1';
  const productId = 'p1';
  const imageId = 'i1';

  beforeEach(() => {
    jest.resetAllMocks();

    const prisma = { product: { findFirst: findProduct }, productImage: { findFirst: findImage } } as unknown as PrismaService;
    const images = { upload, update, reorder, remove } as unknown as ProductImageService;

    service = new ShopProductImageService(images, prisma);
  });

  describe('uploadShop', () => {
    const file = { buffer: JPEG, mimetype: 'image/jpeg', size: 1000 };

    it('throw 404 nếu product không thuộc shop', async () => {
      findProduct.mockResolvedValue(null);

      await expect(service.uploadShop(actor, shopId, productId, file, {})).rejects.toThrow(NotFoundException);
      expect(findProduct).toHaveBeenCalledWith({
        where: { id: productId, shopId, isDeleted: false },
        select: { id: true },
      });
      expect(upload).not.toHaveBeenCalled();
    });

    it('gọi image.upload nếu product thuộc shop', async () => {
      const opts = { colorCode: 'red', alt: null, isPrimary: false };
      findProduct.mockResolvedValue({ id: productId });
      upload.mockResolvedValue(imageResult);

      const result = await service.uploadShop(actor, shopId, productId, file, opts);

      expect(result).toBe(imageResult);
      expect(upload).toHaveBeenCalledWith(actor, productId, file, opts);
    });

    it.each([
      ['JPEG', JPEG, 'image/jpeg'],
      ['PNG', PNG, 'image/png'],
      ['GIF', GIF, 'image/gif'],
      ['WebP', WEBP, 'image/webp'],
    ])('nhận ảnh %s theo magic bytes và chuẩn hoá mimetype theo nội dung thật (client khai sai vẫn được sửa)', async (_name, buffer, mime) => {
      findProduct.mockResolvedValue({ id: productId });
      upload.mockResolvedValue(imageResult);

      await service.uploadShop(actor, shopId, productId, { buffer, mimetype: 'image/jpeg', size: buffer.length }, {});

      expect(upload).toHaveBeenCalledWith(actor, productId, { buffer, mimetype: mime, size: buffer.length }, {});
    });

    it.each([
      ['HTML đội lốt image/png', Buffer.from('<html><script>alert(1)</script></html>')],
      ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')],
      ['file rỗng', Buffer.alloc(0)],
      ['quá ngắn', Buffer.from([0xff, 0xd8, 0xff])],
      ['RIFF nhưng không phải WebP (WAV)', Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'latin1')],
    ])('từ chối %s (400 PRODUCT_IMAGE_INVALID) TRƯỚC khi gọi Storage', async (_name, buffer) => {
      findProduct.mockResolvedValue({ id: productId });

      const e = await service.uploadShop(actor, shopId, productId, { buffer, mimetype: 'image/png', size: buffer.length }, {}).catch((err: unknown) => err);

      expect(e).toBeInstanceOf(BusinessException);
      expect((e as BusinessException).errorCode).toBe(PRODUCT_ERR.IMAGE_INVALID);
      expect(upload).not.toHaveBeenCalled();
    });

    it('detectImageType: nhận đúng 4 định dạng, còn lại null', () => {
      expect([JPEG, PNG, GIF, WEBP].map((b) => detectImageType(b))).toEqual(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
      expect(detectImageType(Buffer.from('GIF90a\x01\x00\x01\x00\x00\x00', 'latin1'))).toBeNull();
    });
  });

  describe('updateShop', () => {
    it('throw 404 nếu product không thuộc shop', async () => {
      findProduct.mockResolvedValue(null);

      await expect(service.updateShop(actor, shopId, productId, imageId, {})).rejects.toThrow(NotFoundException);
      expect(update).not.toHaveBeenCalled();
    });

    it('gọi image.update nếu product thuộc shop', async () => {
      const patch = { colorCode: 'blue' };
      findProduct.mockResolvedValue({ id: productId });
      update.mockResolvedValue(imageResult);

      const result = await service.updateShop(actor, shopId, productId, imageId, patch);

      expect(result).toBe(imageResult);
      expect(update).toHaveBeenCalledWith(actor, productId, imageId, patch);
    });

    it('không cho bỏ cờ ảnh chính của ảnh chính hiện tại (409 PRODUCT_IMAGE_PRIMARY_REQUIRED)', async () => {
      findProduct.mockResolvedValue({ id: productId });
      findImage.mockResolvedValue({ isPrimary: true });

      const e = await service.updateShop(actor, shopId, productId, imageId, { isPrimary: false }).catch((err: unknown) => err);

      expect(e).toBeInstanceOf(ConflictException);
      expect((e as ConflictException).errorCode).toBe(PRODUCT_ERR.IMAGE_PRIMARY_REQUIRED);
      expect(update).not.toHaveBeenCalled();
    });

    it('isPrimary:false trên ảnh KHÔNG phải ảnh chính vẫn được; ảnh không thuộc sản phẩm → 404', async () => {
      findProduct.mockResolvedValue({ id: productId });
      update.mockResolvedValue(imageResult);
      findImage.mockResolvedValueOnce({ isPrimary: false });

      await service.updateShop(actor, shopId, productId, imageId, { isPrimary: false });
      expect(update).toHaveBeenCalledWith(actor, productId, imageId, { isPrimary: false });

      findImage.mockResolvedValueOnce(null);
      await expect(service.updateShop(actor, shopId, productId, 'i-khac', { isPrimary: false })).rejects.toThrow(NotFoundException);
    });

    it('đặt ảnh khác làm ảnh chính (isPrimary:true) không bị chặn và không cần đọc ảnh', async () => {
      findProduct.mockResolvedValue({ id: productId });
      update.mockResolvedValue(imageResult);

      await service.updateShop(actor, shopId, productId, imageId, { isPrimary: true });

      expect(findImage).not.toHaveBeenCalled();
      expect(update).toHaveBeenCalled();
    });
  });

  describe('reorderShop', () => {
    const imageIds = ['i1', 'i2'];

    it('throw 404 nếu product không thuộc shop', async () => {
      findProduct.mockResolvedValue(null);

      await expect(service.reorderShop(actor, shopId, productId, imageIds)).rejects.toThrow(NotFoundException);
      expect(reorder).not.toHaveBeenCalled();
    });

    it('gọi image.reorder nếu product thuộc shop', async () => {
      findProduct.mockResolvedValue({ id: productId });
      reorder.mockResolvedValue(imageResult);

      const result = await service.reorderShop(actor, shopId, productId, imageIds);

      expect(result).toBe(imageResult);
      expect(reorder).toHaveBeenCalledWith(actor, productId, imageIds);
    });

    it('id trùng ([a, a]) → 400, không gọi reorder (ProductImageService chỉ so độ dài + tập nên để lọt)', async () => {
      findProduct.mockResolvedValue({ id: productId });

      await expect(service.reorderShop(actor, shopId, productId, ['i1', 'i1'])).rejects.toThrow(BusinessException);
      expect(reorder).not.toHaveBeenCalled();
    });
  });

  describe('removeShop', () => {
    it('throw 404 nếu product không thuộc shop', async () => {
      findProduct.mockResolvedValue(null);

      await expect(service.removeShop(actor, shopId, productId, imageId)).rejects.toThrow(NotFoundException);
      expect(remove).not.toHaveBeenCalled();
    });

    it('gọi image.remove nếu product thuộc shop (còn nhiều ảnh)', async () => {
      findProduct.mockResolvedValue({ id: productId, status: 'active', _count: { images: 3 } });
      remove.mockResolvedValue(imageResult);

      const result = await service.removeShop(actor, shopId, productId, imageId);

      expect(result).toBe(imageResult);
      expect(remove).toHaveBeenCalledWith(actor, productId, imageId);
    });

    it('ảnh CUỐI của sản phẩm đang bán → 409 PRODUCT_IMAGE_REQUIRED', async () => {
      findProduct.mockResolvedValue({ id: productId, status: 'active', _count: { images: 1 } });

      const e = await service.removeShop(actor, shopId, productId, imageId).catch((err: unknown) => err);

      expect(e).toBeInstanceOf(ConflictException);
      expect((e as ConflictException).errorCode).toBe(PRODUCT_ERR.IMAGE_REQUIRED);
      expect(remove).not.toHaveBeenCalled();
    });

    it('ảnh cuối của sản phẩm nháp/ẩn xoá được', async () => {
      remove.mockResolvedValue(imageResult);
      for (const status of ['draft', 'hidden']) {
        findProduct.mockResolvedValue({ id: productId, status, _count: { images: 1 } });
        await service.removeShop(actor, shopId, productId, imageId);
      }
      expect(remove).toHaveBeenCalledTimes(2);
    });
  });
});
