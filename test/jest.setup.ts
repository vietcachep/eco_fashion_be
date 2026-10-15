/*
 * Biến môi trường mặc định cho test: DB/Redis test riêng (không đụng DB dev), secret cố định,
 * tắt gọi dịch vụ ngoài. CI ghi đè bằng env của workflow.
 */
process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
process.env.EF_DATABASE_URL =
  process.env.EF_DATABASE_URL ?? 'postgresql://ecofashion:ecofashion@localhost:5434/ecofashion_test';
process.env.EF_REDIS_URL = process.env.EF_REDIS_URL ?? 'redis://localhost:6381/9';
process.env.EF_JWT_SECRET = process.env.EF_JWT_SECRET ?? 'test-secret-khong-dung-that-0123456789abcdef';
process.env.EF_OPENAI_API_KEY = '';
process.env.EF_LOG_LEVEL = 'silent';
