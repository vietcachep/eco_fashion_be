/*
 * XUẤT BẢN DUMP DỮ LIỆU MẪU  —  `npm run db:dump`
 *
 * Dự án này chỉ có DỮ LIỆU MẪU, nên cho phép "đóng gói" toàn bộ dữ liệu đang có trong DB (đơn, đánh giá, sản phẩm đã sửa, tài khoản…) vào
 * `scripts/db/demo-data/ecofashion-demo.dump` (commit cùng repo). Máy khác clone về chạy `npm run db:restore -- --yes` là có dữ liệu GIỐNG HỆT
 * máy này (thay vì chỉ có bộ dữ liệu của `npm run seed`). Ảnh dùng link Cloudinary đã đóng gói (xem seed/lib/seed-images.ts) nên cũng giống.
 *
 * Chỉ DỮ LIỆU (data-only) của các schema ứng dụng; cấu trúc bảng đến từ migration — nên DB đích phải ở cùng bộ migration (restore tự kiểm).
 * ẨN DANH tự động (mặc định; tắt bằng --no-scrub): dump được lấy từ BẢN SAO tạm của DB đã ẩn danh tài khoản ngoài miền @ecofashion.vn, xoá IP/user-agent
 * (xem scrub.ts); sau đó dò lại nội dung dump, còn sót email/họ tên/SĐT/IP thật thì HUỶ dump. DB gốc không bị sửa.
 * Không đưa vào dump: phiên đăng nhập, lịch sử đăng nhập, hàng đợi sự kiện, khoá idempotency, nhật ký chi phí AI, ảnh/phân tích của người dùng (EXCLUDE_TABLE_DATA).
 * Cần Docker (chạy pg_dump trong container ecofashion-db) và DB đang chạy. Tuỳ chọn: --db <tên> dump từ DB khác trong cùng container.
 *
 * LƯU Ý: dump chứa mã băm mật khẩu và email của các tài khoản MẪU (mật khẩu mẫu đã công khai trong docs) — chỉ phù hợp khi toàn bộ là dữ liệu mẫu.
 */
import 'reflect-metadata';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { finished } from 'node:stream/promises';
import { loadEnv } from '../../src/config/env';
import { appSchemas, appliedMigrations, CollectStream, copyDatabase, DUMP_DIR, DUMP_FILE, EXCLUDE_TABLE_DATA, MANIFEST_FILE, psql, streamExec, tableCounts, targetFromUrl } from './lib';
import { findLeaks, parseScrubOutput, SCRUB_SQL } from './scrub';
const MAX_BYTES = 90 * 1024 * 1024; // GitHub từ chối file > 100 MB

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const env = loadEnv();
  const t = targetFromUrl(env.EF_DATABASE_URL, argValue('--db'));
  console.log(`Dump DB "${t.db}" (container ${t.container}) …`);

  const schemas = appSchemas(t);
  const migrations = appliedMigrations(t);
  if (schemas.length === 0 || migrations.length === 0) {
    console.error('DB chưa có schema/migration của ứng dụng — chạy "npx prisma migrate deploy" và seed trước.');
    return 1;
  }
  const sourceCounts = tableCounts(t, schemas);

  // Ẩn danh trên bản sao tạm (không đụng DB gốc)
  const scrub = !process.argv.includes('--no-scrub');
  const tmpDb = `${t.db}_dumptmp`;
  let dumpDb = t.db;
  let needles: string[] = [];
  let scrubbedAccounts = 0;
  try {
    if (scrub) {
      console.log(`Sao chép DB sang "${tmpDb}" để ẩn danh …`);
      psql(t, `DROP DATABASE IF EXISTS "${tmpDb}" WITH (FORCE);`, 'postgres');
      psql(t, `CREATE DATABASE "${tmpDb}";`, 'postgres');
      await copyDatabase(t, t.db, tmpDb);
      const copied = tableCounts(t, schemas, tmpDb);
      const diverged = Object.entries(sourceCounts).filter(([name, n]) => (copied[name] ?? 0) !== n);
      if (diverged.length > 0) {
        console.error(`Sao chép DB không đủ dòng: ${diverged.slice(0, 5).map(([n, c]) => `${n} (${c} → ${copied[n] ?? 0})`).join(', ')}`);
        return 1;
      }
      const res = parseScrubOutput(psql(t, SCRUB_SQL, tmpDb));
      needles = res.needles;
      scrubbedAccounts = res.accounts;
      dumpDb = tmpDb;
    }

    fs.mkdirSync(DUMP_DIR, { recursive: true });
    const tmp = `${DUMP_FILE}.tmp`;
    const out = fs.createWriteStream(tmp);
    const args = [
      'pg_dump', '-U', t.user, '-d', dumpDb,
      '--format=custom', '--compress=9', '--data-only', '--no-owner', '--no-privileges',
      ...schemas.flatMap((s) => ['-n', s]),
      ...EXCLUDE_TABLE_DATA.flatMap((p) => ['--exclude-table-data', p]),
    ];
    await streamExec(t, args, { stdout: out });
    await finished(out); // pipe() đã tự đóng stream khi pg_dump xong — chờ ghi hết ra đĩa

    // Dò rò rỉ: nội dung dump (dạng text) không được còn chuỗi nhạy cảm của tài khoản đã ẩn danh
    if (scrub && needles.length > 0) {
      const text = new CollectStream();
      await streamExec(t, ['pg_restore', '--data-only', '-f', '-'], { stdin: fs.createReadStream(tmp), stdout: text });
      const leaks = findLeaks(text.text(), needles);
      if (leaks.length > 0) {
        fs.rmSync(tmp, { force: true });
        console.error(`HUỶ dump: vẫn còn ${leaks.length} chuỗi nhạy cảm trong nội dung (vd ${leaks.slice(0, 3).map((l) => l.replace(/^(.{2}).*(@.*)?$/, '$1***')).join(', ')}). Dùng --no-scrub nếu chắc chắn muốn đóng gói nguyên bản.`);
        return 1;
      }
    }
    fs.renameSync(tmp, DUMP_FILE);

    const size = fs.statSync(DUMP_FILE).size;
    if (size > MAX_BYTES) {
      console.error(`File dump ${(size / 1048576).toFixed(1)} MB vượt giới hạn ${MAX_BYTES / 1048576} MB của GitHub — không commit được. Cân nhắc Git LFS hoặc thêm bảng vào EXCLUDE_TABLE_DATA.`);
      return 1;
    }
    const manifest = { createdAt: new Date().toISOString(), database: t.db, appMigrations: migrations, schemas, excludedData: EXCLUDE_TABLE_DATA, tables: sourceCounts };
    fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 1) + '\n');

    const rows = Object.entries(sourceCounts).filter(([name]) => !EXCLUDE_TABLE_DATA.some((p) => (p.startsWith('*.') ? name.endsWith(p.slice(1)) : name === p))).reduce((s, [, n]) => s + n, 0);
    console.log(`Xong: ${path.relative(process.cwd(), DUMP_FILE)} — ${(size / 1048576).toFixed(2)} MB, ${Object.keys(sourceCounts).length} bảng, ${rows} dòng, ${migrations.length} migration.`);
    if (scrub) console.log(`Đã ẩn danh ${scrubbedAccounts} tài khoản ngoài miền mẫu, xoá IP/user-agent; dò lại: không còn chuỗi nhạy cảm.`);
    else console.warn('CẢNH BÁO: --no-scrub — dump giữ NGUYÊN email/IP thật (nếu có). Đừng commit lên repo công khai.');
    const nonSeedImages = psql(t, `select count(*) from product.product_images where url not like '%/ecofashion/seed/%';`, dumpDb).trim();
    if (Number(nonSeedImages) > 0) console.warn(`LƯU Ý: ${nonSeedImages} ảnh sản phẩm không thuộc thư mục seed — link trỏ về tài khoản Cloudinary của máy gốc (ảnh còn truy cập được khi tài khoản đó còn).`);
    console.log('Commit cả 2 file trong scripts/db/demo-data/ (dump + manifest). Máy khác: npm run db:restore -- --yes');
    return 0;
  } finally {
    if (scrub) psql(t, `DROP DATABASE IF EXISTS "${tmpDb}" WITH (FORCE);`, 'postgres');
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
