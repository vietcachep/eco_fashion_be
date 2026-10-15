/*
 * NẠP DUMP DỮ LIỆU MẪU  —  `npm run db:restore -- --yes`
 *
 * Nạp `scripts/db/demo-data/ecofashion-demo.dump` (do `npm run db:dump` ở máy gốc tạo) vào DB hiện tại để có dữ liệu GIỐNG HỆT máy gốc.
 *
 * ⚠ XOÁ TOÀN BỘ dữ liệu hiện có trong các bảng ứng dụng của DB đích rồi nạp lại — bắt buộc thêm `--yes` (không có thì chỉ in cảnh báo và thoát).
 * Thứ tự trên máy mới:  docker compose up -d db redis  →  npx prisma migrate deploy  →  npm run perms:sync (tuỳ)  →  npm run db:restore -- --yes
 *   (hoặc `docker compose up -d --build` rồi chạy db:restore: bước seed của compose sẽ bị ghi đè bằng dữ liệu của dump).
 * Điều kiện: DB đích đã chạy ĐỦ migration giống bản dump (tự kiểm theo manifest.json; lệch thì dừng và nói cần làm gì), user DB là superuser
 * (container compose mặc định đúng) vì dùng --disable-triggers để nạp bảng có khoá ngoại vòng.
 * Sau khi nạp: xoá cache `ef:*` trong Redis (tránh hiện dữ liệu cũ) và so số dòng từng bảng với manifest.
 * Tuỳ chọn: --db <tên> nạp vào DB khác trong cùng container (vd để thử); --keep-redis bỏ qua bước xoá cache.
 */
import 'reflect-metadata';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { loadEnv } from '../../src/config/env';
import { appSchemas, appliedMigrations, diffCounts, diffMigrations, DUMP_FILE, MANIFEST_FILE, psql, streamExec, tableCounts, targetFromUrl } from './lib';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface Manifest {
  createdAt: string;
  appMigrations: string[];
  schemas: string[];
  excludedData: string[];
  tables: Record<string, number>;
}

async function main(): Promise<number> {
  if (!fs.existsSync(DUMP_FILE) || !fs.existsSync(MANIFEST_FILE)) {
    console.error('Chưa có scripts/db/demo-data/ecofashion-demo.dump (+ manifest.json). Máy gốc chạy "npm run db:dump" rồi commit; hoặc dùng "npm run seed".');
    return 1;
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8')) as Manifest;
  const env = loadEnv();
  const t = targetFromUrl(env.EF_DATABASE_URL, argValue('--db'));

  const schemas = appSchemas(t);
  const migrationError = diffMigrations(manifest.appMigrations, appliedMigrations(t));
  if (migrationError) {
    console.error(`DB "${t.db}" không cùng phiên bản với bản dump:\n${migrationError}`);
    return 1;
  }
  const missingSchemas = manifest.schemas.filter((s) => !schemas.includes(s));
  if (missingSchemas.length > 0) {
    console.error(`DB đích thiếu schema: ${missingSchemas.join(', ')} — chạy migration trước.`);
    return 1;
  }

  const before = tableCounts(t, schemas);
  const existing = Object.values(before).reduce((s, n) => s + n, 0);
  console.log(`Bản dump tạo lúc ${manifest.createdAt}. DB đích "${t.db}" hiện có ${existing} dòng dữ liệu ứng dụng.`);
  if (!process.argv.includes('--yes')) {
    console.error('\nThao tác này XOÁ toàn bộ dữ liệu ứng dụng đang có trong DB đích rồi nạp lại từ bản dump.\nChạy lại với --yes nếu đúng ý:  npm run db:restore -- --yes');
    return 1;
  }

  // 1) dọn sạch bảng ứng dụng (giữ nguyên cấu trúc và bảng migration)
  const tables = Object.keys(before).map((n) => n.split('.').map((p) => `"${p.replace(/"/g, '""')}"`).join('.'));
  console.log(`Xoá dữ liệu cũ của ${tables.length} bảng …`);
  psql(t, `TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE;`);

  // 2) nạp dump (một transaction: lỗi thì không nạp dở)
  console.log('Nạp dữ liệu từ bản dump …');
  await streamExec(
    t,
    ['pg_restore', '-U', t.user, '-d', t.db, '--data-only', '--disable-triggers', '--no-owner', '--single-transaction', '--exit-on-error'],
    { stdin: fs.createReadStream(DUMP_FILE) },
  );

  // 3) kiểm số dòng
  const after = tableCounts(t, schemas);
  const bad = diffCounts(manifest.tables, after, manifest.excludedData);
  const rows = Object.values(after).reduce((s, n) => s + n, 0);
  console.log(`Xong: ${rows} dòng trong ${Object.keys(after).length} bảng.`);
  if (bad.length > 0) {
    console.error('Số dòng LỆCH so với manifest:\n  ' + bad.join('\n  '));
    return 1;
  }

  // 4) xoá cache Redis của ứng dụng (khoá ef:*) để API không trả dữ liệu cũ
  if (t.mode === 'local') {
    console.log('Chế độ local: bỏ qua xoá cache Redis (DB mới thì cache còn trống; nếu cần, xoá khoá ef:* trong Redis).');
  } else if (!process.argv.includes('--keep-redis')) {
    const r = spawnSync('docker', ['exec', t.redisContainer, 'sh', '-c', "redis-cli --scan --pattern 'ef:*' | xargs -r redis-cli del"], { encoding: 'utf8' });
    console.log(r.status === 0 ? 'Đã xoá cache Redis (ef:*).' : 'Không xoá được cache Redis — tự xoá khoá ef:* hoặc đợi hết TTL (1–10 phút).');
  }
  console.log('Khởi động lại API/worker nếu đang chạy.');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
