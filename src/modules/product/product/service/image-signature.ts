export type DetectedImageType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

/*
 * Nhận dạng ảnh theo MAGIC BYTES (đầu file) thay vì tin `Content-Type`/đuôi file do client khai — client có thể gửi script/HTML/SVG
 * đội lốt `image/png`. Chỉ nhận 4 định dạng StorageService cho phép: JPEG (FF D8 FF), PNG (89 50 4E 47 0D 0A 1A 0A),
 * GIF (GIF87a/GIF89a), WebP (RIFF....WEBP). Không khớp → null.
 */
export function detectImageType(buf: Buffer): DetectedImageType | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  const head6 = buf.subarray(0, 6).toString('latin1');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}
