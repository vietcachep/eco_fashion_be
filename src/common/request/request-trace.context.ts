import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RequestTrace {
  requestId: string;
  ip: string;
  userAgent: string;
}

const storage = new AsyncLocalStorage<RequestTrace>();

/*
 * Ngữ cảnh truy vết của request hiện tại (requestId/ip/userAgent) — đọc được ở bất kỳ tầng nào
 * (service, audit, outbox) mà không phải truyền tham số xuyên suốt. Worker/job không có request thì
 * tự tạo requestId riêng qua `runWith` để vết audit/outbox vẫn có mã truy.
 *
 * AsyncLocalStorage giữ đúng ngữ cảnh qua await/Promise; KHÔNG dùng biến toàn cục.
 */
export class RequestTraceContext {
  static run<T>(trace: RequestTrace, fn: () => T): T {
    return storage.run(trace, fn);
  }

  static runWith<T>(fn: () => T, partial: Partial<RequestTrace> = {}): T {
    return storage.run(
      {
        requestId: partial.requestId ?? randomUUID(),
        ip: partial.ip ?? '',
        userAgent: partial.userAgent ?? '',
      },
      fn,
    );
  }

  static current(): RequestTrace | undefined {
    return storage.getStore();
  }

  static currentRequestId(): string {
    return storage.getStore()?.requestId ?? '';
  }

  static newRequestId(): string {
    return randomUUID();
  }
}
