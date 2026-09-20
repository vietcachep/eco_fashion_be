/* Giới tính sản phẩm — dùng chung catalog/product/ai (enums = phần công khai của module). */
export const GENDERS = ['nam', 'nu', 'unisex'] as const;
export type Gender = (typeof GENDERS)[number];
