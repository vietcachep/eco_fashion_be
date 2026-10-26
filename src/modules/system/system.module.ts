import { Module } from '@nestjs/common';
import { NOTIFICATION_GATEWAY } from '@common/gateway/notification.gateway';
import { SystemAuditLogService } from './audit/system-audit-log.service';
import { BannerService } from './banner/service/banner.service';
import { ContentService } from './content/service/content.service';
import { HealthController } from './health/controller/health.controller';
import { HealthService } from './health/service/health.service';
import { NotificationService } from './notification/service/notification.service';
import { ProvinceService } from './province/service/province.service';
import { SystemQueryApi } from './queryapi/system.queryapi';
import { SettingService } from './setting/service/setting.service';
import { AdminSystemController, NotificationController, SystemPublicController } from './system.controllers';
import { UploadController } from './upload/upload.controller';
import { ShopModule } from '../shop/shop.module';
import { ShopContactsController } from './content/controller/shop-contacts.controller';

/*
 * Module system (PLAN-0010): health, tham số vận hành, tỉnh/thành + phí ship, banner, thông báo trong-app (cài
 * NotificationGateway), liên hệ, FAQ, trang chính sách, upload ảnh dùng chung (/uploads/media). Export: SystemQueryApi + NOTIFICATION_GATEWAY.
 */
@Module({
  imports: [ShopModule],
  controllers: [HealthController, SystemPublicController, NotificationController, AdminSystemController, UploadController, ShopContactsController],
  providers: [
    HealthService,
    SystemAuditLogService,
    SettingService,
    ProvinceService,
    BannerService,
    NotificationService,
    ContentService,
    SystemQueryApi,
    { provide: NOTIFICATION_GATEWAY, useExisting: NotificationService },
  ],
  exports: [SystemQueryApi, NOTIFICATION_GATEWAY, NotificationService],
})
export class SystemModule {}
