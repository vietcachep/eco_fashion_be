/*
 * ẨN DANH trên BẢN SAO của DB trước khi đóng gói dump (npm run db:dump) — để file dump commit lên repo KHÔNG chứa thông tin cá nhân thật:
 *  - tài khoản có email ngoài miền mẫu @ecofashion.vn (thường là tài khoản người phát triển tự đăng ký để thử): đổi email, họ tên, bỏ SĐT/ảnh/Google,
 *    đặt mật khẩu = mật khẩu của khach1@ecofashion.vn (mật khẩu mẫu công khai trong docs);
 *  - mọi cột ip_address / user_agent ở mọi bảng → NULL;
 *  - nhật ký audit của các tài khoản trên: thay email/họ tên cũ trong actor_email, entity_code, before_summary, after_summary.
 * Kèm danh sách "chuỗi nhạy cảm" (email, họ tên, SĐT, IP cũ) để dump.ts dò lại nội dung dump — còn sót thì HUỶ dump.
 */
export const SCRUB_SQL = `
CREATE TEMP TABLE scrub_map AS
SELECT id, email AS old_email, full_name AS old_name, phone AS old_phone,
       'khach-thu-' || row_number() OVER (ORDER BY created_at, id) || '@ecofashion.vn' AS new_email,
       'Khách thử ' || row_number() OVER (ORDER BY created_at, id) AS new_name
  FROM identity.users WHERE email NOT LIKE '%@ecofashion.vn';

CREATE TEMP TABLE scrub_needles(value text);
INSERT INTO scrub_needles SELECT old_email FROM scrub_map;
INSERT INTO scrub_needles SELECT old_name FROM scrub_map WHERE length(old_name) >= 4;
INSERT INTO scrub_needles SELECT old_phone FROM scrub_map WHERE old_phone IS NOT NULL AND length(old_phone) >= 6;

DO $$
DECLARE r record; m record;
BEGIN
  -- IP thật (ghi vào needles trước khi xoá), rồi xoá mọi ip_address/user_agent
  FOR r IN SELECT c.table_schema AS s, c.table_name AS t, c.column_name AS c FROM information_schema.columns c
             JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name AND tb.table_type = 'BASE TABLE'
            WHERE c.column_name = 'ip_address' AND c.table_schema NOT IN ('information_schema', 'pg_catalog') LOOP
    EXECUTE format('INSERT INTO scrub_needles SELECT DISTINCT %I::text FROM %I.%I WHERE %I IS NOT NULL AND %I::text NOT IN (''::1'', ''127.0.0.1'', ''::ffff:127.0.0.1'')', r.c, r.s, r.t, r.c, r.c);
  END LOOP;
  FOR r IN SELECT c.table_schema AS s, c.table_name AS t, c.column_name AS c FROM information_schema.columns c
             JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name AND tb.table_type = 'BASE TABLE'
            WHERE c.column_name IN ('ip_address', 'user_agent') AND c.is_nullable = 'YES' AND c.table_schema NOT IN ('information_schema', 'pg_catalog') LOOP
    EXECUTE format('UPDATE %I.%I SET %I = NULL', r.s, r.t, r.c);
  END LOOP;

  -- tài khoản ngoài miền mẫu
  UPDATE identity.users u
     SET email = sm.new_email, full_name = sm.new_name, phone = NULL, avatar_url = NULL, google_sub = NULL,
         password_hash = (SELECT password_hash FROM identity.users WHERE email = 'khach1@ecofashion.vn')
    FROM scrub_map sm WHERE u.id = sm.id;

  -- audit của các tài khoản đó, ở mọi schema
  FOR r IN SELECT table_schema AS s FROM information_schema.tables WHERE table_name = 'audit_logs' AND table_schema NOT IN ('information_schema', 'pg_catalog') LOOP
    FOR m IN SELECT * FROM scrub_map LOOP
      EXECUTE format('UPDATE %I.audit_logs SET actor_email = $1 WHERE actor_email = $2', r.s) USING m.new_email, m.old_email;
      EXECUTE format('UPDATE %I.audit_logs SET entity_code = $1 WHERE entity_code = $2', r.s) USING m.new_email, m.old_email;
      EXECUTE format('UPDATE %I.audit_logs SET before_summary = replace(replace(before_summary::text, $2, $1), $4, $3)::jsonb WHERE before_summary::text LIKE ''%%'' || $2 || ''%%'' OR before_summary::text LIKE ''%%'' || $4 || ''%%''', r.s)
        USING m.new_email, m.old_email, m.new_name, m.old_name;
      EXECUTE format('UPDATE %I.audit_logs SET after_summary = replace(replace(after_summary::text, $2, $1), $4, $3)::jsonb WHERE after_summary::text LIKE ''%%'' || $2 || ''%%'' OR after_summary::text LIKE ''%%'' || $4 || ''%%''', r.s)
        USING m.new_email, m.old_email, m.new_name, m.old_name;
    END LOOP;
  END LOOP;
END $$;

SELECT 'SCRUBBED' || E'\\t' || count(*) FROM scrub_map;
SELECT 'NEEDLE' || E'\\t' || value FROM scrub_needles WHERE value IS NOT NULL AND value <> '';
`;

export interface ScrubResult {
  accounts: number;
  needles: string[];
}

export function parseScrubOutput(out: string): ScrubResult {
  let accounts = 0;
  const needles = new Set<string>();
  for (const line of out.split('\n')) {
    const [tag, value] = line.split('\t');
    if (tag === 'SCRUBBED') accounts = Number(value);
    else if (tag === 'NEEDLE' && value) needles.add(value);
  }
  return { accounts, needles: [...needles] };
}

/* Chuỗi nhạy cảm còn nằm trong nội dung dump (không phân biệt hoa thường). */
export function findLeaks(dumpText: string, needles: readonly string[]): string[] {
  const hay = dumpText.toLowerCase();
  return needles.filter((n) => hay.includes(n.toLowerCase()));
}
