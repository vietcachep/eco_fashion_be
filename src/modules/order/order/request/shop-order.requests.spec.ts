import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ShopUpdateOrderStatusRequest } from './shop-order.requests';

/* Danh sách thuộc tính lỗi validate của một body PUT /shop/orders/:code/status. */
function invalidProps(body: Record<string, unknown>): string[] {
  const dto = plainToInstance(ShopUpdateOrderStatusRequest, body);
  return validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).map((e) => e.property);
}

describe('ShopUpdateOrderStatusRequest.trackingUrl', () => {
  it('nhận URL https hợp lệ', () => {
    expect(invalidProps({ status: 'shipping', trackingUrl: 'https://tracking.ghn.vn/?order_code=GHN123' })).toEqual([]);
  });

  it('không bắt buộc (bỏ trống vẫn hợp lệ)', () => {
    expect(invalidProps({ status: 'confirmed' })).toEqual([]);
  });

  it.each([
    ['javascript:alert(document.cookie)'],
    ['JAVASCRIPT:alert(1)'],
    ['data:text/html;base64,PHNjcmlwdD4='],
    ['http://tracking.ghn.vn/?order=1'],
    ['ftp://files.example.com/x'],
    ['//evil.example.com/phish'],
    ['tracking.ghn.vn/order/1'],
    ['không phải url'],
  ])('từ chối %s', (url) => {
    expect(invalidProps({ status: 'shipping', trackingUrl: url })).toContain('trackingUrl');
  });

  it('từ chối URL dài quá 500 ký tự', () => {
    expect(invalidProps({ status: 'shipping', trackingUrl: `https://tracking.ghn.vn/${'a'.repeat(500)}` })).toContain('trackingUrl');
  });
});
