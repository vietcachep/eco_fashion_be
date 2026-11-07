import { Injectable } from '@nestjs/common';
import { Prisma } from '@common/prisma/types';
import { UnauthorizedException } from '@common/exception/business.exception';
import { LiveRepository } from '../live.repository';
import { LiveService } from '../live.service';

interface MediaPayload {
  participant?: { identity?: string };
  track?: { type?: string; source?: string };
  createdAt?: string | number;
}

/* Webhook ký LiveKit→inbox unique→state CAS. Network kiểm phòng nằm ngoài transaction; timestamp không được hồi sinh terminal. */
@Injectable()
export class LiveMediaService {
  constructor(
    private readonly live: LiveService,
    private readonly repo: LiveRepository,
  ) {}
  async receive(body: string, authorization?: string) {
    let event: Awaited<ReturnType<LiveService['media']['verifyWebhook']>>;
    try {
      event = await this.live.media.verifyWebhook(body, authorization);
    } catch {
      throw new UnauthorizedException('LIVE_WEBHOOK_INVALID', 'Chữ ký webhook livestream không hợp lệ.');
    }
    const roomId = event.room?.name;
    if (!roomId || !event.id) return;
    const json = event.toJson() as Prisma.InputJsonObject;
    await this.repo.db.liveMediaInbox.upsert({
      where: { id: event.id },
      create: { id: event.id, event: event.event, roomId, payload: json },
      update: {},
    });
    await this.process(event.id);
  }
  async process(id: string) {
    await this.repo.transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM livestream.media_inbox WHERE id=${id} FOR UPDATE`;
      const row = await tx.liveMediaInbox.findUnique({ where: { id } });
      if (!row || row.processedAt) return;
      const s = await tx.liveSession.findUnique({ where: { providerRoomId: row.roomId } });
      if (s) {
        await this.repo.rowLock(tx, s.id);
        const current = await this.live.required(s.id, tx);
        const p = row.payload as MediaPayload;
        const isHost = p.participant?.identity === `host-${s.id}`;
        const eventTime = Number(p.createdAt ?? 0) * 1000;
        if (['starting', 'live', 'reconnecting'].includes(current.state)) {
          if (
            row.event === 'track_published' &&
            isHost &&
            (p.track?.type === 'VIDEO' || p.track?.source === 'CAMERA')
          ) {
            if (!eventTime || eventTime >= current.createdAt.getTime() - 1000) {
              const first = !current.startedAt;
              const fresh = await tx.liveSession.update({
                where: { id: s.id },
                data: {
                  state: 'live',
                  startedAt: current.startedAt ?? new Date(eventTime || Date.now()),
                  reconnectUntil: null,
                  startDeadline: null,
                  version: { increment: 1 },
                },
              });
              await this.repo.event(tx, s.id, 'session.state_changed', {
                state: 'live',
                version: fresh.version,
                ...(first && s.mode === 'public' ? { notifyFollowers: true } : {}),
              });
            }
          } else if (
            (row.event === 'participant_left' || row.event === 'participant_connection_aborted') &&
            isHost &&
            current.state === 'live'
          ) {
            if (!current.startedAt || !eventTime || eventTime >= current.startedAt.getTime()) {
              const fresh = await tx.liveSession.update({
                where: { id: s.id },
                data: {
                  state: 'reconnecting',
                  reconnectUntil: new Date(Date.now() + 90_000),
                  version: { increment: 1 },
                },
              });
              await this.repo.event(tx, s.id, 'session.state_changed', {
                state: 'reconnecting',
                version: fresh.version,
              });
            }
          } else if (row.event === 'room_finished') {
            const fresh = await tx.liveSession.update({
              where: { id: s.id },
              data: {
                state: 'ended',
                endedAt: new Date(),
                endReason: 'Phòng video đã đóng',
                mediaStopStatus: 'confirmed',
                version: { increment: 1 },
              },
            });
            await this.repo.event(tx, s.id, 'session.state_changed', {
              state: 'ended',
              version: fresh.version,
            });
          }
        }
      }
      await tx.liveMediaInbox.update({ where: { id }, data: { processedAt: new Date() } });
    });
  }
}
