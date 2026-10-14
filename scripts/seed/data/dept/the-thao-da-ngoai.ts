/*
 * Ngành gốc "Thể thao & Dã ngoại" — Track D (PLAN-0017). Bắt chước khuôn `dien-thoai-phu-kien.ts` (đọc file đó trước).
 * Shops: sport-planet (chủ lực), sneaker-station (phụ cho giày/quần áo thể thao).
 */
import type { DeptSeed } from '../types';

const dept: DeptSeed = {
  slug: 'the-thao-da-ngoai',
  name: 'Thể thao & Dã ngoại',
  description: 'Dụng cụ gym, yoga, xe đạp, đồ dã ngoại cắm trại, dụng cụ thể thao ngoài trời',
  sortOrder: 450,
  icon: '⚽',
  theme: 'lime',
  attributes: [
    { code: 'brand', name: 'Thương hiệu', inputType: 'select', values: ['FitPro', 'YogaVita', 'CycleMax', 'CampStar', 'SportZen', 'VitaFlex', 'TrailBound', 'GoActive', 'PowerZone', 'NatureGear'] },
    { code: 'sport_size', name: 'Kích thước', inputType: 'select', values: ['XS', 'S', 'M', 'L', 'XL', 'XXL', '5', '7', '27'] },
    { code: 'weight_kg', name: 'Trọng lượng (kg)', inputType: 'text' },
    { code: 'material2', name: 'Chất liệu', inputType: 'select', values: ['Cao su', 'Nylon', 'Thép không gỉ', 'Polyester', 'EVA', 'Lưới thoáng khí', 'Cotton', 'PVC', 'Da PU', 'Vải canvas', 'Polycarbonate', 'Nhựa'] },
    { code: 'tent_capacity', name: 'Sức chứa', inputType: 'select', values: ['1 người', '2 người', '3 người', '4 người', '6 người'] },
  ],
  categories: [
    {
      slug: 'dung-cu-gym-yoga',
      name: 'Dụng cụ Gym & Yoga',
      description: 'Thảm yoga, tạ, dây kháng lực, bộ tập luyện toàn diện',
      sortOrder: 451,
      icon: '🧘',
      theme: 'emerald',
      attrs: [
        { code: 'color2', required: true, axis: true },
        { code: 'sport_size', axis: true },
        { code: 'brand', required: true },
        { code: 'material2' },
        { code: 'weight_kg' },
      ],
    },
    {
      slug: 'xe-dap-phu-kien',
      name: 'Xe đạp & Phụ kiện',
      description: 'Xe đạp đường, mountain bike, nón bảo hiểm, đèn, khóa',
      sortOrder: 452,
      icon: '🚲',
      theme: 'sky',
      attrs: [
        { code: 'color2', required: true, axis: true },
        { code: 'sport_size', axis: true },
        { code: 'brand', required: true },
        { code: 'material2' },
        { code: 'warranty' },
        { code: 'weight_kg' },
      ],
    },
    {
      slug: 'do-da-ngoai-cam-trai',
      name: 'Đồ dã ngoại & Cắm trại',
      description: 'Lều trại, túi ngủ, balo du lịch, chiếu cắm trại, đèn lồng',
      sortOrder: 453,
      icon: '⛺',
      theme: 'brown',
      attrs: [
        { code: 'color2', required: true, axis: true },
        { code: 'brand', required: true },
        { code: 'tent_capacity' },
        { code: 'material2' },
        { code: 'weight_kg' },
      ],
    },
    {
      slug: 'do-the-thao-ngoai-troi',
      name: 'Đồ thể thao ngoài trời',
      description: 'Bóng, vợt, dụng cụ bơi lội, kính bơi, quần áo thể thao',
      sortOrder: 454,
      icon: '🏊',
      theme: 'teal',
      attrs: [
        { code: 'color2', axis: true },
        { code: 'brand' },
        { code: 'material2' },
        { code: 'sport_size' },
        { code: 'weight_kg' },
      ],
    },
  ],
  products: [
    // ---- Gym & Yoga ----
    { slug: 'tham-yoga-premium-fitpro', name: 'Thảm yoga cao cấp FitPro 6mm', shop: 'sport-planet', category: 'dung-cu-gym-yoga', price: 285000, listPrice: 350000, short: 'Thảm yoga 6mm TPE, chống trơn, có túi đeo, khổ 183x61cm.', desc: 'Thảm yoga FitPro 6mm chất lượng cao từ TPE không mùi: bề mặt texture chống trơn, sốt dưới cản nước. Kích thước 183 x 61 x 0.6cm, vừa với mọi loại yoga, pilates. Kèm túi đeo vai tiện lợi.', attrs: { brand: 'FitPro', material2: 'EVA', weight_kg: '0.65kg' }, axes: [{ attr: 'color2', values: ['Tím', 'Xanh mint', 'Xám'] }, { attr: 'sport_size', values: ['M'] }], sold: 2100, tags: ['sale'], img: { emoji: '🧘', theme: 'emerald', emoji2: '💜', query: 'yoga mat' } },
    { slug: 'tham-yoga-basic-yogavita', name: 'Thảm yoga cơ bản YogaVita 4mm', shop: 'sport-planet', category: 'dung-cu-gym-yoga', price: 155000, short: 'Thảm yoga 4mm nhẹ, gấp gọn, phù hợp người mới.', attrs: { brand: 'YogaVita', material2: 'PVC', weight_kg: '0.48kg' }, axes: [{ attr: 'color2', values: ['Hồng', 'Xanh'] }, { attr: 'sport_size', values: ['M'] }], sold: 3400, img: { emoji: '🧘', theme: 'rose', emoji2: '🌸', query: 'beginner yoga mat' } },
    { slug: 'bo-tam-dumbbell-fitpro-20kg', name: 'Bộ tạ tay FitPro 2x10kg', shop: 'sport-planet', category: 'dung-cu-gym-yoga', price: 680000, listPrice: 820000, short: 'Cặp tạ tay 10kg cao su phủ, kỳ lên lồng uốn cong chống gây sốc.', desc: 'Bộ tạ tay FitPro 2x10kg chất lượng phòng tập: lõi thép, phủ cao su mịn chống trơn, khung uốn cong hỗ trợ cơ chỏm. Quả cân chính xác, tiếng khi đặt ít. Phù hợp với TP phòng nhỏ.', attrs: { brand: 'FitPro', material2: 'Cao su', weight_kg: '20kg' }, axes: [{ attr: 'color2', values: ['Đen', 'Đỏ'] }, { attr: 'sport_size', values: ['L'] }], sold: 780, featured: true, tags: ['sale'], img: { emoji: '🏋️', theme: 'orange', emoji2: '💪', query: 'dumbbell weights' } },
    { slug: 'bo-tam-dumbbell-powerzone-15kg', name: 'Bộ tạ tay PowerZone 2x7.5kg', shop: 'sport-planet', category: 'dung-cu-gym-yoga', price: 420000, short: 'Cặp tạa 7.5kg phủ cao su, an toàn cho nữ tập gym.', attrs: { brand: 'PowerZone', material2: 'Cao su', weight_kg: '15kg' }, axes: [{ attr: 'color2', values: ['Hồng', 'Xanh'] }, { attr: 'sport_size', values: ['M'] }], sold: 1240, img: { emoji: '🏋️', theme: 'fuchsia', emoji2: '✨', query: 'light dumbbells' } },
    { slug: 'day-khan-luc-resistance-bands', name: 'Dây kháng lực 5 mức FitPro', shop: 'sport-planet', category: 'dung-cu-gym-yoga', price: 189000, listPrice: 249000, short: '5 dây kháng lực bộ: từ nhẹ đến nặng, bag lưu trữ đi kèm.', attrs: { brand: 'FitPro', material2: 'Cao su' }, axes: [{ attr: 'color2', values: ['Đỏ', 'Xanh', 'Vàng', 'Tím'] }, { attr: 'sport_size', values: ['S', 'M', 'L'] }], sold: 1650, tags: ['sale'], img: { emoji: '💪', theme: 'coral', emoji2: '🔴', query: 'resistance bands' } },
    { slug: 'bao-cat-yoga-foam-block', name: 'Khối tựa yoga EVA lót cotton', shop: 'sport-planet', category: 'dung-cu-gym-yoga', price: 65000, short: 'Khối yoga 23x15x7.5cm, chống nén, hỗ trợ tư thế.', attrs: { brand: 'YogaVita', material2: 'EVA' }, axes: [{ attr: 'color2', values: ['Xanh', 'Tím'] }, { attr: 'sport_size', values: ['S'] }], sold: 890, img: { emoji: '🧘', theme: 'indigo', emoji2: '🟦', query: 'yoga block' } },
    { slug: 'xich-keo-pull-up-bar', name: 'Xà kéo cửa gắn tường', shop: 'sport-planet', category: 'dung-cu-gym-yoga', price: 380000, listPrice: 480000, short: 'Xà kéo thép không gỉ tải 200kg, gắn cửa hoặc tường.', desc: 'Xà kéo workout chất lượng cao: thép không gỉ 304 tải tối đa 200kg, gắn được trên khuôn cửa hoặc tường, dễ cài đặt 2 phút. Mặt tráng có hạt chống trơn.', attrs: { brand: 'PowerZone', material2: 'Thép không gỉ', weight_kg: '2.5kg' }, axes: [{ attr: 'color2', values: ['Đen', 'Bạc'] }, { attr: 'sport_size', values: ['L'] }], sold: 420, tags: ['sale'], img: { emoji: '🏋️', theme: 'slate', emoji2: '⬆️', query: 'pull up bar' } },
    { slug: 'ket-tam-tro-luu-5kg', name: 'Kettlebell thép phủ cao su 5kg', shop: 'sport-planet', category: 'dung-cu-gym-yoga', price: 210000, short: 'Tạ quả 5kg, tay cung hoàn thiện, tập tổng hợp hiệu quả.', attrs: { brand: 'FitPro', material2: 'Cao su', weight_kg: '5kg' }, axes: [{ attr: 'color2', values: ['Đen', 'Xanh'] }, { attr: 'sport_size', values: ['M'] }], sold: 560, img: { emoji: '🏋️', theme: 'navy', emoji2: '⭕', query: 'kettlebell weight' } },

    // ---- Xe đạp & Phụ kiện ----
    { slug: 'xe-dap-duong-cyclemax', name: 'Xe đạp đường CycleMax Sport 700C', shop: 'sport-planet', category: 'xe-dap-phu-kien', price: 3890000, listPrice: 4490000, short: 'Xe đạp đường nhôm khung nhẹ, 21 cấp, bánh 700C, phanh đĩa dầu.', desc: 'Xe đạp đường CycleMax chuyên dùng: khung hợp kim nhôm 56cm, 21 cấp số Shimano, bánh 700C, phanh đĩa dầu, trang bị yên da chất lượng. Thích hợp đi tour, thể dục giải trí, lên dốc ổn định.', attrs: { brand: 'CycleMax', material2: 'Hợp kim nhôm', weight_kg: '11.5kg' }, axes: [{ attr: 'color2', values: ['Đen', 'Xanh navy'] }, { attr: 'sport_size', values: ['M', 'L'] }], sold: 95, featured: true, isNew: true, tags: ['new'], img: { emoji: '🚲', theme: 'sky', emoji2: '🛣️', query: 'road bike' } },
    { slug: 'xe-dap-dua-toc-do', name: 'Xe đạp đua tốc độ TrailBound', shop: 'sneaker-station', category: 'xe-dap-phu-kien', price: 2890000, short: 'Xe đạp đua khung carbon, 16 cấp, bánh 700C, nặng 7.5kg.', attrs: { brand: 'TrailBound', material2: 'Sợi carbon', weight_kg: '7.5kg' }, axes: [{ attr: 'color2', values: ['Đen', 'Đỏ'] }, { attr: 'sport_size', values: ['M'] }], sold: 65, isNew: true, tags: ['new'], img: { emoji: '🚴', theme: 'coral', emoji2: '⚡', query: 'racing bike' } },
    { slug: 'non-bao-hiem-cyclemax-full', name: 'Nón bảo hiểm CycleMax Full Face', shop: 'sport-planet', category: 'xe-dap-phu-kien', price: 580000, listPrice: 699000, short: 'Nón bảo hiểm full-face chứng nhận CE, lỗi thoáng khí, dây gài nhanh.', attrs: { brand: 'CycleMax', material2: 'Polycarbonate', weight_kg: '0.45kg' }, axes: [{ attr: 'color2', values: ['Đen', 'Trắng', 'Xanh'] }, { attr: 'sport_size', values: ['M', 'L'] }], sold: 380, tags: ['sale'], img: { emoji: '🚲', theme: 'slate', emoji2: '🛡️', query: 'bike helmet' } },
    { slug: 'non-bao-hiem-sportzen-half', name: 'Nón bảo hiểm half-shell SportZen', shop: 'sport-planet', category: 'xe-dap-phu-kien', price: 320000, short: 'Nón bảo hiểm nửa mặt, 11 lỗ thoáng khí, hạng nhẹ 180g.', attrs: { brand: 'SportZen', material2: 'Nhựa', weight_kg: '0.18kg' }, axes: [{ attr: 'color2', values: ['Hồng', 'Xám'] }, { attr: 'sport_size', values: ['S', 'M'] }], sold: 650, img: { emoji: '🚲', theme: 'rose', emoji2: '⭕', query: 'cycle helmet' } },
    { slug: 'den-led-xe-dap-phia-truoc', name: 'Đèn LED trước xe đạp 1200 lumen', shop: 'sport-planet', category: 'xe-dap-phu-kien', price: 250000, listPrice: 330000, short: 'Đèn pha LED 1200 lm, sạc USB, 8 chế độ nháy.', attrs: { brand: 'GoActive', material2: 'Nhựa' }, axes: [{ attr: 'color2', values: ['Đen', 'Trắng'] }, { attr: 'sport_size', values: ['M'] }], sold: 1120, featured: true, tags: ['sale'], img: { emoji: '🔦', theme: 'amber', emoji2: '💡', query: 'bike light' } },
    { slug: 'khoa-xe-dap-chinh-khong-can', name: 'Khóa xe đạp chính khóa không gian', shop: 'sport-planet', category: 'xe-dap-phu-kien', price: 340000, short: 'Khóa U thép không gỉ, chống cắt 5 phút, thiết kế compact.', attrs: { brand: 'CycleMax', material2: 'Thép không gỉ', weight_kg: '0.8kg' }, axes: [{ attr: 'color2', values: ['Đen'] }, { attr: 'sport_size', values: ['M'] }], sold: 780, img: { emoji: '🔒', theme: 'navy', emoji2: '🚲', query: 'bike lock' } },
    { slug: 'tay-nan-xe-dap-ergonomic', name: 'Tay nắm xe đạp ergonomic phủ gel', shop: 'sport-planet', category: 'xe-dap-phu-kien', price: 125000, short: 'Cặp tay nắm gel 130mm, chống trơn, êm tay sau 2 giờ lăn bánh.', attrs: { brand: 'GoActive', material2: 'Silicone', weight_kg: '0.15kg' }, axes: [{ attr: 'color2', values: ['Đen', 'Xanh'] }, { attr: 'sport_size', values: ['M'] }], sold: 1890, img: { emoji: '🚲', theme: 'teal', emoji2: '✋', query: 'handlebar grips' } },

    // ---- Dã ngoại & Cắm trại ----
    { slug: 'leu-cam-trai-campstar-2-nguoi', name: 'Lều cắm trại CampStar 2 người', shop: 'sport-planet', category: 'do-da-ngoai-cam-trai', price: 1250000, listPrice: 1490000, short: 'Lều bạt nylon chống nước, 2 cửa, lối thông hơi.', desc: 'Lều CampStar 2 người: vải nylon polyester chống nước 3000mm, sàn PVC dày 2mm, thiết kế dome ổn định gió. Dụng cụ thiết lập dễ, kèm túi đựng nylon. Kích thước 200x120x130cm.', attrs: { brand: 'CampStar', material2: 'Nylon', weight_kg: '2.1kg', tent_capacity: '2 người' }, axes: [{ attr: 'color2', values: ['Xanh lá', 'Xám'] }], sold: 340, featured: true, tags: ['sale'], img: { emoji: '⛺', theme: 'brown', emoji2: '🌲', query: 'camping tent' } },
    { slug: 'leu-cam-trai-naturegeaf-4-nguoi', name: 'Lều cắm trại NatureGear 4 người', shop: 'sport-planet', category: 'do-da-ngoai-cam-trai', price: 2150000, short: 'Lều 4 người 2 lớp, lồng muỗi tách riêng, thoáng khí tốt.', attrs: { brand: 'NatureGear', material2: 'Polyester', weight_kg: '3.8kg', tent_capacity: '4 người' }, axes: [{ attr: 'color2', values: ['Xanh navy', 'Xám'] }], sold: 180, isNew: true, tags: ['new'], img: { emoji: '⛺', theme: 'navy', emoji2: '🛌', query: '4 person tent' } },
    { slug: 'tui-ngu-mua-dong-campstar', name: 'Túi ngủ mùa đông CampStar -10C', shop: 'sport-planet', category: 'do-da-ngoai-cam-trai', price: 890000, listPrice: 1090000, short: 'Túi ngủ ấm -10°C, chợp polyester, hạn chế mất nhiệt.', desc: 'Túi ngủ cắm trại mùa đông CampStar: chợp ngoài polyester 300g/m², lót lông mỏng, cốp phủ hơi ấm hiệu quả. Nhiệt độ thoải mái -10°C, cân nặng 1.4kg, gấp gọn với túi đựng.', attrs: { brand: 'CampStar', material2: 'Polyester', weight_kg: '1.4kg', tent_capacity: '1 người' }, axes: [{ attr: 'color2', values: ['Đen', 'Xanh'] }], sold: 520, tags: ['sale'], img: { emoji: '🛌', theme: 'slate', emoji2: '❄️', query: 'sleeping bag' } },
    { slug: 'tui-ngu-mua-he-vitaflex', name: 'Túi ngủ mùa hè VitaFlex 15C', shop: 'sport-planet', category: 'do-da-ngoai-cam-trai', price: 480000, short: 'Túi ngủ thời tiết ấm 15°C, nhẹ 0.8kg, lót nôi đo.', attrs: { brand: 'VitaFlex', material2: 'Polyester', weight_kg: '0.8kg', tent_capacity: '1 người' }, axes: [{ attr: 'color2', values: ['Xanh mint', 'Hồng'] }], sold: 890, img: { emoji: '🛌', theme: 'mint', emoji2: '🌅', query: 'summer sleeping bag' } },
    { slug: 'balo-du-lich-trailbound-50l', name: 'Balo du lịch TrailBound 50L chống nước', shop: 'sport-planet', category: 'do-da-ngoai-cam-trai', price: 980000, listPrice: 1280000, short: 'Balo 50L nylon 600D, chống nước, chia ngăn thông minh, hỗ trợ lưng thoáng khí.', attrs: { brand: 'TrailBound', material2: 'Nylon', weight_kg: '0.75kg', tent_capacity: '1 người' }, axes: [{ attr: 'color2', values: ['Xanh navy', 'Đen'] }], sold: 650, tags: ['sale'], img: { emoji: '🎒', theme: 'orange', emoji2: '🏔️', query: 'hiking backpack' } },
    { slug: 'chieu-cam-trai-eva-chong-nuoc', name: 'Chiếu EVA chống nước cắm trại 2m', shop: 'sport-planet', category: 'do-da-ngoai-cam-trai', price: 220000, short: 'Chiếu EVA màu kẻ, chống nước, nhẹ, gấp gọn với dây buộc.', attrs: { brand: 'GoActive', material2: 'EVA', weight_kg: '0.5kg', tent_capacity: '2 người' }, axes: [{ attr: 'color2', values: ['Xanh', 'Xám'] }], sold: 1230, img: { emoji: '🏕️', theme: 'emerald', emoji2: '☀️', query: 'camping mat' } },
    { slug: 'den-long-led-nam-trai', name: 'Đèn lồng LED nạp pin gắn lều', shop: 'sport-planet', category: 'do-da-ngoai-cam-trai', price: 180000, listPrice: 240000, short: 'Đèn LED 200 lm, sạc USB, 4 chế độ sáng, gắn cung lều.', attrs: { brand: 'GoActive', material2: 'Nhựa', weight_kg: '0.25kg', tent_capacity: '1 người' }, axes: [{ attr: 'color2', values: ['Đen', 'Xanh'] }], sold: 1650, featured: true, tags: ['sale'], img: { emoji: '🔦', theme: 'amber', emoji2: '🌙', query: 'camping lantern' } },

    // ---- Đồ thể thao ngoài trời ----
    { slug: 'bong-da-premium-sportzen', name: 'Bóng đá chuyên nghiệp SportZen', shop: 'sport-planet', category: 'do-the-thao-ngoai-troi', price: 380000, listPrice: 480000, short: 'Bóng đá số 5, da PU, duyên kỹ, khớp tỷ lệ chuẩn FIFA.', desc: 'Bóng đá SportZen kích thước chính thức số 5: vỏ da PU tổng hợp chất lượng, khớp loại 6 miếng sao bảo đảm tròn, cơm trong lạc tinh, được dùng đặc biệt từ giải trẻ đến chuyên nghiệp.', attrs: { brand: 'SportZen', material2: 'Da PU', sport_size: '5' }, axes: [{ attr: 'color2', values: ['Trắng', 'Xanh'] }], sold: 280, featured: true, tags: ['sale'], img: { emoji: '⚽', theme: 'navy', emoji2: '🏟️', query: 'soccer ball' } },
    { slug: 'bong-ro-basketball-fitpro', name: 'Bóng rổ FitPro Indoor 7', shop: 'sport-planet', category: 'do-the-thao-ngoai-troi', price: 290000, short: 'Bóng rổ số 7, bề mặt cao su tổng hợp, bơm kèm.', attrs: { brand: 'FitPro', material2: 'Cao su', sport_size: '7' }, axes: [{ attr: 'color2', values: ['Cam', 'Xanh'] }], sold: 420, img: { emoji: '🏀', theme: 'orange', emoji2: '🏀', query: 'basketball' } },
    { slug: 'vot-cau-long-carbom-lite', name: 'Vợt cầu lông carbon lite CycleMax', shop: 'sport-planet', category: 'do-the-thao-ngoai-troi', price: 420000, listPrice: 550000, short: 'Vợt cầu lông sợi carbon, khung nhẹ 79g, gồm giây căng.', attrs: { brand: 'CycleMax', material2: 'Sợi carbon', sport_size: 'L' }, axes: [{ attr: 'color2', values: ['Đen', 'Đỏ'] }], sold: 310, tags: ['sale'], img: { emoji: '🏸', theme: 'coral', emoji2: '⚡', query: 'badminton racket' } },
    { slug: 'vot-tennis-aluminum-sportzen', name: 'Vợt tennis nhôm SportZen 27"', shop: 'sneaker-station', category: 'do-the-thao-ngoai-troi', price: 380000, short: 'Vợt tennis khung nhôm chắc, dây căng, thích hợp người mới.', attrs: { brand: 'SportZen', material2: 'Hợp kim nhôm', weight_kg: '0.27kg', sport_size: '27' }, axes: [{ attr: 'color2', values: ['Đen', 'Xanh'] }], sold: 180, img: { emoji: '🎾', theme: 'sky', emoji2: '🏆', query: 'tennis racket' } },
    { slug: 'kinh-boi-uv-naturgear', name: 'Kính bơi chống UV NatureGear', shop: 'sport-planet', category: 'do-the-thao-ngoai-troi', price: 195000, short: 'Kính bơi chống UV, mũi êm, nước không thấm, hạn chế sương mù.', attrs: { brand: 'NatureGear', material2: 'Polycarbonate', sport_size: 'M' }, axes: [{ attr: 'color2', values: ['Xanh', 'Hồng'] }], sold: 780, img: { emoji: '🏊', theme: 'teal', emoji2: '💧', query: 'swimming goggles' } },
    { slug: 'vay-boi-tam-one-piece-vitaflex', name: 'Bộ đồ bơi nữ VitaFlex kiểu one-piece', shop: 'sneaker-station', category: 'do-the-thao-ngoai-troi', price: 280000, listPrice: 380000, short: 'Áo tắm nữ vải mạnh, khoe dáng, UV protection.', attrs: { brand: 'VitaFlex', material2: 'Polyester' }, axes: [{ attr: 'color2', values: ['Xanh', 'Hồng'] }], sold: 420, tags: ['sale'], img: { emoji: '👙', theme: 'rose', emoji2: '🏖️', query: 'swimwear women' } },
    { slug: 'vay-shorts-the-thao-nam-goactive', name: 'Quần short thể thao nam GoActive', shop: 'sneaker-station', category: 'do-the-thao-ngoai-troi', price: 165000, short: 'Quần short lưới thoáng khí, túi dây chuyên dùng chạy bộ.', attrs: { brand: 'GoActive', material2: 'Lưới thoáng khí', sport_size: 'M' }, axes: [{ attr: 'color2', values: ['Đen', 'Xám'] }], sold: 650, img: { emoji: '👖', theme: 'slate', emoji2: '🏃', query: 'athletic shorts' } },
    { slug: 'ao-the-thao-nam-fitpro-dry', name: 'Áo thể thao nam FitPro Quick-Dry', shop: 'sneaker-station', category: 'do-the-thao-ngoai-troi', price: 210000, listPrice: 290000, short: 'Áo thể thao nam khô nhanh, thoáng khí cao cấp.', attrs: { brand: 'FitPro', material2: 'Polyester', sport_size: 'M' }, axes: [{ attr: 'color2', values: ['Đen', 'Xám', 'Xanh'] }], sold: 890, featured: true, tags: ['sale'], img: { emoji: '👕', theme: 'slate', emoji2: '💨', query: 'mens sports shirt' } },
  ],
};

export default dept;
