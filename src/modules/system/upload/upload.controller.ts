import { Controller, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BusinessException } from '@common/exception/business.exception';
import { ApiResponse } from '@common/response/api-response';
import type { AuthenticatedActor } from '@common/security/authenticated-actor';
import { CurrentActor } from '@common/security/decorators';
import { RateLimit } from '@common/security/rate-limit.guard';
import { StorageService } from '@common/storage/storage.service';

export interface UploadedMediaResponse {
  type: 'image';
  url: string;
  name: string;
  width: number;
  height: number;
}

/*
 * Upload ảnh dùng chung cho khách đã đăng nhập (ảnh đánh giá, minh chứng đổi trả, ảnh liên hệ) — Cloudinary thư mục
 * `ecofashion/user-media`. Trả về MediaItem để FE gắn vào body review/return. Video chưa hỗ trợ (chỉ ảnh ≤ 5MB).
 */
@ApiTags('uploads')
@ApiBearerAuth()
@Controller('uploads')
export class UploadController {
  constructor(private readonly storage: StorageService) {}

  @Post('media')
  @RateLimit({ name: 'upload-media', limit: 30, windowSeconds: 600, by: 'user' })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
  @ApiOperation({ summary: 'Upload ảnh (JPG/PNG/WEBP ≤ 5MB) → MediaItem {type,url,name} cho đánh giá / đổi trả' })
  async media(@CurrentActor() actor: AuthenticatedActor, @UploadedFile() file?: Express.Multer.File): Promise<ApiResponse<UploadedMediaResponse>> {
    if (!file) throw new BusinessException('COMMON_VALIDATION_ERROR', 'Thiếu file ảnh (field `file`)');
    const r = await this.storage.uploadImage({ buffer: file.buffer, mimetype: file.mimetype, size: file.size }, `user-media/${actor.userId.slice(0, 8)}`);
    return ApiResponse.ok({ type: 'image', url: r.url, name: file.originalname || 'anh.jpg', width: r.width, height: r.height }, 'Đã tải ảnh lên');
  }
}
