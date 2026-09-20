import type { Prisma } from '../../generated/prisma/client';
import { RequestTraceContext } from '../request/request-trace.context';

export const OUTBOX_STATUS = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  DONE: 'DONE',
  FAILED: 'FAILED',
} as const;

export interface OutboxEventInput {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  eventVersion?: string;
}

/* Dòng outbox khớp cột `<schema>.outbox_events` (khuôn chung trong *.prisma của mọi module). */
export interface OutboxEventRow {
  eventType: string;
  eventVersion: string;
  aggregateType: string;
  aggregateId: string;
  payload: Prisma.InputJsonObject;
  status: string;
  retryCount: number;
  nextAttemptAt: Date;
  requestId: string | null;
}

export interface OutboxDelegate {
  create(args: { data: OutboxEventRow }): Promise<unknown>;
}

/* Thông điệp mà relay đẩy tới listener — KHÔNG mang model Prisma. */
export interface OutboxEventMessage {
  id: string;
  module: string;
  eventType: string;
  eventVersion: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  requestId: string | null;
  createdAt: string;
}

/*
 * Ghi outbox event vào bảng của module TRONG transaction nghiệp vụ (AGENTS.md — Transactional Outbox Rule).
 * Worker `OutboxRelay` của module claim + phát sau commit.
 */
export async function writeOutboxEvent(delegate: OutboxDelegate, input: OutboxEventInput): Promise<void> {
  await delegate.create({
    data: {
      eventType: input.eventType,
      eventVersion: input.eventVersion ?? 'v1',
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      payload: JSON.parse(JSON.stringify(input.payload)) as Prisma.InputJsonObject,
      status: OUTBOX_STATUS.PENDING,
      retryCount: 0,
      nextAttemptAt: new Date(),
      requestId: RequestTraceContext.currentRequestId() || null,
    },
  });
}
