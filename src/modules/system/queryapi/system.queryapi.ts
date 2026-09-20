import { Injectable } from '@nestjs/common';
import { ProvinceService } from '../province/service/province.service';
import { SettingService } from '../setting/service/setting.service';
import { SETTING_KEY } from '../foundation/system.constants';

/*
 * QueryAPI của system — cổng ĐỌC cho cart/order/payment/ai: tham số vận hành + phí ship theo tỉnh.
 * Thứ DUY NHẤT module khác được import từ system (ngoài NotificationGateway ở common).
 */
@Injectable()
export class SystemQueryApi {
  constructor(
    private readonly settings: SettingService,
    private readonly provinces: ProvinceService,
  ) {}

  setting<T = unknown>(key: string): Promise<T> {
    return this.settings.get<T>(key);
  }

  settingNumber(key: string): Promise<number> {
    return this.settings.getNumber(key);
  }

  shippingFeeFor(subtotal: bigint, provinceCodeOrName: string | null | undefined) {
    return this.provinces.shippingFeeFor(subtotal, provinceCodeOrName);
  }

  resolveProvince(codeOrName: string | null | undefined) {
    return this.provinces.resolve(codeOrName);
  }

  async shopName(): Promise<string> {
    return this.settings.get<string>(SETTING_KEY.SHOP_NAME);
  }
}
