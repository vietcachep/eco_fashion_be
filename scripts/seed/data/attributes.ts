/*
 * Bộ thuộc tính động DÙNG CHUNG nhiều ngành (PLAN-0016). Mã (`code`) là khoá — file `dept/*.ts` có thể khai BỔ SUNG giá trị cho cùng mã
 * (seeder gộp hợp các `values`) hoặc thêm thuộc tính riêng của ngành mình. Thuộc tính `select` thì giá trị của sản phẩm PHẢI nằm trong `values`.
 */
import type { SeedAttribute } from './types';

export const COLOR_HEX: Record<string, string> = {
  Đỏ: '#e11d48', Xanh: '#2563eb', Vàng: '#facc15', Đen: '#111827', Trắng: '#f8fafc', Xám: '#9ca3af', Hồng: '#f472b6', 'Xanh lá': '#22c55e',
  Nâu: '#78350f', Be: '#d9c8a9', Bạc: '#cbd5e1', Tím: '#7c3aed', Cam: '#f97316', 'Xanh navy': '#1e3a8a', 'Vàng đồng': '#b8860b', 'Xanh mint': '#6ee7b7',
};

export const BASE_ATTRIBUTES: SeedAttribute[] = [
  { code: 'color2', name: 'Màu sắc', inputType: 'select', values: Object.keys(COLOR_HEX), hex: COLOR_HEX },
  { code: 'storage', name: 'Dung lượng', inputType: 'select', values: ['32GB', '64GB', '128GB', '256GB', '512GB', '1TB', '2TB'] },
  { code: 'ram', name: 'RAM', inputType: 'select', values: ['4GB', '6GB', '8GB', '12GB', '16GB', '32GB'] },
  { code: 'origin', name: 'Xuất xứ', inputType: 'select', values: ['Việt Nam', 'Trung Quốc', 'Nhật Bản', 'Hàn Quốc', 'Thái Lan', 'Mỹ', 'Đức', 'Pháp', 'Ý', 'Đài Loan', 'Singapore', 'Malaysia', 'Anh', 'Thụy Sĩ', 'Úc', 'New Zealand'] },
  { code: 'warranty', name: 'Bảo hành', inputType: 'text' },
  { code: 'brand', name: 'Thương hiệu', inputType: 'select', values: [] },
  { code: 'material2', name: 'Chất liệu', inputType: 'select', values: ['Nhựa', 'Kim loại', 'Inox 304', 'Thép không gỉ', 'Gỗ tự nhiên', 'Gỗ công nghiệp', 'Da PU', 'Da thật', 'Vải canvas', 'Vải cotton', 'Thủy tinh', 'Gốm sứ', 'Silicone', 'Nylon', 'Polyester', 'Lưới thoáng khí', 'Sợi carbon', 'Hợp kim nhôm', 'Cao su', 'Tre', 'Mây tre đan'] },
];
