import type { AddressRepository } from '../address/repository/address.repository';
import type { PermissionRepository } from '../permission/repository/permission.repository';
import type { UserRepository } from '../user/repository/user.repository';
import { IdentityQueryApi } from './identity.queryapi';

/*
 * PLAN-0040 5.3 — IdentityQueryApi.isGoogleLinked: tài khoản tạo bằng Google có mật khẩu NGẪU NHIÊN không ai biết (auth.service loginWithGoogle),
 * nên module gọi (shop: đổi TK ngân hàng cần mật khẩu) dùng cờ này để gợi ý "đặt mật khẩu bằng Quên mật khẩu". Chỉ trả cờ, không lộ `google_sub`.
 */
describe('IdentityQueryApi.isGoogleLinked', () => {
  function build(hasGoogleSub: boolean | Error) {
    const hasGoogleSubFn = jest.fn((_userId: string) => (hasGoogleSub instanceof Error ? Promise.reject(hasGoogleSub) : Promise.resolve(hasGoogleSub)));
    const api = new IdentityQueryApi({ hasGoogleSub: hasGoogleSubFn } as unknown as UserRepository, {} as unknown as AddressRepository, {} as unknown as PermissionRepository);
    return { api, hasGoogleSubFn };
  }

  it('tài khoản có google_sub ⇒ true (hỏi đúng user)', async () => {
    const { api, hasGoogleSubFn } = build(true);

    await expect(api.isGoogleLinked('user-1')).resolves.toBe(true);
    expect(hasGoogleSubFn).toHaveBeenCalledWith('user-1');
  });

  it('tài khoản thường / không tồn tại ⇒ false', async () => {
    await expect(build(false).api.isGoogleLinked('user-2')).resolves.toBe(false);
  });

  it('lỗi hạ tầng nổi lên (nơi gọi quyết định xử lý — shop bắt lỗi và vẫn trả lỗi mật khẩu thường)', async () => {
    await expect(build(new Error('db down')).api.isGoogleLinked('user-3')).rejects.toThrow('db down');
  });
});
