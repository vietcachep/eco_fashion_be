import { Injectable } from '@nestjs/common';
import { CacheService } from '@common/cache/cache.service';
import { NotFoundException } from '@common/exception/business.exception';
import { PrismaService } from '@common/prisma/prisma.service';
import { money, MoneyResponse } from '@common/response/money-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { unaccent } from '@common/utils/slug';
import { SystemAuditLogService } from '../../audit/system-audit-log.service';
import { SETTING_KEY, SYSTEM_AUDIT, SYSTEM_CACHE, SYSTEM_ERR } from '../../foundation/system.constants';
import { SettingService } from '../../setting/service/setting.service';

export interface ProvinceResponse {
  code: string;
  name: string;
  region: string;
  shippingFee: MoneyResponse;
  isActive: boolean;
}

interface ProvinceRow {
  code: string;
  name: string;
  region: string;
  shippingFee: string;
  sortOrder: number;
  isActive: boolean;
}

/*
 * Tỉnh/thành + phí ship theo vùng (cache 1h). `resolve(name|code)` khớp không dấu để FE nhập tay ("Ho Chi Minh",
 * "TP. Hồ Chí Minh", "79") vẫn ra đúng tỉnh → order tính phí. Không khớp → phí mặc định (setting).
 */
@Injectable()
export class ProvinceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly settings: SettingService,
    private readonly audit: SystemAuditLogService,
  ) {}

  private async rows(): Promise<ProvinceRow[]> {
    return this.cache.getOrSet(SYSTEM_CACHE.provinces, 'all', async () =>
      (await this.prisma.province.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] })).map((p) => ({ code: p.code, name: p.name, region: p.region, shippingFee: p.shippingFee.toString(), sortOrder: p.sortOrder, isActive: p.isActive })),
    );
  }

  private static norm(s: string): string {
    return unaccent(s)
      .toLowerCase()
      .replace(/\b(tp|thanh pho|tinh)\b\.?/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  async listPublic(): Promise<ProvinceResponse[]> {
    return (await this.rows()).filter((p) => p.isActive).map((p) => ({ code: p.code, name: p.name, region: p.region, shippingFee: money(p.shippingFee), isActive: p.isActive }));
  }

  async listAdmin(): Promise<ProvinceResponse[]> {
    return (await this.rows()).map((p) => ({ code: p.code, name: p.name, region: p.region, shippingFee: money(p.shippingFee), isActive: p.isActive }));
  }

  /* Khớp theo mã trước, rồi tên không dấu (chứa hoặc bằng). */
  async resolve(codeOrName: string | null | undefined): Promise<{ code: string; name: string; shippingFee: bigint } | null> {
    if (!codeOrName) return null;
    const rows = await this.rows();
    const byCode = rows.find((p) => p.code === codeOrName.trim());
    if (byCode) return { code: byCode.code, name: byCode.name, shippingFee: BigInt(byCode.shippingFee) };
    const n = ProvinceService.norm(codeOrName);
    if (!n) return null;
    const hit = rows.find((p) => ProvinceService.norm(p.name) === n) ?? rows.find((p) => n.includes(ProvinceService.norm(p.name)) || ProvinceService.norm(p.name).includes(n));
    return hit ? { code: hit.code, name: hit.name, shippingFee: BigInt(hit.shippingFee) } : null;
  }

  /* Phí ship cho đơn: freeship khi subtotal ≥ ngưỡng; không khớp tỉnh → phí mặc định. */
  async shippingFeeFor(subtotal: bigint, provinceCodeOrName: string | null | undefined): Promise<{ fee: bigint; province: { code: string; name: string } | null }> {
    const [threshold, defaultFee, province] = await Promise.all([this.settings.getNumber(SETTING_KEY.SHIPPING_FREE_THRESHOLD), this.settings.getNumber(SETTING_KEY.SHIPPING_DEFAULT_FEE), this.resolve(provinceCodeOrName)]);
    if (threshold > 0 && subtotal >= BigInt(threshold)) return { fee: 0n, province: province ? { code: province.code, name: province.name } : null };
    return { fee: province ? province.shippingFee : BigInt(defaultFee), province: province ? { code: province.code, name: province.name } : null };
  }

  async updateFee(actor: AuthenticatedActor, code: string, patch: { shippingFee?: string; isActive?: boolean }): Promise<ProvinceResponse> {
    const before = await this.prisma.province.findUnique({ where: { code } });
    if (!before) throw new NotFoundException(SYSTEM_ERR.PROVINCE_NOT_FOUND, 'Không tìm thấy tỉnh/thành');
    const after = await this.prisma.$transaction(async (tx) => {
      const p = await tx.province.update({ where: { code }, data: { ...(patch.shippingFee !== undefined ? { shippingFee: patch.shippingFee } : {}), ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}) } });
      await this.audit.write(tx, actor, { action: SYSTEM_AUDIT.PROVINCE_UPDATED, entityType: 'province', entityCode: code, before: { shippingFee: before.shippingFee.toString(), isActive: before.isActive }, after: { shippingFee: p.shippingFee.toString(), isActive: p.isActive } });
      return p;
    });
    await this.cache.delByPrefix(SYSTEM_CACHE.provinces);
    return { code: after.code, name: after.name, region: after.region, shippingFee: money(after.shippingFee.toString()), isActive: after.isActive };
  }
}
