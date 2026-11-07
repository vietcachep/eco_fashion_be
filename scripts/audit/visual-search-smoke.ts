/* Chỉ DB audit, encoder thật, không OpenAI/tiền thật. Fixture được xoá trong finally. */
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { VisualIndexService } from '../../src/modules/ai/image-search/visual-index.service';
import { ImageSearchService } from '../../src/modules/ai/image-search/image-search.service';

async function main() {
  const url = new URL(process.env.EF_DATABASE_URL ?? '');
  if (
    url.hostname !== 'localhost' ||
    url.port !== '55445' ||
    url.pathname !== '/fitly_visual_audit' ||
    process.env.EF_OPENAI_API_KEY
  )
    throw new Error('Chỉ cho phép DB audit và không gọi AI trả phí');
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.init();
  const db = app.get(PrismaService),
    index = app.get(VisualIndexService),
    search = app.get(ImageSearchService);
  const shopId = randomUUID();
  const ids: string[] = [];
  try {
    await db.shop.create({
      data: {
        id: shopId,
        code: 'VISUAL-AUDIT',
        slug: 'visual-audit',
        name: 'Visual audit',
        ownerUserId: randomUUID(),
        status: 'approved',
      },
    });
    const response = await fetch('https://api.160.191.242.187.sslip.io/api/v1/products?pageSize=3', {
      signal: AbortSignal.timeout(15000),
    });
    const data = (await response.json()) as {
      data: { content: Array<{ name: string; imageUrl: string; categorySlug: string }> };
    };
    for (const source of data.data.content) {
      const id = randomUUID();
      ids.push(id);
      await db.product.create({
        data: {
          id,
          slug: 'visual-audit-' + id,
          name: source.name,
          shopId,
          categoryId: randomUUID(),
          categorySlug: source.categorySlug,
          basePrice: 10000,
          status: 'active',
          images: { create: { url: source.imageUrl, isPrimary: true } },
        },
      });
      await index.indexProduct(id);
    }
    const status = await index.repo.status(index.encoder.modelVersion);
    if (status.ready !== ids.length) throw new Error('Không lập đủ chỉ mục thật: ' + JSON.stringify(status));
    let passed = 0;
    const check = (name: string, ok: boolean) => {
      if (!ok) throw new Error(name);
      passed++;
      console.log('PASS ' + name);
    };
    check('model thật tạo vector cho đủ3 ảnh', ids.length === 3);
    const first = await db.productImage.findFirstOrThrow({ where: { productId: ids[0] } });
    const file = await index.images.download(first.url);
    const ranked = await index.retrieve(file);
    check('cosine tự khớp ảnh gốc gần1', ranked[0]?.productId === ids[0] && ranked[0].similarity > 0.99);
    const result = await search.search({}, file);
    check(
      'pipeline không key vẫn trả đúng ảnh và product đầu tiên',
      result.items[0]?.id === ids[0] &&
        result.items[0]?.imageUrl === first.url &&
        result.searchMode === 'visual',
    );
    await index.indexProduct(ids[0]);
    check(
      'reindex idempotent không tạo bản ghi trùng',
      (await db.productImageEmbedding.count()) === ids.length,
    );
    await db.product.update({ where: { id: ids[0] }, data: { status: 'hidden' } });
    check(
      'ảnh sản phẩm ẩn bị bỏ dù vector còn trong DB',
      !(await index.retrieve(file)).some((h) => h.productId === ids[0]),
    );
    await db.shop.update({ where: { id: shopId }, data: { status: 'suspended' } });
    check('shop bị khoá không được trả ảnh', (await index.retrieve(file)).length === 0);
    await index.indexProduct(ids[0]);
    check(
      'prune xoá ảnh index của sản phẩm không được bán',
      (await db.productImageEmbedding.count({ where: { productId: ids[0] } })) === 0,
    );
    console.log(
      JSON.stringify({ passed, kind: 'real-encoder/postgresql integration; NOT accuracy benchmark' }),
    );
  } finally {
    await db.productImageEmbedding.deleteMany({ where: { productId: { in: ids } } });
    await db.product.deleteMany({ where: { id: { in: ids } } });
    await db.shop.deleteMany({ where: { id: shopId } });
    await app.close();
  }
}
main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
