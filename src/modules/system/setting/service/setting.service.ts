import { Injectable } from '@nestjs/common';
import { CacheService } from '@common/cache/cache.service';
import { BusinessException, NotFoundException } from '@common/exception/business.exception';
import { PrismaService } from '@common/prisma/prisma.service';
import { Prisma } from '@common/prisma/types';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { SystemAuditLogService } from '../../audit/system-audit-log.service';
import { SETTING_DEFAULTS, SYSTEM_AUDIT, SYSTEM_CACHE, SYSTEM_ERR } from '../../foundation/system.constants';

export interface SettingRow {
  key: string;
  value: unknown;
  groupCode: string;
  description: string | null;
  isPublic: boolean;
  updatedAt: string;
}

/*
 * Tham số vận hành: đọc qua cache 10' (order/cart/payment hỏi mỗi request), ghi → audit + xoá cache.
 * Khoá phải có trong SETTING_DEFAULTS (không tạo khoá tự do — tránh "tham số ma"); thiếu trong DB thì trả mặc định.
 */
@Injectable()
export class SettingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly audit: SystemAuditLogService,
  ) {}

  private async all(): Promise<Record<string, unknown>> {
    return this.cache.getOrSet(SYSTEM_CACHE.settings, 'all', async () => {
      const rows = await this.prisma.setting.findMany();
      const out: Record<string, unknown> = {};
      for (const [k, d] of Object.entries(SETTING_DEFAULTS)) out[k] = d.value;
      for (const r of rows) out[r.key] = r.value;
      return out;
    });
  }

  async get<T = unknown>(key: string): Promise<T> {
    const all = await this.all();
    if (!(key in all)) throw new NotFoundException(SYSTEM_ERR.SETTING_NOT_FOUND, `Không có tham số '${key}'`);
    return all[key] as T;
  }

  async getNumber(key: string): Promise<number> {
    const v = await this.get(key);
    return typeof v === 'number' ? v : Number(v);
  }

  async listPublic(): Promise<Record<string, unknown>> {
    const all = await this.all();
    return Object.fromEntries(Object.entries(all).filter(([k]) => SETTING_DEFAULTS[k]?.isPublic));
  }

  async listAdmin(): Promise<SettingRow[]> {
    const rows = new Map((await this.prisma.setting.findMany()).map((r) => [r.key, r]));
    return Object.entries(SETTING_DEFAULTS).map(([key, d]) => {
      const r = rows.get(key);
      return { key, value: r?.value ?? d.value, groupCode: d.group, description: d.description, isPublic: d.isPublic, updatedAt: r?.updatedAt.toISOString() ?? '' };
    });
  }

  async update(actor: AuthenticatedActor, key: string, value: unknown): Promise<SettingRow> {
    const def = SETTING_DEFAULTS[key];
    if (!def) throw new NotFoundException(SYSTEM_ERR.SETTING_NOT_FOUND, `Không có tham số '${key}'`);
    if (typeof value !== typeof def.value) throw new BusinessException('COMMON_VALIDATION_ERROR', `Tham số '${key}' phải là ${typeof def.value}`);
    if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Giá trị phải là số không âm');
    const before = await this.get(key);
    const json = JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
    const saved = await this.prisma.$transaction(async (tx) => {
      const r = await tx.setting.upsert({
        where: { key },
        create: { key, value: json, groupCode: def.group, description: def.description, isPublic: def.isPublic, updatedBy: actor.userId },
        update: { value: json, updatedBy: actor.userId },
      });
      await this.audit.write(tx, actor, { action: SYSTEM_AUDIT.SETTING_UPDATED, entityType: 'setting', entityCode: key, before: { value: before }, after: { value } });
      return r;
    });
    await this.cache.delByPrefix(SYSTEM_CACHE.settings);
    return { key, value: saved.value, groupCode: def.group, description: def.description, isPublic: def.isPublic, updatedAt: saved.updatedAt.toISOString() };
  }
}
