import type { PrismaService } from '@common/prisma/prisma.service';
import { ShopRepository } from '../shop/repository/shop.repository';

/*
 * `listNonApprovedIds` đi vào `shopId NOT IN (...)` của MỌI truy vấn sản phẩm công khai. Hồ sơ tự đăng ký (PLAN-0019) chưa duyệt/bị từ chối chưa bao giờ có
 * thành viên nên không có sản phẩm — phải bị loại khỏi danh sách, nếu không mỗi lượt đăng ký làm phình `NOT IN` (chậm dần, có thể vượt giới hạn tham số).
 */
describe('ShopRepository.listNonApprovedIds', () => {
  it('chỉ lấy shop không-approved ĐÃ TỪNG có thành viên (shop chưa bao giờ có thành viên không thể có sản phẩm)', async () => {
    const findMany = jest.fn().mockResolvedValue([{ id: 'shop-khoa' }, { id: 'shop-cho-duyet-seed' }]);
    const repo = new ShopRepository({ shop: { findMany } } as unknown as PrismaService);

    const ids = await repo.listNonApprovedIds();

    expect(ids).toEqual(['shop-khoa', 'shop-cho-duyet-seed']);
    expect(findMany).toHaveBeenCalledWith({ where: { isDeleted: false, status: { not: 'approved' }, members: { some: {} } }, select: { id: true } });
  });
});
