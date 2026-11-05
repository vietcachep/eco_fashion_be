import { HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import type Redis from 'ioredis';
import type { PrismaService } from '@common/prisma/prisma.service';
import { HealthController } from './controller/health.controller';
import { HealthService, isApiServing } from './service/health.service';
import { WorkerHeartbeatJob } from './service/worker-heartbeat.job';
import { WORKER_HEARTBEAT_KEY, WORKER_HEARTBEAT_STALE_MS, WorkerHeartbeatService } from './service/worker-heartbeat.service';
import { withTimeout } from './service/with-timeout';

/*
 * AUD-12a (G82) — /health trả 503 khi DB/Redis DOWN; worker chết không còn "UP" im lặng (nhịp tim Redis).
 * Mã kịch bản: OPS-04d (Postgres tắt ⇒ health 5xx), OPS-04c (Redis tắt), OPS-01y (worker chết ⇒ báo DOWN), OPS-04b/e (hồi phục ⇒ UP).
 */

type RedisMock = { ping: jest.Mock<Promise<string>, []>; get: jest.Mock<Promise<string | null>, [string]>; set: jest.Mock<Promise<'OK'>, unknown[]> };

function build(opts: { db?: 'up' | 'down' | 'hang'; redis?: 'up' | 'down'; heartbeat?: string | null; heartbeatReadError?: boolean } = {}) {
  const { db = 'up', redis = 'up', heartbeat = null, heartbeatReadError = false } = opts;
  const prisma = {
    $queryRaw: jest.fn((..._a: unknown[]): Promise<unknown> => {
      if (db === 'down') return Promise.reject(new Error('Can\'t reach database server'));
      if (db === 'hang') return new Promise(() => undefined);
      return Promise.resolve([{ '?column?': 1 }]);
    }),
  };
  const redisMock: RedisMock = {
    ping: jest.fn(() => (redis === 'up' ? Promise.resolve('PONG') : Promise.reject(new Error('Stream isn\'t writeable')))),
    get: jest.fn((_k: string) => {
      if (heartbeatReadError || redis === 'down') return Promise.reject(new Error('Stream isn\'t writeable'));
      return Promise.resolve(heartbeat);
    }),
    set: jest.fn(() => Promise.resolve('OK' as const)),
  };
  const hb = new WorkerHeartbeatService(redisMock as unknown as Redis);
  const service = new HealthService(prisma as unknown as PrismaService, redisMock as unknown as Redis, hb);
  const controller = new HealthController(service);
  return { prisma, redis: redisMock, hb, service, controller };
}

const beatAt = (secondsAgo: number) => JSON.stringify({ at: new Date(Date.now() - secondsAgo * 1000).toISOString(), pid: 123 });
const req = { originalUrl: '/api/v1/health' } as unknown as Request;
function makeRes() {
  const status = jest.fn();
  return { res: { status } as unknown as Response, status };
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('GET /health — mã HTTP theo DB/Redis (AUD-12a)', () => {
  it('[OPS-04b] DB + Redis + worker đều ổn ⇒ status UP, HTTP 200 (không đặt mã lỗi), success=true', async () => {
    const f = build({ heartbeat: beatAt(3) });
    const { res, status } = makeRes();
    const body = await f.controller.check(req, res);
    expect(status).not.toHaveBeenCalled();
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({ status: 'UP', database: 'UP', redis: 'UP', worker: 'UP' });
    expect(body.data?.workerLastSeenAt).toEqual(expect.any(String));
  });

  it('[OPS-04d] Postgres DOWN ⇒ HTTP 503, body vẫn có data (database=DOWN) + error SYSTEM_UNHEALTHY, success=false', async () => {
    const f = build({ db: 'down', heartbeat: beatAt(3) });
    const { res, status } = makeRes();
    const body = await f.controller.check(req, res);
    expect(status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    expect(body.success).toBe(false);
    expect(body.data).toMatchObject({ status: 'DEGRADED', database: 'DOWN', redis: 'UP' });
    expect(body.error).toMatchObject({ code: 'SYSTEM_UNHEALTHY', details: { database: 'DOWN', redis: 'UP' } });
  });

  it('[OPS-04c] Redis DOWN ⇒ HTTP 503; worker không xác minh được thì UNKNOWN (không đổ lỗi cho worker)', async () => {
    const f = build({ redis: 'down' });
    const { res, status } = makeRes();
    const body = await f.controller.check(req, res);
    expect(status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    expect(body.data).toMatchObject({ status: 'DEGRADED', database: 'UP', redis: 'DOWN', worker: 'UNKNOWN', workerLastSeenAt: null });
  });

  it('DB và Redis cùng DOWN ⇒ 503', async () => {
    const f = build({ db: 'down', redis: 'down' });
    const { res, status } = makeRes();
    await f.controller.check(req, res);
    expect(status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
  });

  it('[OPS-04e] hạ tầng hồi phục ⇒ lần gọi sau lại UP + 200, không cần khởi động lại', async () => {
    const f = build({ db: 'down', heartbeat: beatAt(2) });
    const first = makeRes();
    await f.controller.check(req, first.res);
    expect(first.status).toHaveBeenCalledWith(503);
    f.prisma.$queryRaw.mockImplementation(() => Promise.resolve([{ '?column?': 1 }]));
    const second = makeRes();
    const body = await f.controller.check(req, second.res);
    expect(second.status).not.toHaveBeenCalled();
    expect(body.data?.status).toBe('UP');
  });

  it('DB treo (không trả lời) ⇒ hết 2 giây coi như DOWN, health KHÔNG treo theo', async () => {
    jest.useFakeTimers();
    const f = build({ db: 'hang', heartbeat: beatAt(1) });
    const pending = f.service.check();
    await jest.advanceTimersByTimeAsync(2_100);
    const h = await pending;
    expect(h.database).toBe('DOWN');
    expect(h.redis).toBe('UP');
    expect(isApiServing(h)).toBe(false);
  });

  it('isApiServing: chỉ DB+Redis quyết định; worker DOWN không làm API "không phục vụ"', async () => {
    const h = await build({ heartbeat: null }).service.check();
    expect(h.worker).toBe('DOWN');
    expect(isApiServing(h)).toBe(true);
  });
});

describe('Nhịp tim worker (AUD-12a / OPS-01y)', () => {
  it('[OPS-01y] worker chết (không có nhịp) ⇒ /health: worker=DOWN, status=DEGRADED, nhưng vẫn HTTP 200 (API còn phục vụ — không kéo khỏi load balancer)', async () => {
    const f = build({ heartbeat: null });
    const { res, status } = makeRes();
    const body = await f.controller.check(req, res);
    expect(status).not.toHaveBeenCalled();
    expect(body.data).toMatchObject({ status: 'DEGRADED', database: 'UP', redis: 'UP', worker: 'DOWN', workerLastSeenAt: null });
  });

  it('[OPS-01y] nhịp cuối cũ hơn 60 giây ⇒ DOWN kèm lastSeenAt; đúng 60 giây còn UP; nhịp mới ⇒ UP', async () => {
    const stale = await build({ heartbeat: beatAt(WORKER_HEARTBEAT_STALE_MS / 1000 + 5) }).hb.read();
    expect(stale.status).toBe('DOWN');
    expect(stale.lastSeenAt).toEqual(expect.any(String));
    const now = new Date('2026-10-27T12:00:00.000Z');
    const boundary = await build({ heartbeat: JSON.stringify({ at: new Date(now.getTime() - WORKER_HEARTBEAT_STALE_MS).toISOString() }) }).hb.read(now);
    expect(boundary.status).toBe('UP');
    const fresh = await build({ heartbeat: beatAt(4) }).hb.read();
    expect(fresh.status).toBe('UP');
  });

  it('giá trị rác trong khoá (không phải JSON / thiếu `at`) ⇒ DOWN, không ném', async () => {
    for (const raw of ['not-json', '{}', JSON.stringify({ at: 'không phải ngày' }), JSON.stringify({ at: 123 })]) {
      await expect(build({ heartbeat: raw }).hb.read()).resolves.toEqual({ status: 'DOWN', lastSeenAt: null });
    }
  });

  it('không đọc được Redis ⇒ UNKNOWN (không kết luận worker chết), không ném', async () => {
    await expect(build({ heartbeatReadError: true }).hb.read()).resolves.toEqual({ status: 'UNKNOWN', lastSeenAt: null });
  });

  it('beat() ghi JSON {at,pid} vào đúng khoá với TTL', async () => {
    const f = build();
    const now = new Date('2026-10-27T12:00:00.000Z');
    await f.hb.beat(now);
    expect(f.redis.set).toHaveBeenCalledWith(WORKER_HEARTBEAT_KEY, JSON.stringify({ at: now.toISOString(), pid: process.pid }), 'EX', expect.any(Number));
  });

  it('vòng khép kín: nhịp ghi bởi worker được API đọc là UP', async () => {
    const f = build();
    let stored: string | null = null;
    f.redis.set.mockImplementation((_k: unknown, v: unknown) => { stored = v as string; return Promise.resolve('OK' as const); });
    f.redis.get.mockImplementation(() => Promise.resolve(stored));
    expect((await f.hb.read()).status).toBe('DOWN');
    await f.hb.beat();
    expect((await f.hb.read()).status).toBe('UP');
  });

  it('GET /health/worker: UP ⇒ 200; DOWN hoặc UNKNOWN ⇒ 503 với mã SYSTEM_WORKER_DOWN, không lộ chi tiết lỗi', async () => {
    const up = makeRes();
    const okBody = await build({ heartbeat: beatAt(2) }).controller.checkWorker(req, up.res);
    expect(up.status).not.toHaveBeenCalled();
    expect(okBody.data).toMatchObject({ status: 'UP', staleAfterSeconds: 60 });

    const down = makeRes();
    const downBody = await build({ heartbeat: null }).controller.checkWorker(req, down.res);
    expect(down.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    expect(downBody.success).toBe(false);
    expect(downBody.error).toMatchObject({ code: 'SYSTEM_WORKER_DOWN', details: { worker: 'DOWN' } });
    expect(JSON.stringify(downBody)).not.toMatch(/stream|writeable|econnrefused/i);

    const unknown = makeRes();
    await build({ heartbeatReadError: true }).controller.checkWorker(req, unknown.res);
    expect(unknown.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
  });
});

describe('WorkerHeartbeatJob', () => {
  it('tick ghi nhịp; Redis lỗi ⇒ không ném (worker không được thoát), chỉ cảnh báo MỘT lần tới khi hồi phục', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const beat = jest.fn<Promise<void>, []>(() => Promise.resolve());
    const job = new WorkerHeartbeatJob({ beat } as unknown as WorkerHeartbeatService);
    await job.tick();
    expect(beat).toHaveBeenCalledTimes(1);
    beat.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(job.tick()).resolves.toBeUndefined();
    await expect(job.tick()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    beat.mockResolvedValue(undefined);
    await job.tick();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('không chạy chồng: tick đang ghi dở thì tick sau bị bỏ qua', async () => {
    let release: () => void = () => undefined;
    const beat = jest.fn<Promise<void>, []>(() => new Promise<void>((r) => { release = r; }));
    const job = new WorkerHeartbeatJob({ beat } as unknown as WorkerHeartbeatService);
    const first = job.tick();
    await job.tick();
    expect(beat).toHaveBeenCalledTimes(1);
    release();
    await first;
  });
});

describe('withTimeout', () => {
  it('trả kết quả nếu kịp; hết hạn thì ném lỗi', async () => {
    await expect(withTimeout(Promise.resolve(7), 50)).resolves.toBe(7);
    jest.useFakeTimers();
    const p = withTimeout(new Promise<number>(() => undefined), 100, 'x');
    const assertion = expect(p).rejects.toThrow('x quá 100ms');
    await jest.advanceTimersByTimeAsync(101);
    await assertion;
  });
});
