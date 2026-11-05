#!/bin/bash
# Reset DB audit về dữ liệu mẫu SẠCH rồi khởi động lại API + worker (đã dùng thật 2026-10-27; chạy trong Git Bash trên Windows).
# Điều kiện: đã dựng bản sao backend (README §"Dựng môi trường"), container fitly-audit-db / fitly-audit-redis đang chạy, bản sao đã `nest build`,
# và có thư mục `mig-old/` trong bản sao (migration ở mức dump — xem README). KHÔNG chạy với DB khác ngoài cổng 55442.
# Dùng:  BE_POSIX=/d/fitly-snap/be ./reset-env.sh
set -u
A="$(cd "$(dirname "$0")" && pwd)"
BE="${BE_POSIX:-/d/fitly-snap/be}"
cd "$BE" || { echo "không thấy bản sao backend: $BE"; exit 1; }

# 1) dừng API (cổng 4030) + worker
PID=$(powershell.exe -NoProfile -Command "(Get-NetTCPConnection -LocalPort 4030 -State Listen -ErrorAction SilentlyContinue | Select -First 1).OwningProcess" | tr -d '\r')
[ -n "$PID" ] && taskkill //PID "$PID" //F >/dev/null 2>&1
powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -match 'dist[\\\\/]src[\\\\/]worker\.js' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }" >/dev/null 2>&1
sleep 2

# 2) tạo lại DB rồi nạp: migration cấp dump → dữ liệu mẫu → migration đầy đủ → quyền
docker exec fitly-audit-db sh -c "psql -U ecofashion -d postgres -c 'DROP DATABASE IF EXISTS ecofashion WITH (FORCE)' -c 'CREATE DATABASE ecofashion'" >/dev/null
export EF_DATABASE_URL="postgresql://ecofashion:ecofashion@localhost:55442/ecofashion" EF_REDIS_URL="redis://localhost:56389" EF_DB_CONTAINER=fitly-audit-db EF_REDIS_CONTAINER=fitly-audit-redis
npx prisma migrate deploy --config mig-old/prisma.old.config.mjs 2>&1 | tail -1
npx ts-node -T -r tsconfig-paths/register scripts/db/restore.ts --yes 2>&1 | grep -E "Xong|lỗi|Error"
npx prisma migrate deploy 2>&1 | tail -1
npm run perms:sync 2>&1 | tail -1
docker exec fitly-audit-redis redis-cli FLUSHALL >/dev/null

# 3) khởi động lại API + worker bằng cấu hình CÔ LẬP (auditenv.sh — không bao giờ dùng .env của bản sao cho DB/Redis/PayOS/mail)
(source "$A/auditenv.sh" && nohup node dist/src/main.js > /tmp/api.log 2>&1 &)
(source "$A/auditenv.sh" && nohup node dist/src/worker.js > /tmp/worker.log 2>&1 &)
for i in $(seq 1 30); do sleep 2; curl -s -o /dev/null http://localhost:4030/api/v1/health && break; done
curl -s -o /dev/null -w "api %{http_code}\n" http://localhost:4030/api/v1/health
curl -s -X POST http://localhost:4020/_reset -H 'content-type: application/json' -d '{}' >/dev/null   # PayOS giả (mock-payos.mjs) phải đang chạy ở :4020
