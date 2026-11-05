import { hashShipping, mapCarrierStatus, mayTransition, validateParcel, validateShippingAddress, escapeHtml } from './shipping.pure';

describe('PLAN-0043: quy tắc vận chuyển', () => {
  it.each([['ready_to_pick', 'awaiting_pickup'], ['picked', 'picked'], ['transporting', 'in_transit'], ['delivery_fail', 'delivery_failed'], ['waiting_to_return', 'returning'], ['returned', 'returned'], ['cancel', 'cancelled'], ['damage', 'lost']])('ánh xạ %s → %s', (raw, expected) => expect(mapCarrierStatus(raw)).toBe(expected));
  it('không kết luận hàng đã về khi chỉ đang hoàn', () => expect(mapCarrierStatus('returning')).not.toBe('returned'));
  it('không nhận trạng thái lạ thành giao thành công', () => expect(mapCarrierStatus('unknown')).toBeNull());
  it('giao thất bại có thể giao lại nhưng đã giao không được lùi', () => {
    expect(mayTransition('delivery_failed', 'delivering')).toBe(true);
    expect(mayTransition('delivered', 'picked')).toBe(false);
    expect(mayTransition('returned', 'delivered')).toBe(false);
    expect(mayTransition('picked', 'cancelled')).toBe(false);
  });
  it('cho nhảy qua sự kiện bị mất và no-op trạng thái lặp', () => {
    expect(mayTransition('awaiting_pickup', 'delivered')).toBe(true);
    expect(mayTransition('delivered', 'delivered')).toBe(true);
  });
  it.each([{ weightGram: 0, lengthCm: 20, widthCm: 15, heightCm: 10 }, { weightGram: 20_000, lengthCm: 20, widthCm: 15, heightCm: 10 }, { weightGram: 500, lengthCm: 201, widthCm: 15, heightCm: 10 }])('chặn kiện ngoài giới hạn %j', (parcel) => expect(() => validateParcel(parcel)).toThrow());
  it('không chặn kiện mặc định', () => expect(() => validateParcel({ weightGram: 500, lengthCm: 20, widthCm: 15, heightCm: 10 })).not.toThrow());
  it('địa chỉ thiếu mã không được nhận để lỗi lúc hãng lấy', () => expect(() => validateShippingAddress({ name: 'A', phone: '0900000000', street: '1 A', provinceName: 'Hồ Chí Minh', districtName: 'Quận 1', wardName: 'Bến Nghé', provinceId: 202, districtId: 1442, wardCode: '', addressSystem: 'legacy_3level' })).toThrow());
  it('fingerprint thay khi điểm lấy/kiện đổi', () => expect(hashShipping({ pickup: 1, weight: 500 })).not.toBe(hashShipping({ pickup: 2, weight: 500 })));
  it('phiếu HTML không chèn được script qua mã vận đơn', () => expect(escapeHtml('<script>alert("x")</script>')).not.toContain('<script>'));
});
