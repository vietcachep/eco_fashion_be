import type { Prisma } from '../../generated/prisma/client';
import type { AuthenticatedActor } from '../security/authenticated-actor';
import { RequestTraceContext } from '../request/request-trace.context';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  entityCode?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
}

/* Dòng audit sẵn sàng ghi — khớp cột `<schema>.audit_logs` của mọi module (khuôn chung trong *.prisma). */
export interface AuditLogRow {
  actorUserId: string | null;
  actorEmail: string | null;
  action: string;
  moduleCode: string;
  entityType: string;
  entityId: string | null;
  entityCode: string | null;
  requestId: string | null;
  idempotencyKey: string | null;
  /* JSON: undefined = cột NULL (Prisma không nhận `null` thô cho cột Json?). */
  beforeSummary: Prisma.InputJsonObject | undefined;
  afterSummary: Prisma.InputJsonObject | undefined;
  ipAddress: string | null;
  userAgent: string | null;
}

/* Delegate tối thiểu của Prisma cho bảng audit của module (vd `tx.identityAuditLog`). */
export interface AuditLogDelegate {
  create(args: { data: AuditLogRow }): Promise<unknown>;
}

/* Khoá KHÔNG BAO GIỜ được vào audit summary — factory tự che dù caller lỡ truyền. */
const SENSITIVE_KEYS = /password|token|secret|otp|cvv|card|api_key|apikey|hash/i;

export function sanitizeSummary(obj: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!obj) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.test(k)) {
      out[k] = '***';
    } else if (v instanceof Date) {
      out[k] = v.toISOString();
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = sanitizeSummary(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/*
 * Dựng dòng audit (AGENTS.md — Database Audit Log Rule): actor null = hệ thống/job; requestId/ip/ua lấy từ
 * RequestTraceContext; before/after đi qua sanitizeSummary. Module bọc thành XxxAuditLogService cố định moduleCode.
 */
export function buildAuditLog(
  moduleCode: string,
  actor: Pick<AuthenticatedActor, 'userId' | 'email'> | null,
  entry: AuditEntry,
): AuditLogRow {
  const trace = RequestTraceContext.current();
  return {
    actorUserId: actor?.userId ?? null,
    actorEmail: actor?.email ?? null,
    action: entry.action,
    moduleCode,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    entityCode: entry.entityCode ?? null,
    requestId: trace?.requestId ?? null,
    idempotencyKey: entry.idempotencyKey ?? null,
    beforeSummary: toJson(sanitizeSummary(entry.before)),
    afterSummary: toJson(sanitizeSummary(entry.after)),
    ipAddress: trace?.ip || null,
    userAgent: trace?.userAgent || null,
  };
}

/* Summary đã sanitize chỉ chứa giá trị JSON-hoá được (string/number/boolean/object/array) — ép kiểu an toàn. */
function toJson(obj: Record<string, unknown> | null): Prisma.InputJsonObject | undefined {
  return obj ? (JSON.parse(JSON.stringify(obj)) as Prisma.InputJsonObject) : undefined;
}

/* Ghi MỘT dòng audit vào bảng của module TRONG transaction caller (truyền delegate từ `tx`). */
export async function writeAuditLog(
  delegate: AuditLogDelegate,
  moduleCode: string,
  actor: Pick<AuthenticatedActor, 'userId' | 'email'> | null,
  entry: AuditEntry,
): Promise<void> {
  await delegate.create({ data: buildAuditLog(moduleCode, actor, entry) });
}
