"""
Sinh ảnh minh hoạ cho dữ liệu mẫu (PLAN-0017 Track D): nền gradient theo bảng màu + biểu tượng emoji ĐÚNG LOẠI HÀNG.
Không tải gì từ bên ngoài. Đọc `.image-manifest.json` (do export-image-manifest.ts xuất), ghi vào `scripts/seed/assets/<out>`.
Các loại ảnh (`kind`): product · product-hover · category · collection · shop-logo · shop-banner · banner (1600×520, banner trang chủ).
Chạy: `npm run seed:gen-images` (thêm --force để vẽ lại ảnh đã có). Cần Pillow; emoji màu dùng font hệ thống
(Windows: Segoe UI Emoji · Linux: Noto Color Emoji · macOS: Apple Color Emoji) — không có font thì vẽ chữ cái đầu thay thế.
"""
import hashlib
import json
import math
import os
import random
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.normpath(os.path.join(HERE, "..", "assets"))
MANIFEST = os.path.join(HERE, ".image-manifest.json")

EMOJI_FONTS = [
    "C:/Windows/Fonts/seguiemj.ttf",
    "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf",
    "/usr/share/fonts/noto/NotoColorEmoji.ttf",
    "/System/Library/Fonts/Apple Color Emoji.ttc",
]
TEXT_FONTS = [
    "C:/Windows/Fonts/segoeuib.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
]


def first_existing(paths):
    for p in paths:
        if os.path.exists(p):
            return p
    return None


EMOJI_FONT = first_existing(EMOJI_FONTS)
TEXT_FONT = first_existing(TEXT_FONTS)


def hex_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))


def gradient(size, c1, c2, angle=0):
    """Gradient tuyến tính nhanh (không lặp pixel): mask 'L' tạo bằng linear_gradient rồi xoay."""
    w, h = size
    side = int(math.hypot(w, h)) + 4
    mask = Image.linear_gradient("L").resize((side, side))
    mask = mask.rotate(angle, resample=Image.BICUBIC)
    left, top = (side - w) // 2, (side - h) // 2
    mask = mask.crop((left, top, left + w, top + h))
    return Image.composite(Image.new("RGB", size, c2), Image.new("RGB", size, c1), mask)


def emoji_layer(emoji, px):
    """Vẽ emoji màu lên lớp RGBA trong suốt kích thước ~px. Font bitmap (Noto) chỉ có cỡ 109 → vẽ rồi phóng."""
    layer = Image.new("RGBA", (px * 2, px * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    if EMOJI_FONT:
        for size, scale in ((px, 1.0), (109, px / 109)):
            try:
                font = ImageFont.truetype(EMOJI_FONT, size)
                tmp = Image.new("RGBA", (size * 2, size * 2), (0, 0, 0, 0))
                ImageDraw.Draw(tmp).text((size // 2, size // 2), emoji, font=font, embedded_color=True)
                box = tmp.getbbox()
                if not box:
                    continue
                tmp = tmp.crop(box)
                if scale != 1.0:
                    tmp = tmp.resize((max(1, int(tmp.width * scale)), max(1, int(tmp.height * scale))), Image.LANCZOS)
                return tmp
            except Exception:
                continue
    # dự phòng: chữ cái đầu trong vòng tròn
    d.ellipse([px // 2, px // 2, px * 3 // 2, px * 3 // 2], fill=(255, 255, 255, 230))
    f = ImageFont.truetype(TEXT_FONT, px // 2) if TEXT_FONT else ImageFont.load_default()
    d.text((px - px // 6, px - px // 4), "?", font=f, fill=(60, 60, 60, 255))
    return layer.crop(layer.getbbox())


def paste_center(canvas, layer, cx, cy, angle=0, shadow=True):
    if angle:
        layer = layer.rotate(angle, expand=True, resample=Image.BICUBIC)
    x, y = int(cx - layer.width / 2), int(cy - layer.height / 2)
    if shadow:
        sh = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
        alpha = layer.split()[3].point(lambda a: int(a * 0.35))
        blob = Image.new("RGBA", layer.size, (0, 0, 0, 255))
        blob.putalpha(alpha)
        sh.paste(blob, (x + int(layer.width * 0.03), y + int(layer.height * 0.06)), blob)
        sh = sh.filter(ImageFilter.GaussianBlur(max(6, layer.width // 22)))
        canvas.alpha_composite(sh)
    canvas.alpha_composite(layer, (x, y))


def glow(canvas, cx, cy, r, alpha):
    ov = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    ImageDraw.Draw(ov).ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 255, 255, alpha))
    canvas.alpha_composite(ov.filter(ImageFilter.GaussianBlur(r // 12)))


def sparkles(canvas, rnd, n, area):
    w, h = canvas.size
    ov = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    for _ in range(n):
        r = rnd.randint(max(2, w // 120), max(4, w // 40))
        x = rnd.randint(int(w * area[0]), int(w * area[2]))
        y = rnd.randint(int(h * area[1]), int(h * area[3]))
        d.ellipse([x - r, y - r, x + r, y + r], fill=(255, 255, 255, rnd.randint(30, 90)))
    canvas.alpha_composite(ov)


def text_font(px):
    return ImageFont.truetype(TEXT_FONT, px) if TEXT_FONT else ImageFont.load_default()


def wrap_lines(draw, text, font, max_w):
    """Ngắt dòng theo từ sao cho mỗi dòng vừa max_w (một từ quá dài vẫn nằm riêng một dòng)."""
    lines, cur = [], ""
    for word in text.split():
        trial = f"{cur} {word}".strip()
        if cur and draw.textlength(trial, font=font) > max_w:
            lines.append(cur)
            cur = word
        else:
            cur = trial
    if cur:
        lines.append(cur)
    return lines


def balance_two(draw, text, font):
    """Chia `text` thành 2 dòng cân đối nhất (tránh dòng thứ hai chỉ còn một từ lẻ)."""
    words = text.split()
    best = None
    for i in range(1, len(words)):
        a, b = " ".join(words[:i]), " ".join(words[i:])
        w = max(draw.textlength(a, font=font), draw.textlength(b, font=font))
        if best is None or w < best[0]:
            best = (w, [a, b])
    return best[1] if best else [text]


def fit_text(draw, text, max_w, start, min_size, max_lines, single_min=None):
    """Chọn cỡ chữ lớn nhất trong [min_size, start] để `text` vừa max_w và không quá max_lines dòng.
    `single_min`: ưu tiên GIỮ MỘT DÒNG bằng cách co chữ xuống tối thiểu cỡ này; không vừa mới ngắt dòng (2 dòng thì chia cân đối).
    Xuống tới min_size vẫn dài thì cắt bớt và thêm dấu …"""
    if single_min:
        for size in range(start, single_min - 1, -2):
            font = text_font(size)
            if draw.textlength(text, font=font) <= max_w:
                return font, [text], size
    size = start
    while True:
        font = text_font(size)
        lines = wrap_lines(draw, text, font, max_w)
        ok = len(lines) <= max_lines and all(draw.textlength(ln, font=font) <= max_w for ln in lines)
        if ok or size <= min_size:
            break
        size -= 2
    if len(lines) == 2:
        lines = balance_two(draw, text, font)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        lines[-1] = lines[-1].rstrip(" ,.;:·—-") + "…"
    return font, lines, size


def text_box(draw, text, font):
    """Hộp bao của mực chữ (rộng, cao, lệch trái, lệch trên) — để canh giữa chữ trong nút/chip mà không cần anchor."""
    l, t, r, b = draw.textbbox((0, 0), text, font=font)
    return r - l, b - t, l, t


def render_banner(item, c1, c2, rnd):
    """Banner web 1600×520 (tỉ lệ ~3:1): gradient tối ở bên trái cho chữ trắng dễ đọc, emoji ngành to bên phải,
    nhãn nhỏ (chip) + TIÊU ĐỀ lớn + dòng phụ + nút bo góc trắng chữ màu theme. Tiêu đề/dòng phụ dài thì tự co cỡ chữ."""
    w, h = 1600, 520
    # góc -90: trái = c2 (đậm), phải = c1 (nhạt); lệch nhẹ ±12° cho mỗi banner một nhịp riêng
    img = gradient((w, h), c1, c2, angle=-90 + rnd.choice([-12, 0, 12])).convert("RGBA")
    # lớp tối dần từ trái sang phải (0.32 → 0) giữ độ tương phản cho chữ trắng ở mọi theme
    fade = Image.linear_gradient("L").rotate(90).resize((w, h))  # trái = 0 → phải = 255
    shade = Image.new("RGBA", (w, h), (0, 0, 0, 255))
    shade.putalpha(ImageChops.invert(fade).point(lambda a: int(a * 0.32)))
    img.alpha_composite(shade)

    cx, cy = 1285, 262
    glow(img, cx, cy, 340, 36)
    glow(img, cx, cy, 230, 34)
    rings = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    rd = ImageDraw.Draw(rings)
    for r, a in ((300, 46), (390, 30), (480, 18)):
        rd.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(255, 255, 255, a), width=3)
    img.alpha_composite(rings)
    sparkles(img, rnd, 22, (0.62, 0.05, 0.99, 0.95))
    paste_center(img, emoji_layer(item["emoji"], 320), cx, cy, angle=-8)

    left, max_w = 96, 880
    title, sub = item.get("label", ""), item.get("subtitle", "")
    tag, cta = item.get("tag", ""), item.get("cta") or "Mua ngay"

    d = ImageDraw.Draw(img)
    t_font, t_lines, t_size = fit_text(d, title, max_w, 96, 54, 2, single_min=68)
    s_font, s_lines, s_size = fit_text(d, sub, max_w, 36, 26, 2, single_min=28) if sub else (None, [], 0)
    t_lh, s_lh = int(t_size * 1.2), int(s_size * 1.4)
    chip_h, btn_h = 46, 70
    total = (chip_h + 26 if tag else 0) + len(t_lines) * t_lh + (20 + len(s_lines) * s_lh if s_lines else 0) + 34 + btn_h
    y = max(24, (h - total) // 2)

    c_font = text_font(24)
    chip_w = int(d.textlength(tag, font=c_font)) + 44 if tag else 0
    if tag:
        chip = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        ImageDraw.Draw(chip).rounded_rectangle(
            [left, y, left + chip_w, y + chip_h], radius=chip_h // 2, fill=(255, 255, 255, 52), outline=(255, 255, 255, 120), width=2
        )
        img.alpha_composite(chip)
        d = ImageDraw.Draw(img)  # tạo lại sau khi alpha_composite để chắc chắn vẽ lên ảnh mới nhất
        tw, th, ox, oy = text_box(d, tag, c_font)
        d.text((left + (chip_w - tw) // 2 - ox, y + (chip_h - th) // 2 - oy), tag, font=c_font, fill=(255, 255, 255, 255))
        y += chip_h + 26

    for ln in t_lines:
        d.text((left, y), ln, font=t_font, fill=(255, 255, 255, 255))
        y += t_lh
    if s_lines:
        y += 20
        for ln in s_lines:
            d.text((left, y), ln, font=s_font, fill=(255, 255, 255, 255))
            y += s_lh

    y += 34
    b_font = text_font(32)
    label = f"{cta}  →"
    bw_text, bh_text, ox, oy = text_box(d, label, b_font)
    btn_w = bw_text + 88
    d.rounded_rectangle([left, y, left + btn_w, y + btn_h], radius=btn_h // 2, fill=(255, 255, 255, 255))
    d.text((left + (btn_w - bw_text) // 2 - ox, y + (btn_h - bh_text) // 2 - oy), label, font=b_font, fill=(*c2, 255))
    return img


def render(item, force=False):
    out = os.path.join(ASSETS, item["out"])
    if os.path.exists(out) and not force:
        return False
    os.makedirs(os.path.dirname(out), exist_ok=True)
    c1, c2 = (hex_rgb(c) for c in item["colors"])
    kind = item["kind"]
    seed = int(hashlib.md5(item["out"].encode()).hexdigest()[:8], 16)
    rnd = random.Random(seed)

    if kind in ("product", "category"):
        size = (512, 512)
        img = gradient(size, c1, c2, angle=rnd.choice([0, 20, -20, 35])).convert("RGBA")
        glow(img, 256, 250, 190, 38)
        glow(img, 256, 250, 130, 34)
        sparkles(img, rnd, 14, (0.05, 0.05, 0.95, 0.95))
        paste_center(img, emoji_layer(item["emoji"], 270), 256, 250)
    elif kind == "product-hover":
        size = (512, 512)
        img = gradient(size, c2, c1, angle=rnd.choice([90, 70, 110])).convert("RGBA")
        glow(img, 300, 230, 170, 36)
        sparkles(img, rnd, 18, (0.05, 0.05, 0.95, 0.95))
        paste_center(img, emoji_layer(item["emoji"], 240), 280, 245, angle=rnd.choice([-14, -10, 12]))
        if item.get("emoji2"):
            glow(img, 120, 400, 70, 120)
            paste_center(img, emoji_layer(item["emoji2"], 90), 120, 400)
    elif kind == "collection":
        size = (960, 1200)
        img = gradient(size, c1, c2, angle=0).convert("RGBA")
        glow(img, 480, 470, 330, 34)
        glow(img, 480, 470, 230, 36)
        sparkles(img, rnd, 30, (0.05, 0.05, 0.95, 0.9))
        paste_center(img, emoji_layer(item["emoji"], 430), 480, 470)
    elif kind == "shop-logo":
        size = (512, 512)
        img = gradient(size, c1, c2, angle=35).convert("RGBA")
        glow(img, 256, 256, 200, 40)
        paste_center(img, emoji_layer(item["emoji"], 260), 256, 256)
    elif kind == "shop-banner":
        size = (1200, 300)
        img = gradient(size, c1, c2, angle=90).convert("RGBA")
        glow(img, 1000, 150, 260, 30)
        sparkles(img, rnd, 24, (0.3, 0.05, 0.98, 0.95))
        paste_center(img, emoji_layer(item["emoji"], 200), 1030, 150, angle=-8)
        d = ImageDraw.Draw(img)
        label = item.get("label", "")
        d.text((64, 96), label, font=text_font(66), fill=(255, 255, 255, 255))
        d.text((66, 190), "Chính hãng · Giao nhanh · Đổi trả dễ dàng", font=text_font(26), fill=(255, 255, 255, 190))
    elif kind == "banner":
        # banner trang chủ theo ngành hàng + 3 banner khuyến mãi chung (manifest: label = tiêu đề, subtitle, tag, cta)
        img = render_banner(item, c1, c2, rnd)
    else:
        raise ValueError(kind)

    img.convert("RGB").save(out, "JPEG", quality=82, optimize=True)
    return True


def main():
    # Windows mặc định in cp1252 — ép UTF-8 để log tiếng Việt không làm script chết ở dòng cuối
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    force = "--force" in sys.argv
    with open(MANIFEST, encoding="utf-8") as f:
        items = json.load(f)["items"]
    if not EMOJI_FONT:
        print("CẢNH BÁO: không tìm thấy font emoji màu — ảnh sẽ dùng biểu tượng dự phòng")
    made = 0
    for i, it in enumerate(items, 1):
        if render(it, force):
            made += 1
        if i % 100 == 0:
            print(f"  {i}/{len(items)} ...", flush=True)
    print(f"Xong: sinh mới {made}/{len(items)} ảnh (đã có thì bỏ qua) → {ASSETS}")


if __name__ == "__main__":
    main()
