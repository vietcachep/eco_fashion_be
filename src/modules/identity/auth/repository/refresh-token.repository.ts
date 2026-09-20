import { Injectable } from '@nestjs/common';
import { PrismaService } from '@common/prisma/prisma.service';
import type { Tx } from '@common/prisma/types';

export interface RefreshTokenRow {
  id: string;
  userId: string;
  familyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
}

/*
 * Bảng identity.refresh_tokens. `findByHashForUpdate` khoá dòng bằng SELECT ... FOR UPDATE để hai request refresh
 * cùng một token trên hai instance không cùng rotate (request thua thấy revoked → REUSED → thu hồi họ).
 */
@Injectable()
export class RefreshTokenRepository {
  constructor(private readonly prisma: PrismaService) {}

  async insert(
    data: { userId: string; tokenHash: string; familyId: string; deviceName: string | null; ipAddress: string | null; userAgent: string | null; expiresAt: Date },
    tx?: Tx | null,
  ): Promise<{ id: string }> {
    return (tx ?? this.prisma).refreshToken.create({ data, select: { id: true } });
  }

  async findByHashForUpdate(tokenHash: string, tx: Tx): Promise<RefreshTokenRow | null> {
    const rows = await tx.$queryRaw<
      Array<{ id: string; user_id: string; family_id: string; expires_at: Date; revoked_at: Date | null; revoked_reason: string | null }>
    >`SELECT id, user_id, family_id, expires_at, revoked_at, revoked_reason
      FROM "identity"."refresh_tokens" WHERE token_hash = ${tokenHash} FOR UPDATE`;
    const r = rows[0];
    return r ? { id: r.id, userId: r.user_id, familyId: r.family_id, expiresAt: r.expires_at, revokedAt: r.revoked_at, revokedReason: r.revoked_reason } : null;
  }

  async findByHash(tokenHash: string): Promise<RefreshTokenRow | null> {
    return this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true, familyId: true, expiresAt: true, revokedAt: true, revokedReason: true },
    });
  }

  async markRotated(id: string, replacedById: string, tx: Tx): Promise<void> {
    await tx.refreshToken.update({ where: { id }, data: { revokedAt: new Date(), revokedReason: 'ROTATED', replacedById, lastUsedAt: new Date() } });
  }

  async revokeFamily(familyId: string, reason: string, tx?: Tx | null): Promise<number> {
    const r = await (tx ?? this.prisma).refreshToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason } });
    return r.count;
  }

  async revokeAllOfUser(userId: string, reason: string, tx?: Tx | null): Promise<number> {
    const r = await (tx ?? this.prisma).refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason } });
    return r.count;
  }

  /* Dọn token đã hết hạn/thu hồi quá 30 ngày (job định kỳ) — bảng append-only không được phình vô hạn. */
  async purgeOld(olderThan: Date): Promise<number> {
    const r = await this.prisma.refreshToken.deleteMany({
      where: { OR: [{ expiresAt: { lt: olderThan } }, { revokedAt: { lt: olderThan } }] },
    });
    return r.count;
  }
}
