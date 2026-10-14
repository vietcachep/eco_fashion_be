import 'dotenv/config'; // nạp .env cho cả app lẫn script CLI (compose truyền env thẳng, .env không có cũng không sao)
import { z } from 'zod';

/*
 * Lược đồ biến môi trường EF_* — validate MỘT lần lúc khởi động (API, worker, script CLI đều đi qua đây).
 * Thiếu/sai biến bắt buộc là dừng ngay với thông báo rõ, không âm thầm chạy với giá trị mặc định nguy hiểm.
 * `assertSecretsSafe`: production mà còn secret mẫu là chết lúc khởi động (không có "quên đổi secret").
 */
const boolean = z
  .string()
  .optional()
  .transform((v) => (v ?? 'false').toLowerCase() === 'true');

const intFrom = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number.parseInt(v, 10)))
    .pipe(z.number().int().nonnegative());

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  EF_APP_NAME: z.string().default('EcoFashion'),
  EF_PORT: intFrom(4000),
  /* URL công khai của API (FE/ảnh tĩnh seed trỏ về) — dev: http://localhost:4000 */
  EF_API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
  /* URL web bán hàng — VNPay redirect về, link trong email */
  EF_WEB_URL: z.string().url().default('http://localhost:3000'),
  EF_API_PREFIX: z.string().default('api/v1'),
  EF_SWAGGER_ENABLED: boolean,
  EF_CORS_ORIGINS: z.string().default('http://localhost:3000,http://localhost:3001,http://localhost:3100'),
  EF_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
  EF_STOREFRONT_URL: z.string().url().default('http://localhost:3000'),
  EF_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  EF_TRUSTED_PROXY_COUNT: intFrom(0),

  EF_DATABASE_URL: z.string().min(1, 'EF_DATABASE_URL bắt buộc'),
  EF_REDIS_URL: z.string().min(1, 'EF_REDIS_URL bắt buộc'),

  EF_JWT_SECRET: z.string().min(32, 'EF_JWT_SECRET phải >= 32 ký tự'),
  EF_ACCESS_TOKEN_TTL_SECONDS: intFrom(900),
  EF_REFRESH_TOKEN_TTL_DAYS: intFrom(14),

  EF_ADMIN_EMAIL: z.string().email().default('admin@ecofashion.vn'),
  EF_ADMIN_PASSWORD: z.string().default('Admin123456!'),

  EF_CLOUDINARY_CLOUD_NAME: z.string().default(''),
  EF_CLOUDINARY_API_KEY: z.string().default(''),
  EF_CLOUDINARY_API_SECRET: z.string().default(''),

  EF_MAIL_HOST: z.string().default('localhost'),
  EF_MAIL_PORT: intFrom(1025),
  EF_MAIL_SECURE: boolean,
  EF_MAIL_USER: z.string().default(''),
  EF_MAIL_PASSWORD: z.string().default(''),
  EF_MAIL_FROM: z.string().default('EcoFashion <no-reply@ecofashion.vn>'),

  EF_VNPAY_TMN_CODE: z.string().default(''),
  EF_VNPAY_HASH_SECRET: z.string().default(''),
  EF_VNPAY_PAY_URL: z.string().url().default('https://sandbox.vnpayment.vn/paymentv2/vpcpay.html'),
  EF_VNPAY_API_URL: z.string().url().default('https://sandbox.vnpayment.vn/merchant_webapi/api/transaction'),
  EF_BANK_TRANSFER_BANK_CODE: z.string().default(''),
  EF_BANK_TRANSFER_ACCOUNT_NO: z.string().default(''),
  EF_BANK_TRANSFER_ACCOUNT_NAME: z.string().default(''),

  /* PayOS (PLAN-0015/0017). Trống = phương thức `payos` tự tắt, đối soát chi trả lùi về "đánh dấu đã trả tay".
     Thu tiền (payment link) và chi tiền (payout) là HAI cặp khoá khác nhau trong dashboard PayOS. */
  EF_PAYOS_CLIENT_ID: z.string().default(''),
  EF_PAYOS_API_KEY: z.string().default(''),
  EF_PAYOS_CHECKSUM_KEY: z.string().default(''),
  EF_PAYOS_API_URL: z.string().url().default('https://api-merchant.payos.vn'),
  EF_PAYOS_PAYOUT_CLIENT_ID: z.string().default(''),
  EF_PAYOS_PAYOUT_API_KEY: z.string().default(''),
  EF_PAYOS_PAYOUT_CHECKSUM_KEY: z.string().default(''),

  /* Ảnh thật cho dữ liệu mẫu (scripts/seed/tools) — trống thì dùng ảnh minh hoạ tự sinh. Chỉ dùng lúc seed. */
  EF_PEXELS_API_KEY: z.string().default(''),

  EF_OPENAI_API_KEY: z.string().default(''),
  EF_OPENAI_CHAT_MODEL: z.string().default('gpt-5.4-mini'),
  EF_OPENAI_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  EF_AI_DAILY_TOKEN_BUDGET: intFrom(0),
  EF_OPENAI_VISION_MODEL: z.string().default('gpt-5.4-mini'),
  EF_REPLICATE_API_TOKEN: z.string().default(''),
  EF_REPLICATE_TRYON_MODEL: z.string().default('cuuupid/idm-vton:c871bb9b046607b680449ecbae55fd8c6d945e0a1948644bf2361b3d021d3ff4'),
  EF_GOOGLE_CLIENT_ID: z.string().default(''),

  EF_LOGIN_HISTORY_RETENTION_DAYS: intFrom(180),
  EF_NOTIFICATION_PURGE_RETENTION_DAYS: intFrom(90),
  EF_VIEW_EVENT_RETENTION_DAYS: intFrom(90),
  EF_CHAT_SESSION_RETENTION_DAYS: intFrom(90),
});

export type Env = z.infer<typeof envSchema>;

const SECRET_MAU = [
  'doi-secret-nay-truoc-khi-chay-that-0123456789',
  'test-secret-khong-dung-that-0123456789abcdef',
];

export function assertSecretsSafe(env: Env): void {
  if (env.NODE_ENV !== 'production') return;
  if (SECRET_MAU.includes(env.EF_JWT_SECRET)) {
    throw new Error('EF_JWT_SECRET đang là giá trị mẫu — production bắt buộc đổi secret trước khi chạy.');
  }
  if (env.EF_ADMIN_PASSWORD === 'Admin123456!') {
    throw new Error('EF_ADMIN_PASSWORD đang là mật khẩu mẫu — production bắt buộc đổi.');
  }
  if (!env.EF_PUBLIC_URL.startsWith('https://')) {
    throw new Error('EF_PUBLIC_URL production phải là https (VNPay gọi IPN về đây).');
  }
}

let cached: Env | null = null;

/*
 * Đọc + validate process.env. Dùng ở ConfigModule (validate) lẫn script CLI (migrate/seed) để cùng một luật.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached && source === process.env) return cached;
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const loi = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Biến môi trường không hợp lệ:\n${loi}`);
  }
  assertSecretsSafe(parsed.data);
  if (source === process.env) cached = parsed.data;
  return parsed.data;
}

export function corsOrigins(env: Env): string[] {
  return env.EF_CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
