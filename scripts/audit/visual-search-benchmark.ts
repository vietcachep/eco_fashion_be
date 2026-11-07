/* CLI đánh giá service: không qua HTTP rate-limit; vẫn giữ cổng ngân sách provider và chỉ DB audit. */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { ImageSearchService } from '../../src/modules/ai/image-search/image-search.service';
/* JSONL runner: expected IDs do con người gán, không tự bịa accuracy từ ảnh/mock. */
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
interface BenchmarkCase { id: string; image: string; split: string; expectedProductIds: string[]; mime?: string; target?: string }
interface BenchmarkResult { id: string; split: string; negative: boolean; hit5: boolean; precision5: number; recall12: number | null; falsePositive: boolean; ms: number; mode?: string }
async function main() {
  const [manifest] = process.argv.slice(2);
  if (!manifest)
    throw new Error(
      'npx ts-node -T -r tsconfig-paths/register scripts/audit/visual-search-benchmark.ts <manifest.jsonl> --allow-paid',
    );
  const dbUrl = new URL(process.env.EF_DATABASE_URL ?? '');
  if (dbUrl.hostname !== 'localhost' || dbUrl.port !== '55445' || dbUrl.pathname !== '/fitly_visual_audit')
    throw new Error('Chỉ dùng DB đánh giá cô lập localhost55445/fitly_visual_audit');
  if (!process.argv.includes('--allow-paid'))
    throw new Error('Thêm --allow-paid để xác nhận có thể gọi AI trả phí');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const service = app.get(ImageSearchService);
  try {
    const cases = (await readFile(manifest, 'utf8'))
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as BenchmarkCase);
    const seen = new Set<string>();
    const results: BenchmarkResult[] = [];
    for (const c of cases) {
      if (
        !c.id ||
        seen.has(c.id) ||
        !Array.isArray(c.expectedProductIds) ||
        c.expectedProductIds.some((id) => typeof id !== 'string') ||
        !c.image ||
        !['tuning', 'held-out'].includes(c.split)
      )
        throw new Error('Case phải có id duy nhất, image, split và expectedProductIds (rỗng nếu no-match)');
      seen.add(c.id);
      const file = await readFile(resolve(dirname(manifest), c.image));
      const mimetype = c.mime ?? 'image/jpeg';
      if (file.length > 5 * 1024 * 1024 || !ImageSearchService.validateMagicBytes(file, mimetype))
        throw new Error('Ảnh benchmark không hợp lệ: ' + c.id);
      const start = performance.now();
      const data = await service.search(
        { guestKey: 'visual-benchmark-' + c.id },
        { buffer: file, mimetype, size: file.length },
        c.target,
      );
      if (data.searchMode === 'unavailable')
        throw new Error('Case ' + c.id + ': dịch vụ chưa sẵn sàng, không tính là no-match đúng');
      const ids = data.items.map((p) => p.id);
      const expected = new Set(c.expectedProductIds);
      const correct = ids.slice(0, 5).filter((id) => expected.has(id)).length;
      results.push({
        id: c.id,
        split: c.split,
        negative: expected.size === 0,
        hit5: correct > 0,
        precision5: correct / 5,
        recall12: expected.size ? ids.filter((id) => expected.has(id)).length / expected.size : null,
        falsePositive: expected.size === 0 && ids.length > 0,
        ms: Math.round(performance.now() - start),
        mode: data.searchMode,
      });
    }
    for (const split of ['tuning', 'held-out']) {
      const group = results.filter((r) => r.split === split),
        positive = group.filter((r) => !r.negative),
        negative = group.filter((r) => r.negative);
      const average = (rows: BenchmarkResult[], fn: (r: BenchmarkResult) => number) =>
        rows.length ? rows.reduce((sum, row) => sum + fn(row), 0) / rows.length : null;
      console.log(
        JSON.stringify({
          split,
          cases: group.length,
          hitAt5: average(positive, (r) => Number(r.hit5)),
          precisionAt5: average(positive, (r) => r.precision5),
          recallAt12: average(positive, (r) => r.recall12 ?? 0),
          noMatchFalsePositiveRate: average(negative, (r) => Number(r.falsePositive)),
          averageMs: average(group, (r) => r.ms),
          modes: [...new Set(group.map((r) => r.mode))],
          results: group,
        }),
      );
    }
  } finally {
    await app.close();
  }
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
