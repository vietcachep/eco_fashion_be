import { Injectable } from '@nestjs/common';
import { PageResponse } from '@common/response/api-response';
import { LoginHistoryResponse } from '../dto/login-history.response';
import { LoginHistoryRepository } from '../repository/login-history.repository';

/* Đọc lịch sử đăng nhập cho màn quản trị (identity.audit.read) và "phiên của tôi". */
@Injectable()
export class LoginHistoryService {
  constructor(private readonly repo: LoginHistoryRepository) {}

  async list(params: { page: number; size: number; email?: string; userId?: string; success?: boolean }): Promise<PageResponse<LoginHistoryResponse>> {
    const { items, total } = await this.repo.list({ skip: (params.page - 1) * params.size, take: params.size, email: params.email, userId: params.userId, success: params.success });
    return PageResponse.of(
      items.map((h) => ({ id: h.id, userId: h.userId, email: h.email, success: h.success, reason: h.reason, ipAddress: h.ipAddress, userAgent: h.userAgent, createdAt: h.createdAt.toISOString() })),
      params.page,
      params.size,
      total,
    );
  }
}
