/*
 * Dùng chung cho `npm run db:dump` / `npm run db:restore` — chạy pg_dump / pg_restore / psql BÊN TRONG container Postgres của compose
 * (máy không cần cài sẵn client Postgres; phiên bản client luôn khớp server). Container mặc định `ecofashion-db` (docker-compose.yml);
 * đổi bằng EF_DB_CONTAINER. Thông tin kết nối (user, tên DB) lấy từ EF_DATABASE_URL; tên DB đích có thể ghi đè (--db) để thử trên DB phụ.
 * Chế độ LOCAL (`EF_DB_MODE=local`): chạy thẳng psql/pg_dump/pg_restore của máy/ container hiện tại, kết nối bằng host/port/mật khẩu trong EF_DATABASE_URL —
 * dùng khi script chạy TRONG container ứng dụng (deploy/docker-compose.prod.yml, image đã có postgresql-client) hoặc máy có sẵn client Postgres.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { Writable, type Readable } from 'node:stream';

export const DUMP_DIR = path.resolve(__dirname, 'demo-data');
export const DUMP_FILE = path.join(DUMP_DIR, 'ecofashion-demo.dump');
export const MANIFEST_FILE = path.join(DUMP_DIR, 'manifest.json');

export interface DbTarget {
  mode: 'docker' | 'local';
  host: string;
  port: string;
  password: string;
  container: string;
  redisContainer: string;
  user: string;
  db: string;
}

/* Dữ liệu KHÔNG đưa vào bản dump: nhật ký/phiên/hàng đợi sinh ra lúc chạy (máy khác tự tạo lại), và ảnh/log của người dùng thật. */
export const EXCLUDE_TABLE_DATA = [
  '*.outbox_events', // sự kiện chờ gửi — nạp sang máy khác sẽ phát lại (có thể gửi email thật)
  '*.processed_events',
  '*.idempotency_keys',
  'identity.refresh_tokens', // phiên đăng nhập
  'identity.login_histories',
  'ai.usage_logs', // nhật ký chi phí gọi AI thật
  'ai.try_on_jobs', // ảnh người dùng thử đồ
  'ai.style_analyses', // phân tích từ ảnh người dùng
] as const;

export function targetFromUrl(databaseUrl: string, overrideDb?: string): DbTarget {
  const u = new URL(databaseUrl);
  return {
    mode: process.env.EF_DB_MODE === 'local' ? 'local' : 'docker',
    host: u.hostname,
    port: u.port || '5432',
    password: decodeURIComponent(u.password),
    container: process.env.EF_DB_CONTAINER ?? 'ecofashion-db',
    redisContainer: process.env.EF_REDIS_CONTAINER ?? 'ecofashion-redis',
    user: decodeURIComponent(u.username),
    db: overrideDb ?? u.pathname.replace(/^\//, ''),
  };
}

/* Lệnh thực sự được spawn: docker exec vào container, hoặc chạy thẳng client Postgres (local) với -h/-p và PGPASSWORD. */
function launch(t: DbTarget, cmd: string[]): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  if (t.mode === 'local') {
    const [tool, ...rest] = cmd;
    return { file: tool, args: ['-h', t.host, '-p', t.port, ...rest], env: { ...process.env, PGPASSWORD: t.password } };
  }
  return { file: 'docker', args: ['exec', '-i', t.container, ...cmd], env: process.env };
}

/* Chạy một câu SQL (hoặc nhiều câu) qua psql trong container, trả stdout dạng text: cột cách nhau bằng TAB, mỗi dòng một bản ghi. */
export function psql(t: DbTarget, sql: string, db: string = t.db): string {
  const l = launch(t, ['psql', '-U', t.user, '-d', db, '-v', 'ON_ERROR_STOP=1', '-At', '-F', '\t', '-f', '-']);
  const r = spawnSync(l.file, l.args, { input: sql, encoding: 'utf8', maxBuffer: 1 << 28, env: l.env });
  if (r.error) throw new Error(`Không chạy được ${l.file}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`psql lỗi (${db}): ${r.stderr.trim() || `mã thoát ${r.status}`}`);
  return r.stdout;
}

/* Chạy lệnh trong container, nối stdout/stdin với stream của người gọi (dump ghi ra file, restore đọc từ file). */
export function streamExec(t: DbTarget, cmd: string[], io: { stdin?: Readable; stdout?: Writable }): Promise<void> {
  return new Promise((resolve, reject) => {
    const l = launch(t, cmd);
    const p = spawn(l.file, l.args, { stdio: [io.stdin ? 'pipe' : 'ignore', io.stdout ? 'pipe' : 'inherit', 'pipe'], env: l.env });
    let stderr = '';
    p.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    if (io.stdin && p.stdin) io.stdin.pipe(p.stdin);
    if (io.stdout && p.stdout) p.stdout.pipe(io.stdout);
    p.on('error', (e) => reject(new Error(`Không chạy được ${l.file}: ${e.message}`)));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd[0]} lỗi (mã ${code}): ${stderr.trim()}`))));
  });
}

/* Các schema của ứng dụng (mỗi module một schema) — loại public/information_schema/pg_*. */
export function appSchemas(t: DbTarget, db: string = t.db): string[] {
  return psql(t, `select schema_name from information_schema.schemata where schema_name not in ('public','information_schema') and schema_name not like 'pg\\_%' order by 1;`, db)
    .split('\n')
    .filter(Boolean);
}

/* Tên migration Prisma đã áp xong, theo thứ tự. */
export function appliedMigrations(t: DbTarget, db: string = t.db): string[] {
  return psql(t, `select migration_name from public._prisma_migrations where finished_at is not null and rolled_back_at is null order by migration_name;`, db)
    .split('\n')
    .filter(Boolean);
}

/* Số dòng CHÍNH XÁC của mọi bảng trong các schema ứng dụng: { 'schema.table': n }. */
export function tableCounts(t: DbTarget, schemas: string[], db: string = t.db): Record<string, number> {
  const list = schemas.map((s) => `'${s.replace(/'/g, "''")}'`).join(',');
  const out = psql(
    t,
    `select table_schema || '.' || table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text
       from information_schema.tables where table_type = 'BASE TABLE' and table_schema in (${list}) order by 1;`,
    db,
  );
  const counts: Record<string, number> = {};
  for (const line of out.split('\n').filter(Boolean)) {
    const [name, n] = line.split('\t');
    counts[name] = Number(n);
  }
  return counts;
}

/* So sánh danh sách migration của DB đích với bản dump. Trả thông báo lỗi (tiếng Việt) hoặc null nếu khớp. */
export function diffMigrations(dump: readonly string[], target: readonly string[]): string | null {
  const missingInTarget = dump.filter((m) => !target.includes(m));
  const extraInTarget = target.filter((m) => !dump.includes(m));
  if (missingInTarget.length === 0 && extraInTarget.length === 0) return null;
  const parts: string[] = [];
  if (missingInTarget.length > 0) parts.push(`DB đích còn thiếu migration của bản dump: ${missingInTarget.join(', ')} → chạy "npx prisma migrate deploy" (cùng commit với bản dump)`);
  if (extraInTarget.length > 0) parts.push(`DB đích có migration mới hơn bản dump: ${extraInTarget.join(', ')} → cần dump lại ở máy gốc (npm run db:dump) hoặc checkout đúng commit`);
  return parts.join('\n');
}

/* So số dòng sau restore với manifest: trả danh sách bảng lệch (bảng loại khỏi dump được bỏ qua). */
export function diffCounts(expected: Record<string, number>, actual: Record<string, number>, excluded: readonly string[]): string[] {
  const skip = (name: string): boolean =>
    excluded.some((p) => (p.startsWith('*.') ? name.endsWith(p.slice(1)) : name === p));
  const bad: string[] = [];
  for (const [name, n] of Object.entries(expected)) {
    if (skip(name)) continue;
    if ((actual[name] ?? 0) !== n) bad.push(`${name}: dump ${n} ≠ DB ${actual[name] ?? 0}`);
  }
  return bad;
}

/* Writable gom toàn bộ dữ liệu vào bộ nhớ (dùng cho kết quả pg_restore dạng text để dò rò rỉ). */
export class CollectStream extends Writable {
  private readonly chunks: Buffer[] = [];
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    this.chunks.push(chunk);
    cb();
  }
  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

/*
 * Sao chép NGUYÊN DB (cấu trúc + dữ liệu) sang DB đã tạo sẵn: pg_dump | pg_restore trong cùng container — để ẩn danh trên BẢN SAO, không đụng DB gốc.
 * pg_restore có thể trả mã 1 vì cảnh báo vô hại (vd COMMENT ON EXTENSION) nên đúng/sai được kiểm bằng so số dòng sau khi sao chép (dump.ts), không bằng mã thoát.
 */
export function copyDatabase(t: DbTarget, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ld = launch(t, ['pg_dump', '-U', t.user, '-d', from, '--format=custom', '--no-owner', '--no-privileges']);
    const lr = launch(t, ['pg_restore', '-U', t.user, '-d', to, '--no-owner']);
    const dump = spawn(ld.file, ld.args, { stdio: ['ignore', 'pipe', 'pipe'], env: ld.env });
    const restore = spawn(lr.file, lr.args, { stdio: ['pipe', 'ignore', 'pipe'], env: lr.env });
    let dumpErr = '';
    let dumpCode: number | null = null;
    dump.stderr.on('data', (d: Buffer) => (dumpErr += d.toString()));
    dump.stdout.pipe(restore.stdin);
    dump.on('error', (e) => reject(new Error(`Không chạy được ${ld.file}: ${e.message}`)));
    restore.on('error', (e) => reject(new Error(`Không chạy được ${lr.file}: ${e.message}`)));
    dump.on('close', (c) => {
      dumpCode = c;
    });
    restore.on('close', () => (dumpCode === 0 ? resolve() : reject(new Error(`pg_dump lỗi (mã ${String(dumpCode)}): ${dumpErr.trim()}`))));
  });
}
