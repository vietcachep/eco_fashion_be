/*
 * Tiện ích sinh ảnh đại diện mặc định chữ cái đầu tiên (PLAN-0002 / Avatar Rule):
 * - Khi người dùng chưa upload ảnh đại diện, BE tự động tạo avatar vector SVG với chữ cái đầu tiên.
 * - Bảng màu hiện đại, xác định cố định (deterministic) theo chuỗi tên/email.
 * - Hỗ trợ chuẩn tiếng Việt (A, Ă, Â, Đ, E, Ê, O, Ô, Ơ...).
 * - Định dạng Data URI SVG (`data:image/svg+xml;utf8,...`) giúp trình duyệt hiển thị ngay lập tức
 *   mà không cần thêm request mạng, không bị phụ thuộc server ảnh ngoài.
 */

const PALETTE = [
  '#2563eb', // Blue
  '#7c3aed', // Purple
  '#db2777', // Pink
  '#ea580c', // Orange
  '#16a34a', // Green
  '#0891b2', // Cyan
  '#4f46e5', // Indigo
  '#d97706', // Amber
  '#e11d48', // Rose
  '#059669', // Emerald
];

export function extractInitialChar(nameOrEmail?: string | null): string {
  const clean = (nameOrEmail || '').trim();
  if (!clean) return 'U';

  // Lấy ký tự hợp lệ đầu tiên (xử lý unicode ký tự ghép)
  const segments = Array.from(clean);
  const first = segments[0] || 'U';
  return first.toUpperCase();
}

export function deterministicColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

export function generateInitialAvatarSvg(nameOrEmail?: string | null): string {
  const clean = (nameOrEmail || '').trim();
  const char = extractInitialChar(clean);
  const bg = deterministicColor(clean || 'ecofashion');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128"><rect width="128" height="128" rx="64" fill="${bg}"/><text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif" font-size="58" font-weight="700" fill="#ffffff">${char}</text></svg>`;
}

export function generateInitialAvatarDataUri(nameOrEmail?: string | null): string {
  const svg = generateInitialAvatarSvg(nameOrEmail);
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export function resolveAvatarUrl(avatarUrl?: string | null, nameOrEmail?: string | null): string {
  if (avatarUrl && avatarUrl.trim().length > 0) {
    return avatarUrl.trim();
  }
  return generateInitialAvatarDataUri(nameOrEmail);
}
