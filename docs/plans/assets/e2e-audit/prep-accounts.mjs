/*
 * Chuẩn bị tài khoản khách bổ sung cho các bài test (dump dữ liệu mẫu chỉ có khach1…khach45 mà t04/t04b/t04c dùng khach46).
 * Nhân bản mật khẩu từ khach45 (cùng mật khẩu mẫu) — idempotent, chạy trước t01.
 */
import * as L from './lib.mjs';

const WANT = [46];
for (const n of WANT) {
  const email = `khach${n}@ecofashion.vn`;
  const exists = await L.q1(`SELECT 1 AS x FROM identity.users WHERE email = $1`, [email]);
  if (exists) { console.log(`đã có ${email}`); continue; }
  const r = await L.q(
    `INSERT INTO identity.users (email, password_hash, full_name, role_id, status, email_verified_at)
     SELECT $1, password_hash, $2, role_id, 'active', now() FROM identity.users WHERE email = 'khach45@ecofashion.vn' RETURNING id`,
    [email, `Khách Kiểm Thử ${n}`],
  );
  console.log(`đã tạo ${email}`, r.length);
}
process.exit(0);
