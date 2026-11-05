/*
 * PLAN-0043: kích thước theo biến thể. Bỏ trường = giữ giá trị đang có; null = xoá để dùng mặc định hệ thống.
 * Chỉ chép các trường kiện hàng, không mang stock/reserved/id từ lệnh sửa biến thể vào repository.
 */
export interface VariantParcel {
  weightGram?: number | null;
  lengthCm?: number | null;
  widthCm?: number | null;
  heightCm?: number | null;
}

export const VARIANT_PARCEL_LIMITS = { weightGram: 50_000, lengthCm: 200, widthCm: 200, heightCm: 200 } as const;

export function variantParcelFields(value: VariantParcel): VariantParcel {
  const result: VariantParcel = {};
  for (const key of Object.keys(VARIANT_PARCEL_LIMITS) as Array<keyof VariantParcel>) {
    if (value[key] !== undefined) result[key] = value[key];
  }
  return result;
}
