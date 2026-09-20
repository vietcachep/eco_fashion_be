import 'reflect-metadata';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { ENV } from './config/config.module';
import { corsOrigins, type Env } from './config/env';

/*
 * Bootstrap API: helmet, CORS theo EF_CORS_ORIGINS, ValidationPipe (whitelist lọc key lạ + transform),
 * tiền tố /api/v1, Swagger ở /docs khi bật. Body JSON tối đa 2MB (ảnh đi đường multipart riêng).
 * Tắt server graceful: đóng kết nối DB/Redis qua hook của Nest (enableShutdownHooks).
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  const logger = app.get(Logger);
  app.useLogger(logger);
  const env = app.get<Env>(ENV);

  app.set('trust proxy', env.EF_TRUSTED_PROXY_COUNT);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cookieParser());
  app.enableCors({
    origin: corsOrigins(env),
    credentials: true,
    exposedHeaders: ['X-Request-Id'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  // Ảnh seed dùng khi CHƯA cấu hình Cloudinary (scripts/seed/assets) — cache 1 ngày, không nằm sau prefix API.
  app.useStaticAssets(join(process.cwd(), 'scripts', 'seed', 'assets'), { prefix: '/static/seed/', maxAge: 86_400_000 });
  const uploadsDir = join(process.cwd(), 'uploads');
  if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });
  app.useStaticAssets(uploadsDir, { prefix: '/static/uploads/', maxAge: 86_400_000 });
  app.setGlobalPrefix(env.EF_API_PREFIX);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: undefined });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false, // FE gửi kèm cả snake_case (full_name…) — key lạ bị bỏ, không 400 (docs/06_FE_CONTRACT.md)
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      stopAtFirstError: false,
    }),
  );
  app.enableShutdownHooks();

  if (env.EF_SWAGGER_ENABLED) {
    const doc = new DocumentBuilder()
      .setTitle('EcoFashion API')
      .setDescription(
        'Backend cửa hàng thời trang — web bán hàng + web quản trị. Mọi response theo envelope ApiResponse.',
      )
      .setVersion(process.env.npm_package_version ?? '0.1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
      .build();
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, doc), {
      jsonDocumentUrl: 'docs/openapi.json',
      swaggerOptions: { persistAuthorization: true },
    });
  }

  await app.listen(env.EF_PORT, '0.0.0.0');
  logger.log(
    `EcoFashion API khởi động — http://localhost:${env.EF_PORT}/${env.EF_API_PREFIX} (env=${env.NODE_ENV})`,
  );
}

void bootstrap();
