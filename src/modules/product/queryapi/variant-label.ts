/* Một trục của biến thể ngành dynamic (ProductVariantOption) — chỉ phần cần để dựng nhãn. */
export interface VariantOptionLite {
  attributeId: string;
  displayValue: string;
}

/* Mã thuộc tính được coi là "màu" (vd color, color2, mau_sac) — thuộc tính động tự đặt mã nên so khớp theo mẫu, không theo giá trị cố định. */
const COLOR_CODE = /colou?r|(^|[^a-z])mau([^a-z]|$)/i;

/*
 * Quy ước hiển thị "màu / size" cho biến thể ngành DYNAMIC (không có colorName/sizeCode) — dùng chung cho snapshot giỏ/đơn,
 * bảng tồn kho và mọi chỗ UI cũ vẫn đọc cặp color/size, để dòng đơn/giỏ không hiện trống ("()", "/"):
 *  - color = giá trị của trục "màu" (attribute.code khớp COLOR_CODE) nếu có; không có thì là giá trị trục ĐẦU TIÊN;
 *  - size  = các giá trị trục CÒN LẠI nối " / " (rỗng nếu biến thể chỉ có một trục).
 * Ví dụ {Màu: Đen, Dung lượng: 128GB} → color "Đen", size "128GB"; chỉ {Dung lượng: 128GB} → color "128GB", size "".
 * Thứ tự trục cố định theo attributeId (bảng option không có cột thứ tự) nên cùng ngành luôn ra cùng thứ tự.
 */
export function dynamicColorSize(options: readonly VariantOptionLite[], attrCodes: ReadonlyMap<string, { code: string }>): { color: string; size: string } {
  if (options.length === 0) return { color: '', size: '' };
  const sorted = [...options].sort((a, b) => a.attributeId.localeCompare(b.attributeId));
  const colorAt = Math.max(0, sorted.findIndex((o) => COLOR_CODE.test(attrCodes.get(o.attributeId)?.code ?? '')));
  const color = sorted[colorAt].displayValue;
  const size = sorted.filter((_, i) => i !== colorAt).map((o) => o.displayValue).join(' / ');
  return { color, size };
}
