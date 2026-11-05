export EF_DATABASE_URL="postgresql://ecofashion:ecofashion@localhost:55442/ecofashion" EF_REDIS_URL="redis://localhost:56389"
export EF_PORT=4030 EF_API_PUBLIC_URL="http://localhost:4030" EF_PUBLIC_URL="http://localhost:4030" EF_SWAGGER_ENABLED=true
export EF_CORS_ORIGINS="http://localhost:3401,http://localhost:3402"
export EF_ADMIN_URL="http://localhost:3401" # PLAN-0041: PayOS trả chủ shop về trang quay lại của cổng quản trị (bản sao FE cổng 3401)
# PayOS giả: khoá giả + API trỏ về server giả cục bộ (không gọi PayOS thật)
export EF_PAYOS_CLIENT_ID=audit-client EF_PAYOS_API_KEY=audit-key EF_PAYOS_CHECKSUM_KEY=audit-checksum-key-collect
export EF_PAYOS_PAYOUT_CLIENT_ID=audit-pclient EF_PAYOS_PAYOUT_API_KEY=audit-pkey EF_PAYOS_PAYOUT_CHECKSUM_KEY=audit-checksum-key-payout
export EF_PAYOS_API_URL="http://127.0.0.1:4020"
export EF_MAIL_HOST=127.0.0.1 EF_MAIL_PORT=2525 EF_MAIL_USER= EF_MAIL_PASSWORD= EF_MAIL_SECURE=false
export EF_OPENAI_API_KEY= EF_REPLICATE_API_TOKEN= EF_CLOUDINARY_CLOUD_NAME= EF_CLOUDINARY_API_KEY= EF_CLOUDINARY_API_SECRET= EF_GOOGLE_CLIENT_ID= EF_PEXELS_API_KEY=
export EF_DB_CONTAINER=fitly-audit-db EF_REDIS_CONTAINER=fitly-audit-redis
export NODE_ENV=development
