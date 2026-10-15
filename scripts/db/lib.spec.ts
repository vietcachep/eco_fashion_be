import { diffCounts, diffMigrations, EXCLUDE_TABLE_DATA, targetFromUrl } from './lib';

describe('targetFromUrl', () => {
  it('lấy user và tên DB từ EF_DATABASE_URL, cho phép ghi đè tên DB (--db)', () => {
    expect(targetFromUrl('postgresql://ecofashion:mk@localhost:5434/ecofashion')).toMatchObject({ user: 'ecofashion', db: 'ecofashion', container: 'ecofashion-db' });
    expect(targetFromUrl('postgresql://ecofashion:mk@localhost:5434/ecofashion', 'thu_nghiem').db).toBe('thu_nghiem');
  });
});

describe('diffMigrations — DB đích phải cùng bộ migration với bản dump', () => {
  it('khớp ⇒ null', () => {
    expect(diffMigrations(['a', 'b'], ['b', 'a'])).toBeNull();
  });

  it('DB đích thiếu migration ⇒ hướng dẫn chạy migrate deploy', () => {
    const msg = diffMigrations(['a', 'b', 'c'], ['a']);
    expect(msg).toContain('còn thiếu migration');
    expect(msg).toContain('b, c');
    expect(msg).toContain('prisma migrate deploy');
  });

  it('DB đích mới hơn bản dump ⇒ yêu cầu dump lại ở máy gốc', () => {
    const msg = diffMigrations(['a'], ['a', 'z']);
    expect(msg).toContain('mới hơn bản dump');
    expect(msg).toContain('db:dump');
  });
});

describe('diffCounts — so số dòng sau restore', () => {
  it('khớp ⇒ không có lệch', () => {
    expect(diffCounts({ 'shop.shops': 18, 'product.products': 343 }, { 'shop.shops': 18, 'product.products': 343 }, [])).toEqual([]);
  });

  it('báo bảng lệch; bảng loại khỏi dump (theo mẫu *.bảng hoặc schema.bảng) được bỏ qua', () => {
    const expected = { 'shop.shops': 18, 'shop.outbox_events': 8, 'identity.refresh_tokens': 5, 'ai.usage_logs': 2 };
    const actual = { 'shop.shops': 17, 'shop.outbox_events': 0, 'identity.refresh_tokens': 0, 'ai.usage_logs': 0 };

    expect(diffCounts(expected, actual, EXCLUDE_TABLE_DATA)).toEqual(['shop.shops: dump 18 ≠ DB 17']);
  });

  it('bảng có trong manifest nhưng không có ở DB đích tính là 0 dòng', () => {
    expect(diffCounts({ 'a.b': 3 }, {}, [])).toEqual(['a.b: dump 3 ≠ DB 0']);
  });
});
