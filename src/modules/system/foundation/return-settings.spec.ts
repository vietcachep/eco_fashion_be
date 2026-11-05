import { SETTING_KEY } from '../enums/setting-keys';
import { SETTING_DEFAULTS } from './system.constants';

/* Hạn chót đổi trả (PLAN-0022 §3): khoá + mặc định + nhóm `order` + không công khai (trừ return.window_days đã có). */
describe('setting hạn chót đổi trả', () => {
  const expected: Array<[string, string, number, number]> = [
    ['RETURN_SHOP_RESPOND_HOURS', 'return.shop_respond_hours', 72, 8760],
    ['RETURN_SHIP_BACK_DAYS', 'return.ship_back_days', 7, 365],
    ['RETURN_SHOP_RECEIVE_DAYS', 'return.shop_receive_days', 5, 365],
    ['RETURN_ESCALATE_DAYS', 'return.escalate_days', 3, 365],
    ['RETURN_NOT_RECEIVED_DAYS', 'return.not_received_days', 7, 365], // SHP-05 (PLAN-0031 §2.3): 7 ngày
    ['ORDER_SHIPPING_ALERT_DAYS', 'order.shipping_alert_days', 10, 365],
  ];

  it.each(expected)('%s = "%s" mặc định %d, group order, không công khai, khoảng [1, %d]', (name, key, value, max) => {
    expect(SETTING_KEY[name as keyof typeof SETTING_KEY]).toBe(key);
    expect(SETTING_DEFAULTS[key]).toMatchObject({ value, group: 'order', isPublic: false, min: 1, max });
    expect(SETTING_DEFAULTS[key].description.length).toBeGreaterThan(10);
  });

  it('return.window_days giữ nguyên: 7 ngày, công khai', () => {
    expect(SETTING_DEFAULTS[SETTING_KEY.RETURN_WINDOW_DAYS]).toMatchObject({ value: 7, group: 'order', isPublic: true });
  });
});
