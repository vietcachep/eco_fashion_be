import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CARRIER_CODES } from '../../foundation/order.constants';
import { DeliveryFailedRequest, ShopUpdateOrderStatusRequest } from './shop-order.requests';

/* Danh sách thuộc tính lỗi validate (whitelist + forbidNonWhitelisted như ValidationPipe toàn cục). */
function invalidProps<T extends object>(cls: new () => T, body: Record<string, unknown>): string[] {
  return validateSync(plainToInstance(cls, body), { whitelist: true, forbidNonWhitelisted: true }).map((e) => e.property);
}

describe('[FUL-08] ShopUpdateOrderStatusRequest — hãng vận chuyển + mã vận đơn', () => {
  it('[FUL-08] nhận từng hãng trong danh mục + mã vận đơn hợp lệ', () => {
    for (const carrier of CARRIER_CODES) expect(invalidProps(ShopUpdateOrderStatusRequest, { status: 'shipping', carrier, trackingCode: 'GHN-123456' })).toEqual([]);
  });

  it('[FUL-08] hãng ngoài danh mục ⇒ lỗi carrier', () => {
    for (const carrier of ['dhl', 'GHN', 'giao hang nhanh', '']) expect(invalidProps(ShopUpdateOrderStatusRequest, { status: 'shipping', carrier, trackingCode: 'GHN123456' })).toContain('carrier');
  });

  it.each([['abc'], ['A'.repeat(41)], ['GHN 123456'], ['GHN_123456'], ['<script>alert(1)</script>'], ['GHN123456\n'], ['mã-vận-đơn']])('[FUL-08] mã vận đơn %j sai định dạng ⇒ lỗi trackingCode', (trackingCode) => {
    expect(invalidProps(ShopUpdateOrderStatusRequest, { status: 'shipping', carrier: 'ghn', trackingCode })).toContain('trackingCode');
  });

  it('[FUL-08] mã vận đơn 4 và 40 ký tự (chữ, số, gạch ngang) hợp lệ', () => {
    for (const trackingCode of ['AB-1', 'A'.repeat(40), 'ghtk-S1-0123456789']) expect(invalidProps(ShopUpdateOrderStatusRequest, { status: 'shipping', carrier: 'ghtk', trackingCode })).toEqual([]);
  });

  it('[FUL-08] các bước khác không bắt buộc hãng/mã ở tầng DTO (service mới ép khi → shipping, giữ tương thích body cũ)', () => {
    expect(invalidProps(ShopUpdateOrderStatusRequest, { status: 'confirmed' })).toEqual([]);
    expect(invalidProps(ShopUpdateOrderStatusRequest, { status: 'delivered' })).toEqual([]);
  });
});

describe('[SHP-09] DeliveryFailedRequest — mã lý do mở rộng', () => {
  it('[SHP-09] refused · unreachable · wrong_address · lost · damaged · other', () => {
    for (const reasonCode of ['refused', 'unreachable', 'wrong_address', 'lost', 'damaged', 'other']) expect(invalidProps(DeliveryFailedRequest, { reasonCode, note: 'Khách từ chối nhận', goodsReturned: false })).toEqual([]);
    expect(invalidProps(DeliveryFailedRequest, { reasonCode: 'stolen', note: 'Khách từ chối nhận', goodsReturned: false })).toContain('reasonCode');
  });
});
