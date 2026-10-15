#!/usr/bin/env bash
# Triển khai / cập nhật backend FITLY trên máy chủ (chạy TRÊN máy chủ, trong thư mục deploy/ của repo).
#   ./deploy.sh                       build + chạy (migration tự chạy mỗi lần)
#   ./deploy.sh --pull                git pull trước khi build (cập nhật lên commit mới nhất)
#   ./deploy.sh --with-demo-data      thêm: nạp dữ liệu mẫu trong repo (XOÁ dữ liệu ứng dụng hiện có!) rồi đổi mật khẩu admin/khoá nhân viên mẫu
#   ./deploy.sh --yes                 bỏ hỏi xác nhận (dùng với --with-demo-data trong script)
set -euo pipefail
cd "$(dirname "$0")"

PULL=false; DEMO=false; YES=false
for a in "$@"; do
  case "$a" in
    --pull) PULL=true ;;
    --with-demo-data) DEMO=true ;;
    --yes) YES=true ;;
    *) echo "Tham số lạ: $a"; exit 1 ;;
  esac
done

[ -f .env.production ] || { echo "Thiếu deploy/.env.production — copy từ .env.production.example rồi điền."; exit 1; }
command -v docker >/dev/null || { echo "Chưa cài Docker — chạy ./server-setup.sh trước."; exit 1; }
COMPOSE=(docker compose --env-file .env.production -f docker-compose.prod.yml)

if $PULL; then git -C .. pull --ff-only; fi

"${COMPOSE[@]}" config -q   # kiểm cú pháp + biến bắt buộc trước khi dựng

if $DEMO && ! $YES; then
  echo "CẢNH BÁO: --with-demo-data XOÁ toàn bộ dữ liệu ứng dụng đang có trong DB rồi nạp dữ liệu mẫu."
  read -r -p "Gõ 'nap' để tiếp tục: " ans
  [ "$ans" = "nap" ] || { echo "Đã huỷ."; exit 1; }
fi

"${COMPOSE[@]}" up -d --build --remove-orphans

if $DEMO; then
  "${COMPOSE[@]}" --profile demo-data run --rm demo-data
  "${COMPOSE[@]}" restart api worker
fi

"${COMPOSE[@]}" ps
echo
SITE=$(grep -E '^SITE_ADDRESS=' .env.production | cut -d= -f2-)
echo "Kiểm tra: curl -s https://${SITE}/api/v1/health"
