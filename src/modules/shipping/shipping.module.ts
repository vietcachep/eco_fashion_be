import { Module } from '@nestjs/common';
import { ShopModule } from '@modules/shop/shop.module';
import { ShippingApplicationApi } from './applicationapi/shipping.applicationapi';
import { ShippingQueryApi } from './queryapi/shipping.queryapi';
import { FakeCarrierGateway } from './carrier/fake-carrier.gateway';
import { GhnGateway } from './carrier/ghn.gateway';
import { ShippingRepository } from './repository/shipping.repository';
import { ShippingService } from './shipment/shipping.service';
import { ShippingController } from './shipment/shipping.controller';

/* Không import OrderModule: gateway ngược được tìm lười, tránh vòng order→shipping→order. */
@Module({ imports: [ShopModule], controllers: [ShippingController], providers: [ShippingRepository, FakeCarrierGateway, GhnGateway, ShippingService, ShippingApplicationApi, ShippingQueryApi], exports: [ShippingApplicationApi, ShippingQueryApi, ShippingService] })
export class ShippingModule {}
