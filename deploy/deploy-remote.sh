#!/usr/bin/env bash
# CD — chạy TRÊN máy chủ (do GitHub Actions gọi qua SSH, hoặc chạy tay): đưa image đã build sẵn lên chạy.
#   IMAGE=ghcr.io/<owner>/<repo>:sha-xxxxxxxxxxxx ./deploy-remote.sh
# Các bước: sao lưu DB → ghi image mới vào .env.production → kéo image → migrate + chạy lại → chờ API khoẻ → dọn.
# Lỗi sau khi đổi image ⇒ tự quay về image cũ (CHỈ code; migration đã áp dụng KHÔNG tự lùi — muốn lùi cả DB thì khôi phục bản sao lưu
# /root/backups/fitly-pre-*.dump, xem docs/09_CD.md).
# Biến tuỳ chọn: SKIP_PULL=1 (dùng image đã có trong máy, vd thử script), HEALTH_TIMEOUT=180 (giây), KEEP_BACKUPS=10.
set -euo pipefail
cd "$(dirname "$0")"

: "${IMAGE:?thiếu biến IMAGE (vd ghcr.io/vietcachep/eco_fashion_be:sha-abcdef123456)}"
[ -f .env.production ] || { echo "Thiếu deploy/.env.production"; exit 1; }
command -v docker >/dev/null || { echo "Chưa cài Docker"; exit 1; }

COMPOSE=(docker compose --env-file .env.production -f docker-compose.prod.yml)
BACKUP_DIR=${BACKUP_DIR:-/root/backups}
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-180}
KEEP_BACKUPS=${KEEP_BACKUPS:-10}
TS=$(date +%Y%m%d-%H%M%S)

# Ghi/ cập nhật dòng FITLY_IMAGE trong .env.production (compose đọc biến này để chọn image; file giữ quyền 600).
set_image() {
  if grep -q '^FITLY_IMAGE=' .env.production; then
    sed -i "s|^FITLY_IMAGE=.*|FITLY_IMAGE=$1|" .env.production
  else
    [ -n "$(tail -c1 .env.production)" ] && echo >> .env.production
    printf 'FITLY_IMAGE=%s\n' "$1" >> .env.production
  fi
  chmod 600 .env.production
}

PREV=$(grep -E '^FITLY_IMAGE=' .env.production | tail -1 | cut -d= -f2- || true)
[ -n "$PREV" ] || PREV="fitly-backend:prod"   # lần đầu chuyển sang CD: image cũ là bản tự build tại máy chủ
echo "== image hiện tại: $PREV"
echo "== image mới:      $IMAGE"

echo "== 1. sao lưu DB"
mkdir -p "$BACKUP_DIR"
"${COMPOSE[@]}" exec -T db pg_dump -U ecofashion -Fc ecofashion > "$BACKUP_DIR/fitly-pre-$TS.dump"
test -s "$BACKUP_DIR/fitly-pre-$TS.dump" || { echo "Sao lưu rỗng — dừng, chưa đổi gì."; exit 1; }
chmod 600 "$BACKUP_DIR/fitly-pre-$TS.dump"
ls -la "$BACKUP_DIR/fitly-pre-$TS.dump"
# giữ KEEP_BACKUPS bản mới nhất (tên file do script tự đặt theo giờ nên an toàn với ls)
# shellcheck disable=SC2012
ls -1t "$BACKUP_DIR"/fitly-pre-*.dump 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -f --

echo "== 2. kéo image mới"
set_image "$IMAGE"
if [ "${SKIP_PULL:-0}" != "1" ]; then
  "${COMPOSE[@]}" pull migrate api worker
fi

echo "== 3. migrate + chạy lại"
"${COMPOSE[@]}" up -d --remove-orphans

echo "== 4. chờ API khoẻ (tối đa ${HEALTH_TIMEOUT}s)"
ok=0
for _ in $(seq 1 $((HEALTH_TIMEOUT / 5))); do
  cid=$("${COMPOSE[@]}" ps -q api || true)
  if [ -n "$cid" ] && [ "$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || true)" = "healthy" ]; then ok=1; break; fi
  # migrate lỗi thì không cần chờ thêm
  mid=$("${COMPOSE[@]}" ps -a -q migrate || true)
  if [ -n "$mid" ] && [ "$(docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' "$mid" 2>/dev/null || true)" = "exited 1" ]; then break; fi
  sleep 5
done

if [ "$ok" != "1" ]; then
  echo "!! API không khoẻ sau khi đổi image — log migrate/api:" >&2
  "${COMPOSE[@]}" logs --tail 40 migrate api >&2 || true
  echo "!! Quay về image cũ: $PREV" >&2
  set_image "$PREV"
  "${COMPOSE[@]}" up -d --remove-orphans >&2 || true
  echo "!! Nếu migration mới đã áp dụng, schema đã đổi: bản sao lưu ở $BACKUP_DIR/fitly-pre-$TS.dump" >&2
  exit 1
fi

echo "== 5. dọn image cũ (không dùng, > 7 ngày)"
docker image prune -af --filter "until=168h" >/dev/null 2>&1 || true

"${COMPOSE[@]}" ps
echo "OK — đang chạy $IMAGE"
