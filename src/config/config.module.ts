import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { Env, loadEnv } from './env';

export const ENV = Symbol('ENV');

/*
 * Cung cấp `Env` đã validate cho toàn app qua token ENV (inject bằng @Inject(ENV)).
 * Không dùng ConfigService.get('X') rải rác: một chỗ validate, một kiểu dữ liệu, thiếu biến là chết lúc boot.
 */
@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env'],
      validate: (cfg) => loadEnv(cfg as NodeJS.ProcessEnv),
    }),
  ],
  providers: [{ provide: ENV, useFactory: (): Env => loadEnv() }],
  exports: [ENV],
})
export class ConfigModule {}
