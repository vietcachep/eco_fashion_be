/*
 * Ngành gốc "Giày dép & Túi xách" — Track D (PLAN-0017). Bắt chước khuôn `dien-thoai-phu-kien.ts` (đọc file đó trước).
 * 4 ngành lá: giay-the-thao, sandal-dep, tui-xach, balo-vali
 * Shops: sneaker-station (shoes, sandals), bag-and-co (bags, backpacks, luggage)
 * Tổng ≥34 sản phẩm, mỗi lá ≥6 sản phẩm, mỗi shop ≥5 sản phẩm
 */
import type { DeptSeed } from '../types';

const dept: DeptSeed = {
  slug: 'giay-dep-tui-xach',
  name: 'Giày dép & Túi xách',
  description: 'Giày thể thao, sandal, túi xách, balo, vali',
  sortOrder: 350,
  icon: '👟',
  theme: 'navy',
  attributes: [
    { code: 'brand', name: 'Thương hiệu', inputType: 'select', values: ['SOLESTRIDE', 'VELOCE', 'CLOUDFOOT', 'SPEEDMARK', 'STRIDE PRO', 'APEX', 'KICKZONE', 'NOVA STEPS', 'LUMINOS', 'CARRYCLASS', 'BAGTICA', 'URBANTOTE', 'LUXEPACKS', 'VOYAGEJOY', 'SATCHEL PRO'] },
    { code: 'shoe_size', name: 'Kích cỡ giày', inputType: 'select', values: ['36', '37', '38', '39', '40', '41', '42', '43', '44', '45'] },
    { code: 'bag_size', name: 'Dung tích/kích cỡ', inputType: 'select', values: ['Nhỏ (≤20L)', 'Vừa (20-30L)', 'Lớn (30-40L)', '20 inch', '24 inch', '28 inch'] },
    { code: 'strap_material', name: 'Chất liệu quai', inputType: 'select', values: ['Dây vải cotton', 'Dây da PU', 'Dây da thật', 'Dây nylon', 'Dây polyester'] },
    { code: 'material2', name: 'Chất liệu', inputType: 'select', values: ['Nhựa', 'Kim loại', 'Inox 304', 'Thép không gỉ', 'Gỗ tự nhiên', 'Gỗ công nghiệp', 'Da PU', 'Da thật', 'Vải canvas', 'Vải cotton', 'Thủy tinh', 'Gốm sứ', 'Silicone', 'Nylon', 'Polyester', 'Lưới thoáng khí', 'Sợi carbon', 'Hợp kim nhôm', 'Cao su', 'Tre', 'Mây tre đan', 'ABS + PC', 'PC + ABS', 'PC', 'EVA'] },
  ],
  categories: [
    {
      slug: 'giay-the-thao',
      name: 'Giày thể thao',
      description: 'Sneaker, giày chạy, giày tập luyện các phong cách',
      sortOrder: 351,
      icon: '👟',
      theme: 'indigo',
      attrs: [
        { code: 'color2', required: true, axis: true },
        { code: 'shoe_size', required: true, axis: true },
        { code: 'brand', required: true },
        { code: 'material2' },
        { code: 'origin' },
        { code: 'warranty' },
      ],
    },
    {
      slug: 'sandal-dep',
      name: 'Sandal & Dép',
      description: 'Sandal, dép quai ngang, dép lê thoải mái',
      sortOrder: 352,
      icon: '🩴',
      theme: 'coral',
      attrs: [
        { code: 'color2', required: true, axis: true },
        { code: 'shoe_size', required: true, axis: true },
        { code: 'brand', required: true },
        { code: 'material2' },
        { code: 'origin' },
      ],
    },
    {
      slug: 'tui-xach',
      name: 'Túi xách',
      description: 'Túi xách nữ, túi tote, túi đeo chéo, túi clutch',
      sortOrder: 353,
      icon: '👜',
      theme: 'fuchsia',
      attrs: [
        { code: 'color2', required: true, axis: true },
        { code: 'brand', required: true },
        { code: 'bag_size' },
        { code: 'strap_material' },
        { code: 'material2' },
        { code: 'origin' },
      ],
    },
    {
      slug: 'balo-vali',
      name: 'Balo & Vali',
      description: 'Balo học tập, balo du lịch, vali du lịch, vali kéo',
      sortOrder: 354,
      icon: '🎒',
      theme: 'emerald',
      attrs: [
        { code: 'color2', required: true, axis: true },
        { code: 'brand', required: true },
        { code: 'bag_size' },
        { code: 'material2' },
        { code: 'origin' },
        { code: 'warranty' },
      ],
    },
  ],
  products: [
    // ---- GIÀY THỂ THAO (9 sản phẩm, shop: sneaker-station) ----
    { slug: 'giay-the-thao-solestride-runner', name: 'Giày thể thao SOLESTRIDE Runner', shop: 'sneaker-station', category: 'giay-the-thao', price: 1290000, listPrice: 1490000, short: 'Giày chạy nhẹ, đệm khí 360, thoáng khí tốt, phù hợp chạy bộ hàng ngày.', desc: 'SOLESTRIDE Runner kết hợp công nghệ đệm khí 360° và vải lưới thoáng khí giúp chân luôn mát mẻ. Trọng lượng nhẹ chỉ 210g/đôi, phù hợp cho những bước chạy dài. Đế cao su chống trơn trượt, bền đến 700km. Kèm bảo hành đường may 12 tháng.', attrs: { brand: 'SOLESTRIDE', material2: 'Lưới thoáng khí', origin: 'Việt Nam', warranty: 'Bảo hành 12 tháng' }, axes: [{ attr: 'color2', values: ['Đen', 'Trắng', 'Xanh'] }, { attr: 'shoe_size', values: ['39', '40', '41', '42', '43'] }], sold: 540, featured: true, tags: ['sale'], img: { emoji: '👟', theme: 'indigo', emoji2: '⚡', query: 'running shoes' } },
    { slug: 'giay-sneaker-veloce-classic', name: 'Giày Sneaker VELOCE Classic', shop: 'sneaker-station', category: 'giay-the-thao', price: 850000, listPrice: 999000, short: 'Sneaker cổ điển, thiết kế retro, dễ phối đồ, không bao giờ lỗi thời.', desc: 'VELOCE Classic mang lại phong cách retro 90s với đôi giày sneaker đơn giản nhưng thanh lịch. Canvas cao cấp, lót nhỏ mút êm ái. Áp dụng kỹ thuật khâu vòng cung để tăng độ bền. Bán chạy nhất của hãng.', attrs: { brand: 'VELOCE', material2: 'Vải canvas', origin: 'Trung Quốc', warranty: 'Bảo hành 6 tháng' }, axes: [{ attr: 'color2', values: ['Đen', 'Trắng', 'Xanh navy'] }, { attr: 'shoe_size', values: ['38', '39', '40', '41', '42', '43', '44'] }], sold: 1280, tags: ['sale'], img: { emoji: '👟', theme: 'slate', emoji2: '✨', query: 'canvas sneaker' } },
    { slug: 'giay-cloudfoot-pro-comfort', name: 'Giày CLOUDFOOT Pro Comfort', shop: 'sneaker-station', category: 'giay-the-thao', price: 1650000, short: 'Đệm mây, thoải mái từng bước, phù hợp đi làm cả ngày.', attrs: { brand: 'CLOUDFOOT', material2: 'Da PU', origin: 'Trung Quốc', warranty: 'Bảo hành 12 tháng' }, axes: [{ attr: 'color2', values: ['Đen', 'Xám'] }, { attr: 'shoe_size', values: ['40', '41', '42', '43'] }], sold: 310, isNew: true, tags: ['new'], img: { emoji: '👟', theme: 'sky', emoji2: '☁️', query: 'comfort shoes' } },
    { slug: 'giay-tap-gym-speedmark', name: 'Giày tập gym SPEEDMARK', shop: 'sneaker-station', category: 'giay-the-thao', price: 750000, short: 'Giày tập lực, đế cứng ổn định, hỗ trợ các động tác nâng tạ.', desc: 'SPEEDMARK được thiết kế riêng cho tập gym với đế cứng giúp cân bằng. Quai hỗ trợ cổ chân, đệm gót tăng cường. Khóa ren chặt chẽ, không bị tuột giày khi tập nặng.', attrs: { brand: 'SPEEDMARK', material2: 'Da PU', origin: 'Việt Nam', warranty: 'Bảo hành 6 tháng' }, axes: [{ attr: 'color2', values: ['Đen', 'Xám'] }, { attr: 'shoe_size', values: ['39', '40', '41', '42', '43'] }], sold: 680, img: { emoji: '👟', theme: 'rose', emoji2: '🏋️', query: 'gym shoes' } },
    { slug: 'giay-chay-tren-dia-form-stride', name: 'Giày chạy địa hình STRIDE PRO', shop: 'sneaker-station', category: 'giay-the-thao', price: 1890000, short: 'Địa hình trail, bám sỏi tốt, chống trơn, bền cho leo núi.', desc: 'STRIDE PRO Trail được thiết kế cho những người chạy bộ trên các con đường núi đá. Đế bám tốt với lỗ thoát nước, khung chân cứng chống xoắn. Màng chống nước, vải bền chịu được cây cỏ. Bảo hành 24 tháng cho phần khâu.', attrs: { brand: 'STRIDE PRO', material2: 'Nylon', origin: 'Hàn Quốc', warranty: 'Bảo hành 24 tháng' }, axes: [{ attr: 'color2', values: ['Đen', 'Xanh lá'] }, { attr: 'shoe_size', values: ['38', '39', '40', '41', '42'] }], sold: 220, featured: true, img: { emoji: '👟', theme: 'lime', emoji2: '🏔️', query: 'trail running shoes' } },
    { slug: 'giay-apex-basketball', name: 'Giày bóng rổ APEX', shop: 'sneaker-station', category: 'giay-the-thao', price: 1450000, short: 'Giày bóng rổ cao cổ, dỡ ngoặt tốt, hỗ trợ cầu thang động.', attrs: { brand: 'APEX', material2: 'Da PU', origin: 'Trung Quốc', warranty: 'Bảo hành 12 tháng' }, axes: [{ attr: 'color2', values: ['Đen', 'Trắng', 'Đỏ'] }, { attr: 'shoe_size', values: ['40', '41', '42', '43', '44'] }], sold: 420, img: { emoji: '👟', theme: 'coral', emoji2: '🏀', query: 'basketball shoes' } },
    { slug: 'giay-nova-steps-walking', name: 'Giày đi bộ NOVA STEPS', shop: 'sneaker-station', category: 'giay-the-thao', price: 920000, listPrice: 1080000, short: 'Giày bình thường, đế thường, thoải mái cho đi lại cả ngày.', attrs: { brand: 'NOVA STEPS', material2: 'Vải cotton', origin: 'Việt Nam' }, axes: [{ attr: 'color2', values: ['Đen', 'Xám', 'Nâu'] }, { attr: 'shoe_size', values: ['37', '38', '39', '40', '41', '42'] }], sold: 950, tags: ['sale'], img: { emoji: '👟', theme: 'brown', emoji2: '🚶', query: 'walking shoes' } },
    { slug: 'giay-kickzone-futsal', name: 'Giày Futsal KICKZONE Pro', shop: 'sneaker-station', category: 'giay-the-thao', price: 1150000, short: 'Giày bóng đá futsal, đế chỉnh xác, bám sàn nhà ngon.', attrs: { brand: 'KICKZONE', material2: 'Da PU', origin: 'Trung Quốc', warranty: 'Bảo hành 6 tháng' }, axes: [{ attr: 'color2', values: ['Đen', 'Trắng'] }, { attr: 'shoe_size', values: ['39', '40', '41', '42', '43'] }], sold: 310, img: { emoji: '👟', theme: 'violet', emoji2: '⚽', query: 'futsal shoes' } },
    { slug: 'giay-cloudfoot-air-max', name: 'Giày CLOUDFOOT Air Max', shop: 'sneaker-station', category: 'giay-the-thao', price: 2150000, short: 'Công nghệ khí lớn, cushioning tối đa, thoại mái nhất của dòng.', attrs: { brand: 'CLOUDFOOT', material2: 'Da PU', origin: 'Trung Quốc', warranty: 'Bảo hành 12 tháng' }, axes: [{ attr: 'color2', values: ['Trắng', 'Xám'] }, { attr: 'shoe_size', values: ['40', '41', '42', '43'] }], sold: 180, isNew: true, tags: ['new'], img: { emoji: '👟', theme: 'mint', emoji2: '💨', query: 'air max shoes' } },

    // ---- SANDAL & DÉP (9 sản phẩm, shop: sneaker-station) ----
    { slug: 'sandal-da-nam-veloce', name: 'Sandal da nam VELOCE', shop: 'sneaker-station', category: 'sandal-dep', price: 380000, listPrice: 450000, short: 'Sandal da thật quai kép, thoáng khí, bền bỏ, phong cách casual.', desc: 'Sandal VELOCE làm từ da thật được xử lý kỹ lưỡng, quai kép chắc chắn. Lót nội thất êm mềm, đế cao su chống trơn. Mùi thơm da tự nhiên, bền mặc 2-3 năm.', attrs: { brand: 'VELOCE', material2: 'Da thật', origin: 'Việt Nam' }, axes: [{ attr: 'color2', values: ['Nâu', 'Đen'] }, { attr: 'shoe_size', values: ['38', '39', '40', '41', '42', '43'] }], sold: 840, tags: ['sale'], img: { emoji: '🩴', theme: 'brown', emoji2: '👨', query: 'mens sandals' } },
    { slug: 'dep-quai-ngang-cloudfoot', name: 'Dép quai ngang CLOUDFOOT', shop: 'sneaker-station', category: 'sandal-dep', price: 199000, short: 'Dép quai mềm, nhanh khô, giá rẻ, lý tưởng cho hè.', attrs: { brand: 'CLOUDFOOT', material2: 'Silicone', origin: 'Trung Quốc' }, axes: [{ attr: 'color2', values: ['Đen', 'Xám', 'Xanh', 'Hồng'] }, { attr: 'shoe_size', values: ['36', '37', '38', '39', '40', '41'] }], sold: 2100, img: { emoji: '🩴', theme: 'sky', emoji2: '💧', query: 'flip flops' } },
    { slug: 'sandal-nu-speedmark-fashion', name: 'Sandal nữ SPEEDMARK Fashion', shop: 'sneaker-station', category: 'sandal-dep', price: 450000, short: 'Sandal nữ thời trang, gót 5cm, mềm và thanh lịch.', attrs: { brand: 'SPEEDMARK', material2: 'Da PU', origin: 'Việt Nam' }, axes: [{ attr: 'color2', values: ['Đen', 'Trắng', 'Hồng', 'Xám'] }, { attr: 'shoe_size', values: ['36', '37', '38', '39'] }], sold: 620, isNew: true, tags: ['new'], img: { emoji: '🩴', theme: 'rose', emoji2: '👠', query: 'womens sandals' } },
    { slug: 'dep-the-thao-apex-unisex', name: 'Dép thể thao APEX Unisex', shop: 'sneaker-station', category: 'sandal-dep', price: 220000, short: 'Dép thể thao, đệm êm, kiểu dáng unisex, đi nhà hay đi chơi đều okee.', attrs: { brand: 'APEX', material2: 'EVA', origin: 'Trung Quốc' }, axes: [{ attr: 'color2', values: ['Đen', 'Xám', 'Xanh'] }, { attr: 'shoe_size', values: ['36', '37', '38', '39', '40', '41', '42'] }], sold: 1650, img: { emoji: '🩴', theme: 'slate', emoji2: '🏃', query: 'sport sandals' } },
    { slug: 'sandal-da-nu-sieu-mem', name: 'Sandal da nữ siêu mềm STRIDE PRO', shop: 'sneaker-station', category: 'sandal-dep', price: 520000, listPrice: 620000, short: 'Quai da mềm, đế massage phấn khoáng, thích hợp đi lâu không mỏi.', desc: 'STRIDE PRO Sandal với đế massage từ phấn khoáng giúp xoa bóp chân. Quai da ngoài cùng được xử lý mềm mại. Đế PU chống trơn. Phù hợp cho phụ nữ thường xuyên phải đứng hoặc đi bộ.', attrs: { brand: 'STRIDE PRO', material2: 'Da PU', origin: 'Hàn Quốc' }, axes: [{ attr: 'color2', values: ['Đen', 'Trắng', 'Xám'] }, { attr: 'shoe_size', values: ['36', '37', '38', '39', '40'] }], sold: 390, featured: true, tags: ['sale'], img: { emoji: '🩴', theme: 'mint', emoji2: '🧘', query: 'massage sandals' } },
    { slug: 'dep-quai-cheo-kickzone', name: 'Dép quai chéo KICKZONE', shop: 'sneaker-station', category: 'sandal-dep', price: 280000, short: 'Dép quai chéo thời trang, chất liệu PU bền, thiết kế tạo cảm giác ôm chân.', attrs: { brand: 'KICKZONE', material2: 'Da PU', origin: 'Việt Nam' }, axes: [{ attr: 'color2', values: ['Đen', 'Trắng', 'Bạc'] }, { attr: 'shoe_size', values: ['36', '37', '38', '39', '40', '41'] }], sold: 720, img: { emoji: '🩴', theme: 'fuchsia', emoji2: '✨', query: 'strappy sandals' } },
    { slug: 'dep-tre-con-nova-steps', name: 'Dép trẻ em NOVA STEPS', shop: 'sneaker-station', category: 'sandal-dep', price: 150000, short: 'Dép trẻ em, quai ngang an toàn, chống trơn tốt.', attrs: { brand: 'NOVA STEPS', material2: 'Silicone', origin: 'Việt Nam' }, axes: [{ attr: 'color2', values: ['Xanh', 'Hồng', 'Vàng'] }, { attr: 'shoe_size', values: ['36', '37', '38', '39'] }], sold: 1100, img: { emoji: '🩴', theme: 'coral', emoji2: '👶', query: 'kids sandals' } },
    { slug: 'sandal-theo-da-bit-got', name: 'Sandal thể thao bít gót LUMINOS', shop: 'sneaker-station', category: 'sandal-dep', price: 380000, short: 'Sandal bít gót, bảo vệ chân tốt, phù hợp leo núi nhẹ.', attrs: { brand: 'LUMINOS', material2: 'Da PU', origin: 'Trung Quốc' }, axes: [{ attr: 'color2', values: ['Đen', 'Xanh lá'] }, { attr: 'shoe_size', values: ['37', '38', '39', '40', '41', '42'] }], sold: 280, img: { emoji: '🩴', theme: 'emerald', emoji2: '🏔️', query: 'hiking sandals' } },
    { slug: 'dep-nhem-orthopedic-cloudfoot', name: 'Dép nhúm orthopedic CLOUDFOOT', shop: 'sneaker-station', category: 'sandal-dep', price: 590000, short: 'Dép y tế, tốt cho sức khỏe chân, khuyên bác sĩ sử dụng.', attrs: { brand: 'CLOUDFOOT', material2: 'Silicone', origin: 'Trung Quốc' }, axes: [{ attr: 'color2', values: ['Đen', 'Trắng'] }, { attr: 'shoe_size', values: ['36', '37', '38', '39', '40', '41'] }], sold: 420, img: { emoji: '🩴', theme: 'indigo', emoji2: '⚕️', query: 'orthopedic sandals' } },

    // ---- TÚI XÁCH (9 sản phẩm, shop: bag-and-co) ----
    { slug: 'tui-xach-tote-luminos', name: 'Túi xách Tote LUMINOS', shop: 'bag-and-co', category: 'tui-xach', price: 420000, listPrice: 520000, short: 'Túi tote đơn giản, dung tích 15L, quai ngắn, phù hợp đi chợ hay công sở.', desc: 'LUMINOS Tote được làm từ canvas cotton độ dày 10oz, có khóa từ an toàn. Lót bên trong là vải polyester chắc chắn. Kích thước 38x30x12cm, chứa được laptop 13 inch. Bảo hành đường may 12 tháng.', attrs: { brand: 'LUMINOS', bag_size: 'Vừa (20-30L)', strap_material: 'Dây vải cotton', material2: 'Vải canvas', origin: 'Việt Nam' }, axes: [{ attr: 'color2', values: ['Đen', 'Be', 'Xám'] }], sold: 680, featured: true, tags: ['sale'], img: { emoji: '👜', theme: 'sand', emoji2: '🛍️', query: 'tote bag' } },
    { slug: 'tui-xach-da-pu-carryclass', name: 'Túi xách da PU CARRYCLASS', shop: 'bag-and-co', category: 'tui-xach', price: 520000, short: 'Túi xách da PU, thiết kế cổ điển, gam màu sang trọng, phù hợp công sở.', desc: 'CARRYCLASS Bag làm từ da PU cao cấp, có hoa văn ô vuông nổi bật. Có khóa kim loại vàng, 2 ngăn bên trong chi tiết. Quai xách tay bọc da, được lót bên trong. Kích thước L30xW12xH23cm. Bảo hành khâu đường 12 tháng.', attrs: { brand: 'CARRYCLASS', bag_size: 'Vừa (20-30L)', strap_material: 'Dây da PU', material2: 'Da PU', origin: 'Trung Quốc' }, axes: [{ attr: 'color2', values: ['Đen', 'Nâu'] }], sold: 420, isNew: true, tags: ['new'], img: { emoji: '👜', theme: 'brown', emoji2: '✨', query: 'leather handbag' } },
    { slug: 'tui-deo-cheo-nu-bagtica', name: 'Túi đeo chéo nữ BAGTICA', shop: 'bag-and-co', category: 'tui-xach', price: 380000, listPrice: 450000, short: 'Túi đeo chéo, quai dây dắt, vừa cổ điển vừa hiện đại, hot trend hè 2026.', attrs: { brand: 'BAGTICA', bag_size: 'Nhỏ (≤20L)', strap_material: 'Dây nylon', material2: 'Polyester', origin: 'Việt Nam' }, axes: [{ attr: 'color2', values: ['Đen', 'Xám', 'Hồng'] }], sold: 940, tags: ['sale'], img: { emoji: '👜', theme: 'rose', emoji2: '💕', query: 'crossbody bag' } },
    { slug: 'tui-clutch-nho-gon-urbantote', name: 'Túi Clutch nhỏ gọn URBANTOTE', shop: 'bag-and-co', category: 'tui-xach', price: 290000, short: 'Clutch nhỏ, dễ mang theo, phù hợp dự tiệc hay đi chơi tối.', attrs: { brand: 'URBANTOTE', bag_size: 'Nhỏ (≤20L)', strap_material: 'Dây da PU', material2: 'Da PU', origin: 'Việt Nam' }, axes: [{ attr: 'color2', values: ['Đen', 'Trắng', 'Xám'] }], sold: 620, img: { emoji: '👜', theme: 'slate', emoji2: '✨', query: 'clutch bag' } },
    { slug: 'tui-xach-hop-cao-luxepacks', name: 'Túi xách hộp cao LUXEPACKS', shop: 'bag-and-co', category: 'tui-xach', price: 680000, short: 'Túi xách dáng hộp cao cấp, lót trong tuyệt đẹp, style quý phái.', attrs: { brand: 'LUXEPACKS', bag_size: 'Vừa (20-30L)', strap_material: 'Dây da thật', material2: 'Da thật', origin: 'Hàn Quốc' }, axes: [{ attr: 'color2', values: ['Đen'] }], sold: 210, featured: true, img: { emoji: '👜', theme: 'indigo', emoji2: '👑', query: 'luxury handbag' } },
    { slug: 'tui-xach-tron-voyage-joy', name: 'Túi xách tròn VOYAGEJOY', shop: 'bag-and-co', category: 'tui-xach', price: 450000, short: 'Túi xách dáng tròn, cách điệu, phù hợp style trendy.', attrs: { brand: 'VOYAGEJOY', bag_size: 'Nhỏ (≤20L)', strap_material: 'Dây nylon', material2: 'Vải canvas', origin: 'Trung Quốc' }, axes: [{ attr: 'color2', values: ['Đen', 'Xanh', 'Xám'] }], sold: 350, isNew: true, tags: ['new'], img: { emoji: '👜', theme: 'violet', emoji2: '🎯', query: 'round handbag' } },
    { slug: 'tui-satchel-vai-satchel-pro', name: 'Túi Satchel vai SATCHEL PRO', shop: 'bag-and-co', category: 'tui-xach', price: 550000, listPrice: 650000, short: 'Túi satchel, quai vai đơn, kiểu dáng học sinh, sang chảnh lại rẻ.', attrs: { brand: 'SATCHEL PRO', bag_size: 'Vừa (20-30L)', strap_material: 'Dây da PU', material2: 'Da PU', origin: 'Việt Nam' }, axes: [{ attr: 'color2', values: ['Đen', 'Trắng', 'Hồng'] }], sold: 580, tags: ['sale'], img: { emoji: '👜', theme: 'coral', emoji2: '📚', query: 'satchel bag' } },
    { slug: 'tui-hobo-casual-luminos', name: 'Túi Hobo Casual LUMINOS', shop: 'bag-and-co', category: 'tui-xach', price: 380000, short: 'Túi hobo, quai vai dài, dáng lỏng, phù hợp mặc giản dị.', attrs: { brand: 'LUMINOS', bag_size: 'Vừa (20-30L)', strap_material: 'Dây vải cotton', material2: 'Vải canvas', origin: 'Việt Nam' }, axes: [{ attr: 'color2', values: ['Be', 'Xám', 'Đen'] }], sold: 470, img: { emoji: '👜', theme: 'sand', emoji2: '😎', query: 'hobo bag' } },
    { slug: 'tui-khan-lam-thop-carryclass', name: 'Túi khăn làm thop CARRYCLASS', shop: 'bag-and-co', category: 'tui-xach', price: 280000, short: 'Túi vải khăn, hạn chế nhăn, tuổi thọ cao, giá rẻ, an toàn môi trường.', attrs: { brand: 'CARRYCLASS', bag_size: 'Nhỏ (≤20L)', strap_material: 'Dây vải cotton', material2: 'Vải cotton', origin: 'Việt Nam' }, axes: [{ attr: 'color2', values: ['Trắng', 'Xám', 'Vàng'] }], sold: 820, img: { emoji: '👜', theme: 'lime', emoji2: '♻️', query: 'linen tote bag' } },

    // ---- BALO & VALI (9 sản phẩm, shop: bag-and-co) ----
    { slug: 'balo-hoc-tap-18l-urbantote', name: 'Balo học tập 18L URBANTOTE', shop: 'bag-and-co', category: 'balo-vali', price: 320000, short: 'Balo học tập, có ngăn sách, dây ngoài, phù hợp học sinh.', attrs: { brand: 'URBANTOTE', bag_size: 'Nhỏ (≤20L)', material2: 'Polyester', origin: 'Việt Nam', warranty: 'Bảo hành đường may 12 tháng' }, axes: [{ attr: 'color2', values: ['Đen', 'Xanh', 'Hồng'] }], sold: 1200, featured: true, img: { emoji: '🎒', theme: 'indigo', emoji2: '📚', query: 'school backpack' } },
    { slug: 'balo-du-lich-40l-luxepacks', name: 'Balo du lịch 40L LUXEPACKS', shop: 'bag-and-co', category: 'balo-vali', price: 850000, listPrice: 1000000, short: 'Balo du lịch dung tích lớn 40L, khung nhôm cứng, chất lượng tốt.', desc: 'LUXEPACKS Travel Pack 40L với khung nhôm cứng cỏ, quai hỗ trợ lưng giảm áp lực. Có ngăn ẩm, khóa sốc chống cắt. Chất liệu Nylon 600D bền chắc. Kích thước 55x35x20cm phù hợp hành lý xách tay của bay.', attrs: { brand: 'LUXEPACKS', bag_size: 'Lớn (30-40L)', material2: 'Nylon', origin: 'Trung Quốc', warranty: 'Bảo hành khâu 24 tháng' }, axes: [{ attr: 'color2', values: ['Xám', 'Đen'] }], sold: 410, tags: ['sale'], img: { emoji: '🎒', theme: 'slate', emoji2: '✈️', query: 'travel backpack' } },
    { slug: 'vali-keo-20-inch-voyagejoy', name: 'Vali kéo 20 inch VOYAGEJOY', shop: 'bag-and-co', category: 'balo-vali', price: 890000, listPrice: 1090000, short: 'Vali kéo 20 inch, chứa được hành lý xách tay máy bay, bánh xe trơn.', desc: 'VOYAGEJOY Luggage 20" (ABS + PC) trọng lượng nhẹ 2.6kg. Khóa TSA an toàn, bánh xe lăn 360° êm. Có lót bên trong phân ngăn chứa đồ. Bảo hành hành lý 5 năm.', attrs: { brand: 'VOYAGEJOY', bag_size: '20 inch', material2: 'ABS + PC', origin: 'Trung Quốc', warranty: 'Bảo hành 5 năm' }, axes: [{ attr: 'color2', values: ['Đen', 'Xám', 'Xanh'] }], sold: 680, featured: true, tags: ['sale'], img: { emoji: '🎒', theme: 'sky', emoji2: '🧳', query: 'luggage carry-on' } },
    { slug: 'balo-chong-trom-smarttech', name: 'Balo chống trộm URBANTOTE SmartTech', shop: 'bag-and-co', category: 'balo-vali', price: 620000, short: 'Balo chống trộm, dây khóa thiệp, ngăn ẩn, an toàn cho laptop, điện thoại.', attrs: { brand: 'URBANTOTE', bag_size: 'Vừa (20-30L)', material2: 'Polyester', origin: 'Việt Nam' }, axes: [{ attr: 'color2', values: ['Đen', 'Xám'] }], sold: 520, isNew: true, tags: ['new'], img: { emoji: '🎒', theme: 'violet', emoji2: '🔐', query: 'anti-theft backpack' } },
    { slug: 'vali-24-inch-carryclass-premium', name: 'Vali 24 inch CARRYCLASS Premium', shop: 'bag-and-co', category: 'balo-vali', price: 1290000, short: 'Vali 24 inch, chất liệu cao cấp, khóa kép, phục vụ chuyến du lịch dài.', attrs: { brand: 'CARRYCLASS', bag_size: '24 inch', material2: 'PC + ABS', origin: 'Trung Quốc', warranty: 'Bảo hành 5 năm' }, axes: [{ attr: 'color2', values: ['Đen', 'Bạc'] }], sold: 320, img: { emoji: '🎒', theme: 'mint', emoji2: '🌍', query: 'suitcase' } },
    { slug: 'balo-gym-nam-satchel-pro', name: 'Balo gym nam SATCHEL PRO', shop: 'bag-and-co', category: 'balo-vali', price: 420000, short: 'Balo gym, ngăn riêng đồ ẩm, quai chéo, phong cách thể thao.', attrs: { brand: 'SATCHEL PRO', bag_size: 'Vừa (20-30L)', material2: 'Polyester', origin: 'Việt Nam', warranty: 'Bảo hành 12 tháng' }, axes: [{ attr: 'color2', values: ['Đen', 'Xám', 'Xanh'] }], sold: 690, img: { emoji: '🎒', theme: 'coral', emoji2: '🏋️', query: 'gym backpack' } },
    { slug: 'balo-vali-nhap-khau-luminos', name: 'Balo vali nhập khẩu LUMINOS', shop: 'bag-and-co', category: 'balo-vali', price: 1650000, short: 'Balo vali lai, giữ được hình dáng, chứa 35-40L, phơi rộng như tủ.', attrs: { brand: 'LUMINOS', bag_size: 'Lớn (30-40L)', material2: 'Polyester', origin: 'Hàn Quốc', warranty: 'Bảo hành 24 tháng' }, axes: [{ attr: 'color2', values: ['Đen'] }], sold: 150, featured: true, img: { emoji: '🎒', theme: 'emerald', emoji2: '✨', query: 'hybrid luggage' } },
    { slug: 'vali-28-inch-voyagejoy-deluxe', name: 'Vali 28 inch VOYAGEJOY Deluxe', shop: 'bag-and-co', category: 'balo-vali', price: 1890000, listPrice: 2190000, short: 'Vali 28 inch lớn nhất, dung tích khủng, dành cho chuyến đi lâu.', desc: 'VOYAGEJOY Deluxe 28" cho dung tích tối đa 90L. Khóa khép 2 chiều, quay ngang thanh nhôm. Bánh xe siêu êm, vỏ PC cứng, cách âm tốt. Bảo hành 5 năm.', attrs: { brand: 'VOYAGEJOY', bag_size: '28 inch', material2: 'PC', origin: 'Trung Quốc', warranty: 'Bảo hành 5 năm' }, axes: [{ attr: 'color2', values: ['Đen', 'Xám'] }], sold: 280, tags: ['sale'], img: { emoji: '🎒', theme: 'fuchsia', emoji2: '📦', query: 'large luggage' } },
    { slug: 'balo-leo-nui-daypack-luxepacks', name: 'Balo leo núi Daypack LUXEPACKS', shop: 'bag-and-co', category: 'balo-vali', price: 780000, short: 'Balo daypack leo núi 35L, khung cứng, hệ thống hỗ trợ lưng, dây an toàn.', attrs: { brand: 'LUXEPACKS', bag_size: 'Lớn (30-40L)', material2: 'Nylon', origin: 'Hàn Quốc', warranty: 'Bảo hành 24 tháng' }, axes: [{ attr: 'color2', values: ['Xanh lá', 'Xám', 'Đen'] }], sold: 240, img: { emoji: '🎒', theme: 'lime', emoji2: '🏔️', query: 'hiking daypack' } },
  ],
};

export default dept;
