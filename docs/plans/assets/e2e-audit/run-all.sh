#!/bin/bash
# Chạy TOÀN BỘ bộ audit đúng thứ tự, MỘT driver duy nhất (đã dùng thật 2026-10-27).
# Bắt buộc export trước: E2E_PW_ADMIN, E2E_PW_NHANVIEN, E2E_PW_KHACH, E2E_PW_VENDOR (mật khẩu tài khoản mẫu — lấy từ file seed, KHÔNG ghi vào repo).
# Dùng:  REG_DIR=/tmp/reg BE_DIR=D:/fitly-snap/be ./run-all.sh      (chạy nền: nohup ./run-all.sh > /dev/null 2>&1 &)
# Tiến độ ở $REG_DIR/progress.log, kết quả từng bài ở $REG_DIR/out-<bài>.json (OUT do MSYS đổi sang đường dẫn Windows).
set -u
A="$(cd "$(dirname "$0")" && pwd)"
REG="${REG_DIR:-/tmp/reg}"
for v in E2E_PW_ADMIN E2E_PW_NHANVIEN E2E_PW_KHACH E2E_PW_VENDOR; do
  [ -z "${!v:-}" ] && { echo "thiếu biến $v"; exit 1; }
done
mkdir -p "$REG"
# Khoá: chỉ MỘT driver. (Bài học: hai driver chạy chồng — một cái quên nạp auditenv — làm hỏng toàn bộ kết quả.)
LOCK="$REG/.run.lock"
if ! mkdir "$LOCK" 2>/dev/null; then echo "đã có driver đang chạy ($LOCK). Chắc chắn không còn thì xoá thư mục khoá rồi chạy lại."; exit 1; fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT
: > "$REG/progress.log"

cd "$A"
source ./auditenv.sh                      # BẮT BUỘC — nếu không jobs.cjs/lib dùng cấu hình sai (jobs.cjs đã có hàng rào từ chối)
export SCR="$(pwd -W)" BE_DIR="${BE_DIR:-D:/fitly-snap/be}"

node prep-accounts.mjs >> "$REG/progress.log" 2>&1
# t06 bỏ qua: phần thông báo của nó hỏng sẵn từ lần audit đầu — t06b chứa phần còn dùng được (rate-limit, thông báo, đồng thời).
for t in t01-setup-happy t02-checkout-pay t02b-recheck t03-lifecycle t04-returns-refunds t04b t04c t04d t05-payouts t05b t06b t07-misc-resilience t07b t08-p0-verify t09-explore-money t10-lifecycle-extras t11-wallet-topup-payos; do
  echo "=== $t $(date +%H:%M:%S)" >> "$REG/progress.log"
  OUT="$REG/out-$t.json" timeout 900 node "$t.mjs" > "$REG/$t.log" 2>&1
  echo "exit $? — $(grep -aE 'TỔNG' "$REG/$t.log" | tail -1)" >> "$REG/progress.log"
done
echo "DONE $(date +%H:%M:%S)" >> "$REG/progress.log"
