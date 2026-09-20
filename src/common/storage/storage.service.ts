import { Inject, Injectable, Logger } from '@nestjs/common';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ENV } from '@config/config.module';
import type { Env } from '@config/env';
import { BusinessException } from '../exception/business.exception';

export interface UploadedImage {
  url: string;
  publicId: string;
  width: number;
  height: number;
  bytes: number;
}

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_BYTES = 5 * 1024 * 1024;

/*
 * Kho ảnh Cloudinary — CHỖ DUY NHẤT upload/xoá ảnh (sản phẩm, banner, avatar, ảnh đánh giá).
 * Kiểm MIME + kích thước trước khi gửi; thư mục `ecofashion/<folder>`; trả URL https + publicId để xoá sau.
 * Nếu Cloudinary chưa cấu hình hoặc upload lỗi (mất mạng/secret sai), fallback lưu trữ cục bộ vào /static/uploads/.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private configured = false;

  constructor(@Inject(ENV) private readonly env: Env) {
    if (env.EF_CLOUDINARY_CLOUD_NAME && env.EF_CLOUDINARY_API_KEY && env.EF_CLOUDINARY_API_SECRET) {
      cloudinary.config({
        cloud_name: env.EF_CLOUDINARY_CLOUD_NAME,
        api_key: env.EF_CLOUDINARY_API_KEY,
        api_secret: env.EF_CLOUDINARY_API_SECRET,
        secure: true,
      });
      this.configured = true;
    }
  }

  get isConfigured(): boolean {
    return this.configured;
  }

  async uploadImage(
    file: { buffer: Buffer; mimetype: string; size: number },
    folder: string,
  ): Promise<UploadedImage> {
    if (!ALLOWED_MIME.has(file.mimetype))
      throw new BusinessException('STORAGE_INVALID_TYPE', 'Chỉ nhận ảnh JPG/PNG/WEBP/GIF');
    if (file.size > MAX_BYTES) throw new BusinessException('STORAGE_TOO_LARGE', 'Ảnh tối đa 5MB');

    if (this.configured) {
      try {
        const result = await new Promise<UploadApiResponse>((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            { folder: `ecofashion/${folder}`, resource_type: 'image', overwrite: false },
            (err, res) =>
              err || !res
                ? reject(err instanceof Error ? err : new Error(err?.message ?? 'Upload thất bại'))
                : resolve(res),
          );
          stream.end(file.buffer);
        });
        return {
          url: result.secure_url,
          publicId: result.public_id,
          width: result.width,
          height: result.height,
          bytes: result.bytes,
        };
      } catch (err) {
        this.logger.warn({ err: (err as Error).message, folder }, 'Upload Cloudinary lỗi — chuyển sang lưu trữ cục bộ');
      }
    }

    // Fallback: Lưu vào uploads/<folder> và phục vụ tĩnh qua /static/uploads/
    const ext = file.mimetype.split('/')[1] === 'jpeg' ? 'jpg' : (file.mimetype.split('/')[1] || 'png');
    const filename = `${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;
    const targetDir = join(process.cwd(), 'uploads', folder);
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
    const targetFile = join(targetDir, filename);
    writeFileSync(targetFile, file.buffer);

    return {
      url: `/static/uploads/${folder}/${filename}`,
      publicId: `local:${folder}/${filename}`,
      width: 256,
      height: 256,
      bytes: file.size,
    };
  }

  async deleteImage(publicId: string): Promise<void> {
    if (!publicId) return;

    if (publicId.startsWith('local:')) {
      const rel = publicId.slice(6);
      const filePath = join(process.cwd(), 'uploads', rel);
      try {
        if (existsSync(filePath)) unlinkSync(filePath);
      } catch (err) {
        this.logger.warn({ err, filePath }, 'Xoá ảnh cục bộ lỗi — bỏ qua');
      }
      return;
    }

    if (!this.configured) return;
    try {
      await cloudinary.uploader.destroy(publicId);
    } catch (err) {
      this.logger.warn({ err, publicId }, 'Xoá ảnh Cloudinary lỗi — bỏ qua');
    }
  }
}
