/*
 * Ngành gốc "Ô tô & Xe máy" — phụ kiện ô tô, xe máy, mũ bảo hiểm, dầu nhớt, chất chăm sóc xe.
 */
import type { DeptSeed } from '../types';

const dept: DeptSeed = {
  slug: 'o-to-xe-may',
  name: 'Ô tô & Xe máy',
  description: 'Phụ kiện ô tô, xe máy, mũ bảo hiểm, dầu nhớt, sơn sửa, chất chăm sóc xe',
  sortOrder: 130,
  icon: '🏍️',
  theme: 'violet',
  attributes: [
    { code: 'brand', name: 'Thương hiệu', inputType: 'select', values: ['AutoCare Pro', 'MotoShield', 'SafeDrive', 'PowerGear', 'BikeGuard', 'MotoDrive', 'VehiclePlus', 'EngineMax', 'GearPro', 'RoadSafe'] },
    { code: 'vehicle_type', name: 'Loại xe', inputType: 'select', values: ['Ô tô', 'Xe máy', 'Xe số', 'Xe tay ga'] },
    { code: 'helmet_size', name: 'Kích thước mũ', inputType: 'select', values: ['M', 'L', 'XL'] },
    { code: 'compatible_with', name: 'Tương thích với', inputType: 'text' },
    { code: 'capacity', name: 'Dung tích / Quy cách', inputType: 'select', values: ['4L', '1L', '250g', '500ml', '1 bộ', '12V', '12V - 24V'] },
    { code: 'material2', name: 'Chất liệu', inputType: 'select', values: ['Nhựa', 'Kim loại', 'Inox 304', 'Thép không gỉ', 'Gỗ tự nhiên', 'Gỗ công nghiệp', 'Da PU', 'Da thật', 'Vải canvas', 'Vải cotton', 'Thủy tinh', 'Gốm sứ', 'Silicone', 'Nylon', 'Polyester', 'Lưới thoáng khí', 'Sợi carbon', 'Hợp kim nhôm', 'Cao su', 'Tre', 'Mây tre đan', 'Oxford', 'Vải'] },
  ],
  categories: [
    {
      slug: 'phu-kien-o-to', name: 'Phụ kiện ô tô', description: 'Tay lái, ghế nỉ, tấm chống nắng, giá đỡ điện thoại, đầu ghi hình, mùi thơm', sortOrder: 131, icon: '🚗', theme: 'sky',
      attrs: [
        { code: 'brand' },
        { code: 'color2' },
        { code: 'material2' },
        { code: 'compatible_with' },
        { code: 'origin' },
      ],
    },
    {
      slug: 'phu-kien-xe-may', name: 'Phụ kiện xe máy', description: 'Gương chiếu hậu, tay lái, giác định tốc độ, yên xe, túi gắn xe', sortOrder: 132, icon: '🏍️', theme: 'orange',
      attrs: [
        { code: 'brand' },
        { code: 'vehicle_type', required: true },
        { code: 'color2' },
        { code: 'material2' },
        { code: 'compatible_with' },
        { code: 'origin' },
      ],
    },
    {
      slug: 'mu-bao-hiem', name: 'Mũ bảo hiểm', description: 'Mũ nón bảo hiểm trọn bộ, mũ nón kiểu, mũ chỉ bằng', sortOrder: 133, icon: '⛑️', theme: 'rose',
      attrs: [
        { code: 'brand', required: true },
        { code: 'helmet_size', required: true, axis: true },
        { code: 'color2', axis: true },
        { code: 'material2' },
        { code: 'origin' },
        { code: 'warranty' },
      ],
    },
    {
      slug: 'cham-soc-xe', name: 'Chăm sóc & Bảo dưỡng', description: 'Dầu nhớt, chất rửa, sơn sửa, quế pô, mỡ bạc đạn', sortOrder: 134, icon: '🛢️', theme: 'brown',
      attrs: [
        { code: 'brand' },
        { code: 'vehicle_type' },
        { code: 'capacity', required: true },
        { code: 'origin' },
      ],
    },
  ],
  products: [
    // ---- PHU-KIEN-O-TO (Car Accessories) ----
    { slug: 'giu-do-dien-thoai-o-to-nam-tren-tap-lo', name: 'Giá đỡ điện thoại ô tô nam trên tập lô', shop: 'auto-moto-pro', category: 'phu-kien-o-to', price: 125000, listPrice: 158000, short: 'Giá đỡ điện thoại hút chân không, xoay 360 độ, chắc chắn.', desc: 'Giá đỡ điện thoại ô tô nam tập lô, đế hút chân không mạnh mẽ, xoay 360 độ, tương thích tất cả điện thoại từ 4.7 inch đến 7 inch, không cần dán keo.', attrs: { brand: 'SafeDrive', color2: 'Đen', material2: 'Nhựa', compatible_with: 'Tất cả điện thoại 4.7"-7"', origin: 'Trung Quốc' }, sold: 1240, featured: true, tags: ['sale'], img: { emoji: '📱', theme: 'sky', emoji2: '🚗', query: 'car phone holder' } },
    { slug: 'tay-lai-co-nhan-tao-sac-chat-bang-khong-chat', name: 'Tay lái cơ nhân tạo sắc chất bàng không chất', shop: 'auto-moto-pro', category: 'phu-kien-o-to', price: 185000, short: 'Tay lái ô tô bọc da, nỉ mềm mại, thoáng khí, dễ cắm.', attrs: { brand: 'MotoDrive', color2: 'Đen', material2: 'Da PU', compatible_with: 'Phổ dụng ô tô', origin: 'Trung Quốc' }, sold: 680, isNew: true, tags: ['new'], img: { emoji: '🛞', theme: 'slate', emoji2: '🚗', query: 'steering wheel cover' } },
    { slug: 'tap-lo-che-nang-sua-toan-bo', name: 'Tập lô chế nắng sự toàn bộ', shop: 'auto-moto-pro', category: 'phu-kien-o-to', price: 95000, listPrice: 128000, short: 'Che nắng tập lô, giảm nhiệt trong xe, bảo vệ.', attrs: { brand: 'PowerGear', color2: 'Xám', material2: 'Vải', origin: 'Trung Quốc' }, sold: 920, featured: true, tags: ['sale'], img: { emoji: '☀️', theme: 'amber', emoji2: '🚗', query: 'car dashboard sunshade' } },
    { slug: 'tham-thau-o-to-3d-eco', name: 'Thảm thau ô tô 3D Eco', shop: 'auto-moto-pro', category: 'phu-kien-o-to', price: 285000, listPrice: 350000, short: '3D eco thảm cao su ô tô, dễ vệ sinh, bền lâu.', desc: 'Thảm ô tô 3D eco cao su, mặt lõi TPE, dễ vệ sinh, bền lâu, khít sàn xe, không thơi bị nước chảy vào sàn.', attrs: { brand: 'AutoCare Pro', color2: 'Đen', material2: 'Cao su', compatible_with: 'Phổ dụng', origin: 'Trung Quốc' }, sold: 420, img: { emoji: '🏠', theme: 'slate', emoji2: '🚗', query: 'car floor mats 3d' } },
    { slug: 'camera-hanh-trinh-1080p-day-dem', name: 'Camera hành trình 1080P đầy đêm', shop: 'auto-moto-pro', category: 'phu-kien-o-to', price: 1250000, listPrice: 1589000, short: 'Camera ô tô 1080p, quay đêm rõ, góc rộng 170°, lưu thẻ nhớ.', desc: 'Camera hành trình ô tô phân giải 1080P full HD, quay đêm công nghệ CMOS Sony, góc rộng 170 độ, lưu tự động, hỗ trợ thẻ nhớ tối đa 128GB, chống sốc.', attrs: { brand: 'GearPro', color2: 'Đen', compatible_with: '12V - 24V', origin: 'Trung Quốc' }, sold: 185, featured: true, tags: ['sale'], img: { emoji: '📹', theme: 'indigo', emoji2: '🌙', query: 'car dash cam 1080p' } },
    { slug: 'den-led-noi-that-o-to-8-mau', name: 'Đèn LED nội thất ô tô 8 màu', shop: 'auto-moto-pro', category: 'phu-kien-o-to', price: 185000, short: 'Đèn LED nội thất ô tô, 8 màu, điều khiển từ xa, USB.', attrs: { brand: 'RoadSafe', color2: 'Đỏ', compatible_with: '12V', origin: 'Trung Quốc' }, sold: 580, img: { emoji: '💡', theme: 'fuchsia', emoji2: '🚗', query: 'car led ambient light' } },
    { slug: 'cot-do-xang-dien-tu-o-to', name: 'Cột độ xăng điện tử ô tô HUD', shop: 'auto-moto-pro', category: 'phu-kien-o-to', price: 425000, listPrice: 525000, short: 'Cột độ xăng HUD, hiển thị tốc độ, nhiệt độ nước.', attrs: { brand: 'VehiclePlus', color2: 'Xanh', compatible_with: 'Phổ dụng', origin: 'Trung Quốc' }, sold: 310, tags: ['sale'], img: { emoji: '📊', theme: 'violet', emoji2: '🚗', query: 'car hud display' } },

    // ---- PHU-KIEN-XE-MAY (Motorbike Accessories) ----
    { slug: 'guong-chieu-hau-xe-may-cau-vong', name: 'Gương chiếu hậu xe máy cầu vồng', shop: 'auto-moto-pro', category: 'phu-kien-xe-may', price: 85000, listPrice: 108000, short: 'Gương chiếu hậu xe máy, cầu vồng lá trái, rộng rãi.', attrs: { brand: 'MotoShield', vehicle_type: 'Xe máy', color2: 'Đen', material2: 'Kim loại', compatible_with: 'Phổ dụng', origin: 'Trung Quốc' }, sold: 1580, featured: true, tags: ['sale'], img: { emoji: '🪞', theme: 'teal', emoji2: '🏍️', query: 'motorbike mirror' } },
    { slug: 'tay-lai-xe-may-cao-su-chong-toc', name: 'Tay lái xe máy cao su chống trơn', shop: 'auto-moto-pro', category: 'phu-kien-xe-may', price: 65000, short: 'Tay lái cao su, chống trơn, chống va đập, thoáng khí.', attrs: { brand: 'PowerGear', vehicle_type: 'Xe số', color2: 'Đen', material2: 'Cao su', compatible_with: 'Phổ dụng', origin: 'Việt Nam' }, sold: 920, img: { emoji: '🛞', theme: 'slate', emoji2: '🏍️', query: 'motorbike handlebar grip' } },
    { slug: 'bao-chu-xe-may-chong-mua-nang', name: 'Bao chu xe máy chống mưa nắng', shop: 'auto-moto-pro', category: 'phu-kien-xe-may', price: 145000, listPrice: 185000, short: 'Bao che xe máy, chống mưa, chống nắng, chống bụi.', desc: 'Bao chu xe máy vải 600D, chống nước hoàn toàn, chống tia UV, có các túi để dây buộc, phù hợp xe máy từ 100cc đến 150cc.', attrs: { brand: 'BikeGuard', vehicle_type: 'Xe máy', color2: 'Xám', material2: 'Polyester', compatible_with: '100cc-150cc', origin: 'Trung Quốc' }, sold: 680, featured: true, tags: ['sale'], img: { emoji: '🧥', theme: 'slate', emoji2: '🏍️', query: 'motorcycle cover' } },
    { slug: 'yeu-xe-may-chon-mem', name: 'Yên xe máy chuyên mềm', shop: 'auto-moto-pro', category: 'phu-kien-xe-may', price: 285000, short: 'Yên xe máy da cao cấp, mềm êm, thoáng khí, bền lâu.', attrs: { brand: 'EngineMax', vehicle_type: 'Xe tay ga', color2: 'Đen', material2: 'Da PU', compatible_with: 'Phổ dụng', origin: 'Trung Quốc' }, sold: 420, isNew: true, tags: ['new'], img: { emoji: '💺', theme: 'brown', emoji2: '🏍️', query: 'motorcycle seat' } },
    { slug: 'tui-ganh-xe-may-chong-nuoc', name: 'Túi gắn xe máy chống nước', shop: 'auto-moto-pro', category: 'phu-kien-xe-may', price: 165000, listPrice: 210000, short: 'Túi gắn trước xe máy, chống nước 100%, thoáng khí.', attrs: { brand: 'RoadSafe', vehicle_type: 'Xe máy', color2: 'Đen', material2: 'Nylon', compatible_with: 'Phổ dụng', origin: 'Trung Quốc' }, sold: 540, tags: ['sale'], img: { emoji: '🎒', theme: 'indigo', emoji2: '🏍️', query: 'motorbike bag' } },
    { slug: 'giac-dinh-toc-do-xe-may-dien-tu', name: 'Giác định tốc độ xe máy điện tử', shop: 'auto-moto-pro', category: 'phu-kien-xe-may', price: 235000, short: 'Đồng hồ tốc độ xe máy, hiển thị LCD, độ chính xác cao.', attrs: { brand: 'VehiclePlus', vehicle_type: 'Xe máy', compatible_with: 'Phổ dụng', origin: 'Trung Quốc' }, sold: 310, img: { emoji: '⏱️', theme: 'orange', emoji2: '🏍️', query: 'motorcycle speedometer' } },
    { slug: 'chuot-tron-chong-rung-xe-may', name: 'Chuôi trộn chống rung xe máy', shop: 'auto-moto-pro', category: 'phu-kien-xe-may', price: 75000, listPrice: 95000, short: 'Chuôi trộn xe máy, vật liệu cao su chống rung.', attrs: { brand: 'MotoDrive', vehicle_type: 'Xe số', color2: 'Đen', material2: 'Cao su', compatible_with: 'Phổ dụng', origin: 'Trung Quốc' }, sold: 780, tags: ['sale'], img: { emoji: '🎚️', theme: 'slate', emoji2: '🏍️', query: 'motorbike throttle grip' } },

    // ---- MU-BAO-HIEM (Helmets) ----
    { slug: 'mu-bao-hiem-fullface-aman-m', name: 'Mũ bảo hiểm fullface Aman', shop: 'auto-moto-pro', category: 'mu-bao-hiem', price: 385000, listPrice: 485000, short: 'Mũ fullface an toàn, chất lượng cao, lót trong thoáng.', desc: 'Mũ bảo hiểm fullface Aman, vỏ abs, chuẩn QH 4049:2007, kính clear, có lót trong thoáng khí, có tấm chắn gió, tuyệt vời cho tốc độ cao.', attrs: { brand: 'SafeDrive', material2: 'Nhựa', origin: 'Việt Nam', warranty: '12 tháng bảo hành' }, axes: [{ attr: 'helmet_size', values: ['M', 'L'] }, { attr: 'color2', values: ['Đen', 'Xanh', 'Đỏ'] }], sold: 580, featured: true, tags: ['sale'], img: { emoji: '⛑️', theme: 'slate', emoji2: '🏍️', query: 'fullface motorcycle helmet' } },
    { slug: 'mu-bao-hiem-fullface-speed-l', name: 'Mũ bảo hiểm fullface Speed', shop: 'auto-moto-pro', category: 'mu-bao-hiem', price: 425000, short: 'Mũ fullface speed, kính đen, thoáng khí tốt.', attrs: { brand: 'MotoShield', material2: 'Nhựa', origin: 'Trung Quốc', warranty: '12 tháng' }, axes: [{ attr: 'helmet_size', values: ['L', 'XL'] }, { attr: 'color2', values: ['Đỏ', 'Xanh', 'Vàng'] }], sold: 420, img: { emoji: '⛑️', theme: 'rose', emoji2: '🏍️', query: 'red fullface helmet' } },
    { slug: 'mu-nua-dau-airflow-xl', name: 'Mũ nửa đầu Airflow', shop: 'auto-moto-pro', category: 'mu-bao-hiem', price: 285000, listPrice: 359000, short: 'Mũ nửa đầu, thoáng khí, nhẹ, an toàn chuẩn.', attrs: { brand: 'BikeGuard', material2: 'Nhựa', origin: 'Trung Quốc', warranty: '12 tháng bảo hành' }, axes: [{ attr: 'helmet_size', values: ['M', 'L', 'XL'] }, { attr: 'color2', values: ['Xám', 'Đen', 'Cam'] }], sold: 680, featured: true, tags: ['sale'], img: { emoji: '⛑️', theme: 'slate', emoji2: '🏍️', query: 'half face helmet' } },
    { slug: 'mu-chi-bang-protect-pro-m', name: 'Mũ chỉ bằng Protect Pro', shop: 'auto-moto-pro', category: 'mu-bao-hiem', price: 165000, short: 'Mũ chỉ bằng, nhẹ, thoáng khí, giá bình dân.', attrs: { brand: 'PowerGear', material2: 'Nhựa', origin: 'Trung Quốc', warranty: '6 tháng' }, axes: [{ attr: 'helmet_size', values: ['M', 'L'] }, { attr: 'color2', values: ['Xanh navy', 'Đen', 'Nâu'] }], sold: 1240, isNew: true, tags: ['new'], img: { emoji: '⛑️', theme: 'navy', emoji2: '🏍️', query: 'half helmet chin bar' } },
    { slug: 'mu-bao-hiem-thao-tac-quoc-phong-l', name: 'Mũ bảo hiểm thao tác quốc phòng', shop: 'auto-moto-pro', category: 'mu-bao-hiem', price: 325000, short: 'Mũ bảo hiểm kiểu quân đội, an toàn cao, thoáng khí.', attrs: { brand: 'SafeDrive', material2: 'Nhựa', origin: 'Trung Quốc', warranty: '12 tháng' }, axes: [{ attr: 'helmet_size', values: ['L', 'XL'] }, { attr: 'color2', values: ['Xanh lá', 'Đen', 'Be'] }], sold: 320, featured: true, img: { emoji: '⛑️', theme: 'emerald', emoji2: '🪖', query: 'tactical helmet' } },
    { slug: 'mu-nua-dau-phong-gio-coi-xl', name: 'Mũ nửa đầu phong gió có coi', shop: 'auto-moto-pro', category: 'mu-bao-hiem', price: 295000, listPrice: 370000, short: 'Mũ nửa đầu có kính chắn gió, thoáng, bền.', attrs: { brand: 'RoadSafe', material2: 'Nhựa', origin: 'Trung Quốc', warranty: '12 tháng' }, axes: [{ attr: 'helmet_size', values: ['M', 'XL'] }, { attr: 'color2', values: ['Đen', 'Bạc', 'Cam'] }], sold: 450, tags: ['sale'], img: { emoji: '⛑️', theme: 'slate', emoji2: '💨', query: 'half helmet with visor' } },

    // ---- CHAM-SOC-XE (Maintenance & Care) ----
    { slug: 'dau-nhot-dong-co-10w30-4l', name: 'Dầu nhớt động cơ 10W30 4L', shop: 'auto-moto-pro', category: 'cham-soc-xe', price: 285000, listPrice: 350000, short: 'Dầu nhớt xe máy ô tô, bảo vệ động cơ, giảm mài mòn.', attrs: { brand: 'EngineMax', vehicle_type: 'Ô tô', capacity: '4L', origin: 'Thái Lan' }, sold: 920, featured: true, tags: ['sale'], img: { emoji: '🛢️', theme: 'brown', emoji2: '⚙️', query: 'engine oil 10w30' } },
    { slug: 'dau-nhot-canh-tay-nhan-tao-xe-may', name: 'Dầu nhớt canh tay nhân tạo xe máy', shop: 'auto-moto-pro', category: 'cham-soc-xe', price: 95000, short: 'Dầu canh tay xe máy, trơn nhẹ, không kêu', attrs: { brand: 'PowerGear', vehicle_type: 'Xe máy', capacity: '1L', origin: 'Trung Quốc' }, sold: 580, img: { emoji: '🫙', theme: 'amber', emoji2: '⚙️', query: 'clutch oil motorbike' } },
    { slug: 'nuoc-rua-kinh-o-to-4l-hoa-huong', name: 'Nước rửa kính ô tô 4L hoa hương', shop: 'auto-moto-pro', category: 'cham-soc-xe', price: 68000, listPrice: 85000, short: 'Nước rửa kính sạch bong, mùi thơm, không ứa.', attrs: { brand: 'AutoCare Pro', vehicle_type: 'Ô tô', capacity: '4L', origin: 'Trung Quốc' }, sold: 1250, tags: ['sale'], img: { emoji: '💧', theme: 'sky', emoji2: '🪟', query: 'windshield washer fluid' } },
    { slug: 'nuoc-that-tay-chui-roi-o-to', name: 'Nước thấm tay chuôi rối ô tô', shop: 'auto-moto-pro', category: 'cham-soc-xe', price: 75000, short: 'Chất thấm tay mặt bàn, sạch bong bóng.', attrs: { brand: 'VehiclePlus', vehicle_type: 'Ô tô', capacity: '500ml', origin: 'Trung Quốc' }, sold: 620, img: { emoji: '🧴', theme: 'indigo', emoji2: '✨', query: 'steering wheel cleaner' } },
    { slug: 'mol-may-xuat-mat-truot-toan-bo-xe-may', name: 'Mỡ bạc đạn toàn bộ xe máy', shop: 'auto-moto-pro', category: 'cham-soc-xe', price: 95000, listPrice: 120000, short: 'Mỡ bạc đạn chất lượng cao, chống gỉ, bền lâu.', attrs: { brand: 'MotoDrive', vehicle_type: 'Xe máy', capacity: '250g', origin: 'Thái Lan' }, sold: 480, featured: true, tags: ['sale'], img: { emoji: '⚙️', theme: 'slate', emoji2: '🔩', query: 'bearing grease' } },
    { slug: 'chat-tay-khit-may-nho-hoa', name: 'Chất tẩy kít máy nhờ hóa', shop: 'auto-moto-pro', category: 'cham-soc-xe', price: 145000, short: 'Chất tẩy dầu kít máy, sạch sâu, an toàn.', attrs: { brand: 'AutoCare Pro', vehicle_type: 'Ô tô', capacity: '1L', origin: 'Trung Quốc' }, sold: 310, img: { emoji: '🧼', theme: 'amber', emoji2: '🔧', query: 'engine degreaser' } },
    { slug: 'xi-tang-cho-pho-o-to-lung-bac', name: 'Xi tăng chống rỉ ô tô lung bạc', shop: 'auto-moto-pro', category: 'cham-soc-xe', price: 125000, listPrice: 158000, short: 'Xi tăng bạc chống rỉ, bảo vệ dai máy, phanh.', attrs: { brand: 'GearPro', vehicle_type: 'Ô tô', capacity: '500ml', origin: 'Trung Quốc' }, sold: 420, tags: ['sale'], img: { emoji: '🪛', theme: 'teal', emoji2: '✨', query: 'anti-rust spray' } },
    { slug: 'goi-sua-son-oto-toan-the', name: 'Gói sửa sơn ô tô toàn thể', shop: 'auto-moto-pro', category: 'cham-soc-xe', price: 185000, short: 'Dụng cụ sửa sơn ô tô, công nghệ mới, hiệu quả cao.', attrs: { brand: 'RoadSafe', vehicle_type: 'Ô tô', capacity: '1 bộ', origin: 'Trung Quốc' }, sold: 180, isNew: true, tags: ['new'], img: { emoji: '🎨', theme: 'orange', emoji2: '🚗', query: 'car touch up paint' } },
  ],
};

export default dept;
