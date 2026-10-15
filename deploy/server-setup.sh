#!/usr/bin/env bash
# Chuẩn bị MÁY CHỦ Ubuntu/Debian MỚI cho FITLY (chạy MỘT lần, bằng root): cài Docker + git, mở cổng 22/80/443.
# Đọc kỹ trước khi chạy — script chỉ làm đúng những việc ghi trong file này.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Chạy bằng root (hoặc sudo)."; exit 1; }

apt-get update -y
apt-get install -y ca-certificates curl git ufw

if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh      # cài Docker Engine + plugin compose (script chính thức của Docker)
fi
systemctl enable --now docker

# Tường lửa: chỉ SSH + web. (Postgres/Redis không mở cổng ra ngoài.)
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

docker --version
docker compose version
echo "Xong. Tiếp theo: git clone repo backend, cd deploy, copy .env.production.example → .env.production, điền, rồi ./deploy.sh"
