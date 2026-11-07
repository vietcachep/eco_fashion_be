import { Global, Module } from '@nestjs/common';
import { LIVE_SOURCE_GATEWAY } from '@common/gateway/live-source.gateway';
import { ProductModule } from '@modules/product/product.module';
import { ShopModule } from '@modules/shop/shop.module';
import { LiveRepository } from './live.repository';
import { LiveService } from './live.service';
import { LiveKitProvider } from './media/livekit.provider';
import { LiveMediaService } from './media/live-media.service';
import { LiveRealtime } from './live.realtime';
import { AdminLiveController, LiveController, ShopLiveController } from './live.controllers';

/* Gateway global cung cấp nguồn hàng cho commerce, không bắt cart/order import ngược LivestreamModule. */
@Global()
@Module({
  imports: [ProductModule, ShopModule],
  controllers: [LiveController, ShopLiveController, AdminLiveController],
  providers: [
    LiveRepository,
    LiveKitProvider,
    LiveService,
    LiveMediaService,
    LiveRealtime,
    { provide: LIVE_SOURCE_GATEWAY, useExisting: LiveService },
  ],
  exports: [LiveService, LiveMediaService, LiveRepository, LIVE_SOURCE_GATEWAY],
})
export class LivestreamModule {}
