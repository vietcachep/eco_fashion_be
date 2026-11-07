import { Inject, Logger, OnModuleDestroy } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import Redis from 'ioredis';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ENV } from '@config/config.module';
import type { Env } from '@config/env';
import { REDIS } from '@common/redis/redis.module';
import {
  actorFromPayload,
  type AuthenticatedActor,
  type JwtPayload,
} from '@common/security/authenticated-actor';
import {
  TOKEN_VALIDATION_GATEWAY,
  type TokenValidationGateway,
} from '@common/security/permission-authorization.gateway';
import { LiveMessageRequest } from './live.dto';
import { LiveService } from './live.service';

/* Socket không thừa hưởng HTTP guard: verify JWT+revocation/admission riêng, ghi chat qua cùng use case REST. Redis relay sau commit tới mọi API process. */
@WebSocketGateway({ namespace: '/live', cors: { origin: false }, transports: ['websocket'] })
export class LiveRealtime implements OnGatewayInit, OnGatewayConnection, OnModuleDestroy {
  @WebSocketServer() server: Server;
  private subscriber?: Redis;
  private readonly logger = new Logger(LiveRealtime.name);
  constructor(
    private readonly live: LiveService,
    private readonly jwt: JwtService,
    @Inject(ENV) private readonly env: Env,
    @Inject(TOKEN_VALIDATION_GATEWAY) private readonly validator: TokenValidationGateway,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}
  async afterInit() {
    this.subscriber = this.redis.duplicate();
    this.subscriber.on('error', () => this.logger.warn('Kênh realtime livestream tạm mất kết nối.'));
    this.subscriber.on('message', (_channel, raw) => {
      try {
        const msg = JSON.parse(raw) as { sessionId: string; event: string; payload: unknown };
        if (msg.sessionId && msg.event) this.server.to(msg.sessionId).emit(msg.event, msg.payload);
      } catch {
        this.logger.warn('Bỏ qua sự kiện livestream không hợp lệ.');
      }
    });
    // ioredis dùng enableOfflineQueue=false: subscribe trước ready bị từ chối và không được tự replay.
    const subscribe = () =>
      this.subscriber!.subscribe('fitly:livestream:events').catch(() =>
        this.logger.warn('Chưa đăng ký được kênh realtime; sẽ đăng ký lại khi Redis sẵn sàng.'),
      );
    this.subscriber.on('ready', () => {
      void subscribe();
    });
    if (this.subscriber.status === 'ready') await subscribe();
  }
  private async actor(socket: Socket): Promise<AuthenticatedActor | undefined> {
    const token: unknown = socket.handshake.auth.token;
    if (!token) return undefined;
    if (typeof token !== 'string') throw new Error('Token không hợp lệ');
    const payload = await this.jwt.verifyAsync<JwtPayload>(token, { secret: this.env.EF_JWT_SECRET });
    const a = actorFromPayload(payload);
    if (!(await this.validator.validate(a)).ok) throw new Error('Phiên đăng nhập đã bị thu hồi');
    return a;
  }
  async handleConnection(socket: Socket) {
    try {
      const origin = socket.handshake.headers.origin;
      if (
        origin &&
        !this.env.EF_CORS_ORIGINS.split(',')
          .map((o) => o.trim())
          .includes(origin)
      )
        throw new Error('Origin không được phép');
      const { sessionId, admissionId, guestKey } = socket.handshake.auth as Record<string, unknown>;
      if (typeof sessionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(sessionId))
        throw new Error('Thiếu phiên live');
      await this.live.socketAccess(
        sessionId,
        await this.actor(socket),
        typeof admissionId === 'string' ? admissionId : undefined,
        typeof guestKey === 'string' ? guestKey : undefined,
      );
      (socket.data as { sessionId?: string }).sessionId = sessionId;
      await socket.join(sessionId);
    } catch {
      socket.emit('live.error', { message: 'Không thể vào kênh tương tác. Hãy kết nối lại.' });
      socket.disconnect(true);
    }
  }
  @SubscribeMessage('message.send')
  async send(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown) {
    try {
      const actor = await this.actor(socket);
      if (!actor) throw new Error('Bạn cần đăng nhập để bình luận');
      const dto = plainToInstance(LiveMessageRequest, body);
      if ((await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).length)
        throw new Error('Bình luận không hợp lệ');
      const id: unknown = (socket.data as { sessionId?: string }).sessionId;
      if (typeof id !== 'string') throw new Error('Bạn chưa vào phiên live');
      return { ok: true, data: await this.live.sendMessage(actor, id, dto) };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Không gửi được bình luận' };
    }
  }
  async onModuleDestroy() {
    await this.subscriber?.quit().catch(() => undefined);
  }
}
