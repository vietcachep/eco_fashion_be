import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { sanitizeSummary } from '@common/audit/audit';
import { RegisterRequest } from './auth/request/auth.requests';
import { ALL_PERMISSION_CODES, PERMISSION_CATALOG, ROLE_CODES, ROLE_PRESETS, STAFF_ROLE_CODES } from './permission/catalog';
import { SaveUserPermissionsRequest } from './permission/request/permission.requests';
import { PermissionService } from './permission/service/permission.service';
import { ListUsersQuery } from './user/request/user.requests';

/*
 * Test quy tắc THUẦN của identity (không DB): catalog quyền, preset vai, phép tính quyền hiệu lực,
 * chuẩn hoá request. Luồng có DB/Redis (rotation, reuse, khoá) kiểm bằng smoke trên compose (PLAN-0002 nhật ký).
 */
describe('identity — catalog quyền', () => {
  it('mã quyền dạng module.resource.action, không trùng, module hợp lệ', () => {
    const modules = new Set(['identity', 'catalog', 'product', 'order', 'payment', 'promotion', 'review', 'system', 'reporting', 'ai']);
    const seen = new Set<string>();
    for (const d of PERMISSION_CATALOG) {
      expect(d.code).toMatch(/^[a-z]+(\.[a-z_]+){2,3}$/);
      expect(d.code.startsWith(`${d.module}.`)).toBe(true);
      expect(modules.has(d.module)).toBe(true);
      expect(seen.has(d.code)).toBe(false);
      seen.add(d.code);
    }
  });

  it('preset mọi vai chỉ dùng mã có trong catalog; admin = toàn bộ; customer rỗng', () => {
    for (const code of Object.values(ROLE_CODES)) {
      for (const c of ROLE_PRESETS[code].codes) expect(ALL_PERMISSION_CODES).toContain(c);
    }
    expect([...ROLE_PRESETS.admin.codes].sort()).toEqual([...ALL_PERMISSION_CODES].sort());
    expect(ROLE_PRESETS.customer.codes).toHaveLength(0);
    expect(STAFF_ROLE_CODES).not.toContain(ROLE_CODES.CUSTOMER);
  });
});

describe('identity — quyền hiệu lực', () => {
  it('vai ∪ cấp riêng − chặn riêng, deny thắng', () => {
    const r = PermissionService.effective(
      ['order.order.read', 'order.order.cancel'],
      [
        { code: 'product.product.read', allowed: true },
        { code: 'order.order.cancel', allowed: false },
        { code: 'order.order.cancel', allowed: true }, // allow không thắng deny dù xuất hiện sau
      ],
    );
    expect([...r].sort()).toEqual(['order.order.read', 'product.product.read']);
  });
});

describe('identity — request chuẩn hoá', () => {
  it('email trim + lowercase, mật khẩu phải có chữ và số', () => {
    const ok = plainToInstance(RegisterRequest, { email: '  An@EcoFashion.VN ', password: 'MatKhau123', fullName: 'Nguyễn Văn An' });
    expect(ok.email).toBe('an@ecofashion.vn');
    expect(validateSync(ok)).toHaveLength(0);
    const bad = plainToInstance(RegisterRequest, { email: 'x@y.vn', password: 'chikhongso', fullName: 'A' });
    expect(validateSync(bad).map((e) => e.property).sort()).toEqual(['fullName', 'password']);
  });

  it('query staffOnly nhận chuỗi true/false', () => {
    const q = plainToInstance(ListUsersQuery, { staffOnly: 'true', page: '2', size: '10' });
    expect(q.staffOnly).toBe(true);
    expect(q.page).toBe(2);
    expect(q.skip).toBe(10);
    expect(validateSync(q)).toHaveLength(0);
  });

  it('override cho phép allowed null (gỡ) và từ chối mã sai định dạng', () => {
    const ok = plainToInstance(SaveUserPermissionsRequest, { overrides: [{ code: 'order.order.cancel', allowed: null }] });
    expect(validateSync(ok)).toHaveLength(0);
    const bad = plainToInstance(SaveUserPermissionsRequest, { overrides: [{ code: 'Order.Cancel', allowed: true }] });
    expect(validateSync(bad).length).toBeGreaterThan(0);
  });
});

describe('identity — audit không lộ bí mật', () => {
  it('che password/token/otp/hash trong summary lồng nhau', () => {
    const out = sanitizeSummary({ email: 'a@b.vn', passwordHash: 'x', nested: { refreshToken: 'y', otp: '123456', ok: 1 } });
    expect(out).toEqual({ email: 'a@b.vn', passwordHash: '***', nested: { refreshToken: '***', otp: '***', ok: 1 } });
  });
});
