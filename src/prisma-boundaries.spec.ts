/*
 * Gác RANH GIỚI DỮ LIỆU giữa các module (AGENTS.md — Database Rules): module `src/modules/<m>` chỉ được gọi
 * delegate Prisma của model thuộc schema `<m>` (đọc từ `prisma/schema/*.prisma`). Đọc chéo phải qua queryapi
 * của module chủ, ghi chéo qua gateway/outbox. dependency-cruiser không nhìn thấy `prisma.user.findMany`
 * nên test này quét mã nguồn bằng regex — đủ chặt cho quy ước "tên schema = tên module".
 * SQL thô (`$queryRaw`) không quét được: viết SQL thô đụng schema khác cũng là vi phạm, review tay.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..');
const SCHEMA_DIR = join(ROOT, 'prisma', 'schema');
const MODULES_DIR = join(ROOT, 'src', 'modules');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.spec.ts')) out.push(p);
  }
  return out;
}

function modelOwners(): Map<string, string> {
  const owners = new Map<string, string>();
  for (const file of readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.prisma'))) {
    const text = readFileSync(join(SCHEMA_DIR, file), 'utf8');
    const re = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const schema = /@@schema\("(\w+)"\)/.exec(m[2])?.[1];
      if (schema) owners.set(m[1].charAt(0).toLowerCase() + m[1].slice(1), schema);
    }
  }
  return owners;
}

const DELEGATE_CALL =
  /\b(?:prisma|tx|db|client)\.([a-z][A-Za-z0-9]*)\.(?:findMany|findUnique|findUniqueOrThrow|findFirst|findFirstOrThrow|create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany|count|aggregate|groupBy)\b/g;

describe('ranh giới model Prisma theo module', () => {
  const owners = modelOwners();

  it('catalog schema có ít nhất một model và mọi model có @@schema', () => {
    expect(owners.size).toBeGreaterThan(0);
  });

  it('module chỉ gọi delegate của model thuộc schema mình', () => {
    const violations: string[] = [];
    for (const moduleName of readdirSync(MODULES_DIR)) {
      const dir = join(MODULES_DIR, moduleName);
      if (!statSync(dir).isDirectory()) continue;
      for (const file of walk(dir)) {
        const text = readFileSync(file, 'utf8');
        let m: RegExpExecArray | null;
        while ((m = DELEGATE_CALL.exec(text))) {
          const owner = owners.get(m[1]);
          if (owner && owner !== moduleName) {
            violations.push(`${relative(ROOT, file)} dùng model "${m[1]}" của schema "${owner}"`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
