import { Inject, Injectable } from '@nestjs/common';
import { AccessToken, RoomServiceClient, WebhookReceiver, TrackSource } from 'livekit-server-sdk';
import { ENV } from '@config/config.module';
import type { Env } from '@config/env';
import { ServiceUnavailableException } from '@common/exception/business.exception';

/* LiveKit thật, không fallback video giả. Network ngoài transaction; token chỉ cấp đúng room/role và không cho data bypass chat BE. */
@Injectable()
export class LiveKitProvider {
  constructor(@Inject(ENV) private readonly env: Env) {}
  get configured(): boolean {
    return !!(this.env.EF_LIVEKIT_URL && this.env.EF_LIVEKIT_API_KEY && this.env.EF_LIVEKIT_API_SECRET);
  }
  get serverUrl(): string {
    this.assertConfigured();
    return this.env.EF_LIVEKIT_URL;
  }
  private assertConfigured(): void {
    if (!this.configured)
      throw new ServiceUnavailableException(
        'LIVE_MEDIA_UNAVAILABLE',
        'Dịch vụ phát trực tiếp chưa được cấu hình.',
      );
  }
  private client(): RoomServiceClient {
    this.assertConfigured();
    return new RoomServiceClient(
      this.env.EF_LIVEKIT_URL.replace(/^ws/, 'http'),
      this.env.EF_LIVEKIT_API_KEY,
      this.env.EF_LIVEKIT_API_SECRET,
      { requestTimeout: 10, failover: false },
    );
  }
  async create(room: string, maxParticipants: number): Promise<void> {
    await this.client().createRoom({ name: room, maxParticipants, emptyTimeout: 60, departureTimeout: 20 });
  }
  async stop(room: string): Promise<void> {
    try {
      const client = this.client();
      const participants = await client.listParticipants(room);
      for (const participant of participants)
        await client.removeParticipant(room, participant.identity, {
          revokeTokenTs: BigInt(Math.floor(Date.now() / 1000) + 1),
        });
      await client.deleteRoom(room);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'not_found') return;
      throw error;
    }
  }
  async remove(room: string, identity: string): Promise<void> {
    await this.client().removeParticipant(room, identity, {
      revokeTokenTs: BigInt(Math.floor(Date.now() / 1000) + 1),
    });
  }
  async participants(room: string) {
    return this.client().listParticipants(room);
  }
  async token(room: string, identity: string, publish: boolean, name?: string) {
    this.assertConfigured();
    const token = new AccessToken(this.env.EF_LIVEKIT_API_KEY, this.env.EF_LIVEKIT_API_SECRET, {
      identity,
      name,
      ttl: 120,
    });
    token.addGrant({
      roomJoin: true,
      room,
      canPublish: publish,
      canSubscribe: true,
      canPublishData: false,
      canPublishSources: publish ? [TrackSource.CAMERA, TrackSource.MICROPHONE] : [],
    });
    return {
      token: await token.toJwt(),
      serverUrl: this.serverUrl,
      participantIdentity: identity,
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    };
  }
  async verifyWebhook(body: string, authorization?: string) {
    this.assertConfigured();
    return new WebhookReceiver(this.env.EF_LIVEKIT_API_KEY, this.env.EF_LIVEKIT_API_SECRET).receive(
      body,
      authorization,
    );
  }
}
