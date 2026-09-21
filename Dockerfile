# =====================================================================
# EcoFashion Backend — image đa tầng. Cùng MỘT image chạy API (mặc định), worker, migrate, seed
# (compose đổi `command`). Prisma client sinh lúc `npm ci` (postinstall) nên prisma/ phải có trước.
# =====================================================================
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache tini curl
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json prisma.config.ts tsconfig.json ./
COPY prisma ./prisma
COPY --from=build /app/src ./src
COPY scripts ./scripts
# `prisma migrate deploy` cần prisma/ + prisma.config.ts; seed/perms chạy bằng ts-node -T (mã nguồn TS có sẵn).
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD curl -fsS http://localhost:4000/api/v1/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/src/main.js"]
