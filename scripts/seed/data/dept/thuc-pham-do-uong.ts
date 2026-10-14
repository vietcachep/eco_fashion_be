/*
 * Ngành gốc "Thực phẩm & Đồ uống" — đa dạng sản phẩm ăn uống: đồ ăn vặt, cà phê, trà, đặc sản vùng miền, các loại hạt và ngũ cốc.
 * Bao gồm shop bị khoá (hang-nhai-24h) để demo luồng shop suspended.
 */
import type { DeptSeed } from '../types';

const dept: DeptSeed = {
  slug: 'thuc-pham-do-uong',
  name: 'Thực phẩm & Đồ uống',
  description: 'Thực phẩm ăn vặt, đồ ăn liền, cà phê, trà, đặc sản Việt, các loại hạt và ngũ cốc bổ dưỡng',
  sortOrder: 110,
  icon: '🍜',
  theme: 'amber',
  attributes: [
    { code: 'brand', name: 'Thương hiệu', inputType: 'select', values: ['Đất Việt', 'Hương Mộc', 'Tiệp Ẩm', 'Vị Quê', 'Cà Phê Tây Bắc', 'Hạt Giàu', 'Bánh Sành Sông', 'Thanh Tâm', 'Xây Lâm', 'Thương Hiệu Mẹ', 'Cơm Truyền Thống', 'Hạt Vàng', 'Sơn Tây Foods', 'Mekong Fresh'] },
    { code: 'flavor', name: 'Vị', inputType: 'select', values: ['Original', 'Cay', 'Mặn', 'Ngọt', 'Chua', 'Thơm', 'Chua mặn', 'Chua ngọt', 'Bơ tỏi', 'Trứng muối', 'Tôm chua', 'Cua biển', 'Nấm'] },
    { code: 'net_weight', name: 'Khối lượng tịnh', inputType: 'select', values: ['50g', '75g', '80g', '80g (20 gói)', '100g', '120g', '150g', '150g (10 gói)', '200g', '200g (50 gói)', '250g', '300g', '300g (20 gói)', '400g', '500g', '600g', '750g', '1kg', '2kg'] },
    { code: 'expiry', name: 'Hạn sử dụng', inputType: 'text' },
    { code: 'region', name: 'Vùng miền', inputType: 'select', values: ['Miền Bắc', 'Miền Trung', 'Miền Nam', 'Tây Nguyên', 'Đông Nam Bộ'] },
  ],
  categories: [
    {
      slug: 'do-an-vat', name: 'Đồ ăn vặt', description: 'Bánh, kẹo, mứt, các loại hạt rang, bỏng ngô bổ dưỡng', sortOrder: 111, icon: '🍪', theme: 'coral',
      attrs: [
        { code: 'brand', required: true },
        { code: 'flavor' },
        { code: 'net_weight', required: true, axis: true },
        { code: 'region' },
        { code: 'origin' },
        { code: 'expiry' },
      ],
    },
    {
      slug: 'ca-phe-tra', name: 'Cà phê & Trà', description: 'Cà phê xay, cà phê hạt, các loại trà hương thơm', sortOrder: 112, icon: '☕', theme: 'orange',
      attrs: [
        { code: 'brand', required: true },
        { code: 'flavor' },
        { code: 'net_weight', required: true, axis: true },
        { code: 'origin' },
        { code: 'region' },
        { code: 'expiry' },
      ],
    },
    {
      slug: 'dac-san-viet-nam', name: 'Đặc sản Việt Nam', description: 'Quà tặng, đặc sản địa phương, mứt, sấy khô, thương hiệu đình đám', sortOrder: 113, icon: '🥭', theme: 'lime',
      attrs: [
        { code: 'brand' },
        { code: 'region', required: true },
        { code: 'net_weight' },
        { code: 'origin' },
        { code: 'expiry' },
      ],
    },
    {
      slug: 'ngu-coc-hat-dinh-duong', name: 'Ngũ cốc & Hạt bổ dưỡng', description: 'Ngũ cốc dinh dưỡng, hạt óc chó, hạt sâm, mầm lúa mạch', sortOrder: 114, icon: '🌾', theme: 'sand',
      attrs: [
        { code: 'brand' },
        { code: 'net_weight', required: true, axis: true },
        { code: 'origin' },
        { code: 'expiry', required: true },
      ],
    },
  ],
  products: [
    // ---- DO-AN-VAT (Snacks) ----
    { slug: 'banh-khoai-mon-da-lat', name: 'Bánh khoai môn Đà Lạt', shop: 'ngon-viet', category: 'do-an-vat', price: 45000, short: 'Bánh tươi vị khoai môn, ăn ở Đà Lạt thì lạ, ăn ở nhà cũng ngon.', attrs: { brand: 'Thanh Tâm', flavor: 'Ngọt', origin: 'Việt Nam', region: 'Miền Nam', expiry: 'HSD 30 ngày từ ngày sản xuất' }, axes: [{ attr: 'net_weight', values: ['200g', { v: '400g', delta: 60000 }] }], sold: 850, isNew: true, tags: ['new'], img: { emoji: '🧁', theme: 'coral', emoji2: '👑', query: 'taro cake' } },
    { slug: 'chip-tao-say-khong-dau', name: 'Chip táo sấy không dầu', shop: 'ngon-viet', category: 'do-an-vat', price: 68000, listPrice: 85000, short: 'Táo Hàn Quốc sấy lạnh, giòn tan, ít calo, đủ ngon.', desc: 'Chip táo Fuji sấy lạnh không thêm dầu, ít đường, vô cùng giòn. Ăn khi muốn ăn vặt nhưng sợ béo hay sợ đường quá cao.', attrs: { brand: 'Đất Việt', flavor: 'Chua ngọt', origin: 'Hàn Quốc', expiry: 'HSD 6 tháng' }, axes: [{ attr: 'net_weight', values: ['80g', { v: '150g', delta: 35000 }] }], sold: 1250, featured: true, tags: ['sale'], img: { emoji: '🍎', theme: 'rose', emoji2: '✨', query: 'dried apple chips' } },
    { slug: 'keo-dua-hanoi', name: 'Kẹo dừa Hà Nội xưa', shop: 'ngon-viet', category: 'do-an-vat', price: 52000, short: 'Kẹo dừa truyền thống, mềm, thơm, vị dừa thật.', attrs: { brand: 'Hương Mộc', flavor: 'Ngọt', origin: 'Việt Nam', region: 'Miền Bắc', expiry: 'HSD 3 tháng' }, axes: [{ attr: 'net_weight', values: ['100g', { v: '250g', delta: 78000 }] }], sold: 680, tags: ['sale'], img: { emoji: '🍬', theme: 'fuchsia', emoji2: '🥥', query: 'coconut candy' } },
    { slug: 'trang-vang-muoi-oc', name: 'Trăng vàng muối ốc', shop: 'ngon-viet', category: 'do-an-vat', price: 38000, listPrice: 48000, short: 'Bánh trăng nướng vàng, muối ốc chua, giòn tan trong miệng.', attrs: { brand: 'Tiệp Ẩm', flavor: 'Chua mặn', origin: 'Việt Nam', region: 'Miền Trung', expiry: 'HSD 4 tháng' }, axes: [{ attr: 'net_weight', values: ['100g', { v: '200g', delta: 50000 }] }], sold: 1420, tags: ['sale'], img: { emoji: '🍘', theme: 'amber', emoji2: '🐚', query: 'puffed rice snack' } },
    { slug: 'popcorn-duong-manh', name: 'Popcorn đường mạnh', shop: 'healthy-life', category: 'do-an-vat', price: 55000, short: 'Ngô rang bơ, đường mạnh, rất giòn, cảm giác mới mẻ.', attrs: { brand: 'Vị Quê', flavor: 'Ngọt', origin: 'Trung Quốc', expiry: 'HSD 6 tháng' }, axes: [{ attr: 'net_weight', values: ['120g', { v: '300g', delta: 95000 }] }], sold: 920, img: { emoji: '🍿', theme: 'orange', emoji2: '✨', query: 'caramel popcorn' } },
    { slug: 'hat-dua-rang-muoi', name: 'Hạt dưa rang muối', shop: 'healthy-life', category: 'do-an-vat', price: 42000, short: 'Hạt dưa ở Tây Nguyên, rang vừa, muối vừa, mặn ngon.', attrs: { brand: 'Hạt Giàu', flavor: 'Mặn', origin: 'Việt Nam', region: 'Tây Nguyên', expiry: 'HSD 8 tháng' }, axes: [{ attr: 'net_weight', values: ['150g', { v: '400g', delta: 85000 }] }], sold: 1100, featured: true, img: { emoji: '🌻', theme: 'lime', emoji2: '🧂', query: 'roasted watermelon seeds' } },
    { slug: 'mut-dau-gac', name: 'Mứt dâu gác bếp', shop: 'healthy-life', category: 'do-an-vat', price: 65000, listPrice: 82000, short: 'Dâu gác bếp Lạng Sơn, nguyên chất, ít đường, đẹp da.', desc: 'Mứt dâu gác bếp 100% từ Lạng Sơn, không thêm màu, ít đường, giàu chất chống oxy hoá. Ăn trực tiếp hay khuôn mặt nạ đều tuyệt vời.', attrs: { brand: 'Xây Lâm', flavor: 'Chua ngọt', origin: 'Việt Nam', region: 'Miền Bắc', expiry: 'HSD 12 tháng' }, axes: [{ attr: 'net_weight', values: ['200g', { v: '500g', delta: 110000 }] }], sold: 420, tags: ['sale'], img: { emoji: '🫐', theme: 'rose', emoji2: '✨', query: 'mulberry jam' } },
    { slug: 'khoai-tay-chien-tran', name: 'Khoai tây chiên trộn', shop: 'hang-nhai-24h', category: 'do-an-vat', price: 18000, short: 'Khoai tây chiên vàng, trộn tỏi cay, mặn mà.', attrs: { brand: 'Tiệp Ẩm', flavor: 'Bơ tỏi', origin: 'Trung Quốc', expiry: 'HSD 6 tháng' }, axes: [{ attr: 'net_weight', values: ['75g', { v: '150g', delta: 22000 }] }], sold: 680, img: { emoji: '🍟', theme: 'amber', emoji2: '🧄', query: 'potato chips' } },
    { slug: 'que-que-me-sen', name: 'Quẻ quẻ mế sên', shop: 'hang-nhai-24h', category: 'do-an-vat', price: 25000, short: 'Bánh que vòng tròn, vị mế sên béo, giòn tan.', attrs: { brand: 'Bánh Sành Sông', flavor: 'Mặn', origin: 'Việt Nam', region: 'Miền Nam', expiry: 'HSD 3 tháng' }, axes: [{ attr: 'net_weight', values: ['100g', { v: '200g', delta: 38000 }] }], sold: 450, img: { emoji: '🌀', theme: 'coral', emoji2: '🍤', query: 'shrimp cracker' } },
    { slug: 'keo-socola-hat-dau', name: 'Kẹo sôcôla hạt dâu', shop: 'hang-nhai-24h', category: 'do-an-vat', price: 35000, short: 'Kẹo sôcôla lót dâu thật bên trong, ngon miễn bàn.', attrs: { brand: 'Thương Hiệu Mẹ', flavor: 'Ngọt', origin: 'Trung Quốc', expiry: 'HSD 12 tháng' }, axes: [{ attr: 'net_weight', values: ['100g'] }], sold: 320, img: { emoji: '🍫', theme: 'brown', emoji2: '🍓', query: 'chocolate strawberry' } },

    // ---- CA-PHE-TRA (Coffee & Tea) ----
    { slug: 'cafe-day-tay-bac', name: 'Cà phê đậy Tây Bắc nguyên chất', shop: 'ngon-viet', category: 'ca-phe-tra', price: 128000, listPrice: 159000, short: 'Cà phê rang xay Tây Bắc, hương thơm đậm, vị đắng nhẹ.', desc: 'Cà phê Tây Bắc 100% nguyên chất, không trộn, hạt được tuyển lọc kỹ. Rang tươi, xay thô để dùng với phin truyền thống, hương thơm đặc trưng Tây Bắc.', attrs: { brand: 'Cà Phê Tây Bắc', flavor: 'Thơm', region: 'Miền Bắc', origin: 'Việt Nam', expiry: 'HSD 12 tháng' }, axes: [{ attr: 'net_weight', values: ['250g', { v: '500g', delta: 95000 }] }], sold: 580, featured: true, tags: ['sale'], img: { emoji: '☕', theme: 'orange', emoji2: '🔥', query: 'vietnamese coffee' } },
    { slug: 'cafe-hat-dang-dung', name: 'Cà phê hạt Đặng Dung cao cấp', shop: 'ngon-viet', category: 'ca-phe-tra', price: 156000, listPrice: 195000, short: 'Hạt cà phê rang mềm, uống nước đen sẫm, ít đắng.', attrs: { brand: 'Hương Mộc', flavor: 'Thơm', region: 'Tây Nguyên', origin: 'Việt Nam', expiry: 'HSD 18 tháng' }, axes: [{ attr: 'net_weight', values: ['300g', { v: '750g', delta: 180000 }] }], sold: 420, tags: ['sale'], img: { emoji: '☕', theme: 'brown', emoji2: '👑', query: 'premium coffee beans' } },
    { slug: 'cafe-sua-da-goi-san-sang', name: 'Cà phê sữa đá gói sẵn', shop: 'healthy-life', category: 'ca-phe-tra', price: 89000, listPrice: 99000, short: 'Gói cà phê sữa đá đặc chế, pha nhanh chỉ thêm nước đá.', attrs: { brand: 'Đất Việt', flavor: 'Original', region: 'Miền Nam', origin: 'Việt Nam', expiry: 'HSD 12 tháng' }, axes: [{ attr: 'net_weight', values: ['150g (10 gói)', { v: '300g (20 gói)', delta: 65000 }] }], sold: 950, tags: ['sale'], img: { emoji: '🥛', theme: 'coral', emoji2: '🧊', query: 'instant coffee' } },
    { slug: 'tra-xanh-thanh-loc', name: 'Trà xanh thanh lọc', shop: 'ngon-viet', category: 'ca-phe-tra', price: 75000, short: 'Trà xanh lá nguyên liệu, không bụi, vị nhẹ nhàng.', attrs: { brand: 'Vị Quê', flavor: 'Thơm', region: 'Miền Bắc', origin: 'Việt Nam', expiry: 'HSD 24 tháng' }, axes: [{ attr: 'net_weight', values: ['100g', { v: '250g', delta: 85000 }] }], sold: 520, isNew: true, tags: ['new'], img: { emoji: '🍵', theme: 'emerald', emoji2: '🌿', query: 'green tea' } },
    { slug: 'tra-oolong-tuong-linh', name: 'Trà Oolong Tương Linh', shop: 'ngon-viet', category: 'ca-phe-tra', price: 142000, listPrice: 178000, short: 'Trà Oolong bán phần ferment, hương hoa quả, vị mềm.', desc: 'Trà Oolong Tương Linh được thu hoạch vào mùa xuân, hương hoa quả tinh tế, vị cơm nước xảo, làm lạnh hay nóng đều tuyệt vời.', attrs: { brand: 'Xây Lâm', flavor: 'Thơm', region: 'Miền Trung', origin: 'Việt Nam', expiry: 'HSD 36 tháng' }, axes: [{ attr: 'net_weight', values: ['150g', { v: '400g', delta: 120000 }] }], sold: 310, featured: true, tags: ['sale'], img: { emoji: '🍵', theme: 'lime', emoji2: '🌸', query: 'oolong tea' } },
    { slug: 'tra-hoa-cu-chi', name: 'Trà hoa cúc chi', shop: 'healthy-life', category: 'ca-phe-tra', price: 62000, short: 'Hoa cúc sấy khô, pha trực tiếp, mát gan dễ chịu.', attrs: { brand: 'Thanh Tâm', flavor: 'Thơm', region: 'Miền Nam', origin: 'Việt Nam', expiry: 'HSD 18 tháng' }, axes: [{ attr: 'net_weight', values: ['80g (20 gói)', { v: '200g (50 gói)', delta: 78000 }] }], sold: 820, img: { emoji: '🌼', theme: 'lime', emoji2: '💛', query: 'chrysanthemum tea' } },
    { slug: 'tra-gung-mat-ong', name: 'Trà gừng mật ong', shop: 'healthy-life', category: 'ca-phe-tra', price: 48000, listPrice: 60000, short: 'Gừng tươi và mật ong, ấm người, giảm cảm.', attrs: { brand: 'Đất Việt', flavor: 'Chua ngọt', origin: 'Việt Nam', expiry: 'HSD 12 tháng' }, axes: [{ attr: 'net_weight', values: ['150g'] }], sold: 680, tags: ['sale'], img: { emoji: '🧡', theme: 'amber', emoji2: '🍯', query: 'ginger honey tea' } },

    // ---- DAC-SAN-VIET-NAM (Specialty Products) ----
    { slug: 'qua-com-than-tuong-linh', name: 'Quà cơm thần Tương Linh', shop: 'ngon-viet', category: 'dac-san-viet-nam', price: 185000, listPrice: 229000, short: 'Hộp quà gồm 3 loại cơm thần: cơm rang, cơm lạnh, cơm nếp.', attrs: { brand: 'Hương Mộc', region: 'Miền Trung', origin: 'Việt Nam', expiry: 'HSD 6 tháng' }, sold: 280, featured: true, tags: ['sale'], img: { emoji: '🎁', theme: 'rose', emoji2: '🍚', query: 'gift set vietnamese rice' } },
    { slug: 'kho-ca-com-ben-tre', name: 'Khô cá cơm Bến Tre', shop: 'ngon-viet', category: 'dac-san-viet-nam', price: 95000, listPrice: 120000, short: 'Cá cơm khô từ Bến Tre, vị mặn đặc trưng, ăn nấu hay ăn vặt.', desc: 'Khô cá cơm Bến Tre được phơi khô tự nhiên, vị mặn nhẹ, thịt cá ngon, dùng để nấu canh hay ăn vặt cũng rất ngon.', attrs: { region: 'Miền Nam', origin: 'Việt Nam', expiry: 'HSD 8 tháng' }, sold: 420, tags: ['sale'], img: { emoji: '🐟', theme: 'teal', emoji2: '☀️', query: 'dried anchovy' } },
    { slug: 'hat-sen-tam-duong', name: 'Hạt sen Tâm Dương', shop: 'healthy-life', category: 'dac-san-viet-nam', price: 78000, listPrice: 98000, short: 'Hạt sen khô, bào lột, sánh nước còn xanh lá.', attrs: { region: 'Miền Bắc', origin: 'Việt Nam', expiry: 'HSD 12 tháng' }, sold: 310, tags: ['sale'], img: { emoji: '🌸', theme: 'mint', emoji2: '💚', query: 'dried lotus seeds' } },
    { slug: 'ca-cao-nguyen-chat-tay-nguyen', name: 'Cacao nguyên chất Tây Nguyên', shop: 'healthy-life', category: 'dac-san-viet-nam', price: 125000, short: 'Bột cacao rang xay, 100% nguyên chất, không đường.', attrs: { brand: 'Hạt Giàu', region: 'Tây Nguyên', origin: 'Việt Nam', expiry: 'HSD 18 tháng' }, sold: 180, isNew: true, tags: ['new'], img: { emoji: '🍫', theme: 'brown', emoji2: '🌱', query: 'cocoa powder' } },
    { slug: 'muoi-tron-lang-son', name: 'Muối trộn Lạng Sơn', shop: 'ngon-viet', category: 'dac-san-viet-nam', price: 32000, short: 'Muối trộn thảo mộc, bổ sung iodine tự nhiên, gia vị tốt.', attrs: { region: 'Miền Bắc', origin: 'Việt Nam', expiry: 'HSD 24 tháng' }, sold: 920, img: { emoji: '🧂', theme: 'slate', emoji2: '🌿', query: 'herbal salt mix' } },
    { slug: 'dua-say-da-nang', name: 'Dừa sấy Đà Nẵng', shop: 'ngon-viet', category: 'dac-san-viet-nam', price: 58000, listPrice: 75000, short: 'Dừa tươi sấy lạnh, ngọt dịu, mềm và giòn.', attrs: { region: 'Miền Trung', origin: 'Việt Nam', expiry: 'HSD 9 tháng' }, sold: 650, featured: true, tags: ['sale'], img: { emoji: '🥥', theme: 'lime', emoji2: '☀️', query: 'dried coconut' } },

    // ---- NGU-COC-HAT-DINH-DUONG (Nuts & Seeds) ----
    { slug: 'hat-dau-phong-duong', name: 'Hạt đậu phộng đường', shop: 'healthy-life', category: 'ngu-coc-hat-dinh-duong', price: 55000, listPrice: 68000, short: 'Đậu phộng rang, phủ đường mạnh, cáy khéo, ăn cực ngon.', attrs: { brand: 'Hạt Giàu', origin: 'Việt Nam', expiry: 'HSD 6 tháng' }, axes: [{ attr: 'net_weight', values: ['200g', { v: '500g', delta: 85000 }] }], sold: 1580, tags: ['sale'], img: { emoji: '🥜', theme: 'orange', emoji2: '⚪', query: 'sugar peanuts' } },
    { slug: 'hat-oc-cho-moi', name: 'Hạt óc chó mọi', shop: 'healthy-life', category: 'ngu-coc-hat-dinh-duong', price: 142000, short: 'Óc chó Mỹ nhập khẩu, giàu omega 3, giòn tan, béo thơm.', desc: 'Hạt óc chó Mỹ tươi, chọn lọc kỹ lưỡng, giàu dầu tốt và protein, cân bằng dinh dưỡng, ăn hằng ngày tốt cho sức khoẻ.', attrs: { brand: 'Hạt Giàu', origin: 'Mỹ', expiry: 'HSD 12 tháng' }, axes: [{ attr: 'net_weight', values: ['250g', { v: '500g', delta: 125000 }] }], sold: 420, featured: true, img: { emoji: '🌰', theme: 'brown', emoji2: '💪', query: 'walnut kernels' } },
    { slug: 'hat-hong-sam-tay-bac', name: 'Hạt hồng sâm Tây Bắc', shop: 'healthy-life', category: 'ngu-coc-hat-dinh-duong', price: 95000, short: 'Hồng sâm sấy khô, vị nhẹ, bổ sức, tăng sức đề kháng.', attrs: { brand: 'Xây Lâm', origin: 'Việt Nam', expiry: 'HSD 24 tháng' }, axes: [{ attr: 'net_weight', values: ['100g', { v: '250g', delta: 120000 }] }], sold: 280, isNew: true, tags: ['new'], img: { emoji: '🫘', theme: 'rose', emoji2: '✨', query: 'dried ginseng berries' } },
    { slug: 'hat-dau-den-thuoc', name: 'Hạt đậu đen thuốc', shop: 'healthy-life', category: 'ngu-coc-hat-dinh-duong', price: 38000, listPrice: 48000, short: 'Đậu đen tinh khiết, nấu cháo hay nấu chè đều tốt.', attrs: { brand: 'Đất Việt', origin: 'Việt Nam', expiry: 'HSD 18 tháng' }, axes: [{ attr: 'net_weight', values: ['500g', { v: '1kg', delta: 40000 }] }], sold: 840, tags: ['sale'], img: { emoji: '⚫', theme: 'slate', emoji2: '🫖', query: 'black beans' } },
    { slug: 'hat-kinh-do-trang-mieng', name: 'Hạt kinh đô trắng miệng', shop: 'healthy-life', category: 'ngu-coc-hat-dinh-duong', price: 72000, short: 'Hạt kinh đô trắng, béo thơm, cao chất xơ, dễ tiêu.', attrs: { brand: 'Thanh Tâm', origin: 'Việt Nam', expiry: 'HSD 12 tháng' }, axes: [{ attr: 'net_weight', values: ['250g', { v: '600g', delta: 110000 }] }], sold: 520, img: { emoji: '🤎', theme: 'brown', emoji2: '🌱', query: 'Job\'s tears seeds' } },
    { slug: 'hat-co-y-te-rang', name: 'Hạt cỏ y tế rang', shop: 'healthy-life', category: 'ngu-coc-hat-dinh-duong', price: 48000, listPrice: 60000, short: 'Cỏ y tế sấy khô rang vàng, uống nước mát gan thanh nhiệt.', attrs: { brand: 'Vị Quê', origin: 'Việt Nam', expiry: 'HSD 18 tháng' }, axes: [{ attr: 'net_weight', values: ['150g', { v: '400g', delta: 90000 }] }], sold: 620, tags: ['sale'], img: { emoji: '🟢', theme: 'emerald', emoji2: '💚', query: 'barley tea seeds' } },
  ],
};

export default dept;
