import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * Bảo vệ migration nạp cọc PayOS (PLAN-0041 §3.1): migration CHỈ THÊM (bảng/cột/chỉ mục/CHECK), idempotent (IF NOT EXISTS), đủ 4 chỉ mục UNIQUE + 6 CHECK bắt buộc,
 * và chỉ được gỡ đúng 2 CHECK của sổ cái khi nới. Test đọc file SQL thật — đổi migration mà phá các bất biến này thì test đỏ.
 */

const MIGRATION = join(__dirname, '../../../../prisma/migrations/20261103090000_wallet_payos_topup/migration.sql');

/* Bỏ dòng chú thích `--` để kiểm câu lệnh thật, không kiểm lời bình. */
const code = readFileSync(MIGRATION, 'utf8')
  .split(/\r?\n/)
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

describe('migration nạp cọc PayOS — bảo vệ bất biến', () => {
  it('[WTM-01] mọi CREATE TABLE/INDEX có IF NOT EXISTS; đủ 4 chỉ mục UNIQUE bắt buộc + 6 CHECK; không DROP/TRUNCATE/DELETE/ALTER COLUMN; chỉ DROP CONSTRAINT IF EXISTS đúng 2 CHECK của sổ cái', () => {
    // Idempotent: chạy lại an toàn.
    expect(code.match(/CREATE TABLE (?!IF NOT EXISTS)/g) ?? []).toEqual([]);
    expect(code.match(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/g) ?? []).toEqual([]);

    // 4 chỉ mục UNIQUE bắt buộc (§3.1).
    for (const index of ['shop_cod_topups_payos_order_code_key', 'uq_shop_cod_topups_active_per_shop', 'shop_cod_topup_receipts_topup_id_reference_key', 'uq_shop_cod_wallet_tx_ref_key']) {
      expect(code).toMatch(new RegExp(`CREATE UNIQUE INDEX IF NOT EXISTS "${index}"`));
    }

    // 6 CHECK bắt buộc (§3.1) — tên và số lượng.
    for (const check of ['chk_shop_cod_topups_status', 'chk_shop_cod_topups_amounts', 'chk_shop_cod_topups_code', 'chk_shop_cod_topup_receipts_amount', 'chk_shop_cod_wallet_tx_type', 'chk_shop_cod_wallet_tx_topup']) {
      expect(code).toContain(`"${check}"`);
    }
    expect(code.match(/CHECK \(/g) ?? []).toHaveLength(6);

    // Chỉ thêm: không phá dữ liệu / cấu trúc cũ.
    for (const forbidden of [/DROP TABLE/i, /DROP COLUMN/i, /TRUNCATE/i, /DELETE FROM/i, /ALTER COLUMN/i]) {
      expect(code).not.toMatch(forbidden);
    }
    const drops = [...code.matchAll(/DROP CONSTRAINT\s+(IF EXISTS\s+)?"?([a-z_]+)"?/gi)];
    expect(drops.every((m) => m[1] !== undefined)).toBe(true);
    expect(drops.map((m) => m[2])).toEqual(['chk_shop_cod_wallet_tx_type', 'chk_shop_cod_wallet_tx_topup']);
  });
});
