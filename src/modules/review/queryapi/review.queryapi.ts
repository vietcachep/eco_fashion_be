import { Injectable } from '@nestjs/common';
import { PrismaService } from '@common/prisma/prisma.service';

/* QueryAPI của review — ai đọc nội dung đánh giá để tóm tắt/kiểm duyệt; reporting đếm. */
@Injectable()
export class ReviewQueryApi {
  constructor(private readonly prisma: PrismaService) {}

  async approvedForProduct(productId: string, limit = 50): Promise<Array<{ id: string; rating: number; content: string; createdAt: Date }>> {
    return this.prisma.review.findMany({ where: { productId, status: 'approved', isDeleted: false }, orderBy: { createdAt: 'desc' }, take: limit, select: { id: true, rating: true, content: true, createdAt: true } });
  }

  async findById(id: string): Promise<{ id: string; productId: string; rating: number; content: string; status: string } | null> {
    return this.prisma.review.findFirst({ where: { id, isDeleted: false }, select: { id: true, productId: true, rating: true, content: true, status: true } });
  }
}
