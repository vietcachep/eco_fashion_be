export const VISUAL_DIMENSIONS = 768;
export interface VisualHit {
  productId: string;
  imageId: string;
  sourceUrl: string;
  colorCode: string | null;
  similarity: number;
}
export interface VisualRegion {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface VisualMatch {
  productId: string;
  imageUrl: string;
  colorCode: string | null;
  relevance: 'similar' | 'related';
  reason: string;
}
export function normaliseVisualVector(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    value.length !== VISUAL_DIMENSIONS ||
    value.some((n: unknown) => typeof n !== 'number' || !Number.isFinite(n))
  )
    throw new Error('Vector ảnh không hợp lệ');
  const vector = value as number[];
  const norm = Math.hypot(...vector);
  if (norm < 1e-8) throw new Error('Vector ảnh rỗng');
  return vector.map((n) => n / norm);
}
export function visualVectorSql(value: number[]): string {
  return `[${normaliseVisualVector(value).join(',')}]`;
}
export function parseVisualRegions(value: unknown): VisualRegion[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 6).flatMap((item: unknown, i): VisualRegion[] => {
    if (!item || typeof item !== 'object') return [];
    const r = item as Record<string, unknown>;
    const { x, y, width, height } = r;
    if ([x, y, width, height].some((n) => typeof n !== 'number' || !Number.isFinite(n))) return [];
    const box = { x: x as number, y: y as number, width: width as number, height: height as number };
    if (
      box.x < 0 ||
      box.y < 0 ||
      box.width < 0.03 ||
      box.height < 0.03 ||
      box.x + box.width > 1.001 ||
      box.y + box.height > 1.001
    )
      return [];
    return [
      { id: String(i + 1), label: typeof r.label === 'string' ? r.label.slice(0, 80) : 'Sản phẩm', ...box },
    ];
  });
}
