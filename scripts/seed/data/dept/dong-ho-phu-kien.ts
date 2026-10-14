/*
 * Ngành gốc "Đồng hồ & Phụ kiện" — Track D (PLAN-0017). Bắt chước khuôn `dien-thoai-phu-kien.ts` (đọc file đó trước).
 * 4 ngành lá: dong-ho-nam, dong-ho-nu, kinh-mat, trang-suc
 * Shop: time-lab
 * Tổng ≥30 sản phẩm, mỗi lá ≥6 sản phẩm, time-lab ≥5 sản phẩm
 */
import type { DeptSeed } from '../types';

const dept: DeptSeed = {
  slug: 'dong-ho-phu-kien',
  name: 'Đồng hồ & Phụ kiện',
  description: 'Đồng hồ nam nữ, kính mắt, trang sức bạc',
  sortOrder: 400,
  icon: '⌚',
  theme: 'slate',
  attributes: [
    { code: 'brand', name: 'Thương hiệu', inputType: 'select', values: ['TIMEFORGE', 'CHRONO ELITE', 'LUXTIME', 'MERIDIAN', 'EPOCH', 'CHRONOGEM', 'VIEWGLASS', 'LUXVISION', 'SHADE ELITE', 'POLARSHADE', 'SILVERGEM', 'ARTISAN CRAFT', 'LUNA SHINE', 'AURORA GEMS'] },
    { code: 'case_size', name: 'Kích cỡ mặt', inputType: 'select', values: ['28mm', '32mm', '34mm', '36mm', '38mm', '40mm', '42mm', '44mm', '46mm'] },
    { code: 'frame_shape', name: 'Hình dáng kính', inputType: 'select', values: ['Tròn', 'Vuông', 'Mắt mèo', 'Oval', 'Lục giác', 'Bầu dục'] },
    { code: 'water_resistance', name: 'Kháng nước', inputType: 'select', values: ['3ATM', '5ATM', '10ATM', '20ATM', '50ATM', '100ATM'] },
    { code: 'jewelry_size', name: 'Kích cỡ nhẫn', inputType: 'select', values: ['6', '7', '8', '9', '10', '11', '12', '13', '14'] },
    { code: 'chain_length', name: 'Độ dài dây', inputType: 'select', values: ['40cm', '42cm', '45cm', '50cm'] },
    { code: 'material2', name: 'Chất liệu', inputType: 'select', values: ['Nhựa', 'Kim loại', 'Inox 304', 'Thép không gỉ', 'Gỗ tự nhiên', 'Gỗ công nghiệp', 'Da PU', 'Da thật', 'Vải canvas', 'Vải cotton', 'Thủy tinh', 'Gốm sứ', 'Silicone', 'Nylon', 'Polyester', 'Lưới thoáng khí', 'Sợi carbon', 'Hợp kim nhôm', 'Cao su', 'Tre', 'Mây tre đan', 'Titanium', 'Bạc 925', 'Vàng 18K', 'Acetate', 'Polycarbonate'] },
  ],
  categories: [
    {
      slug: 'dong-ho-nam',
      name: 'Đồng hồ nam',
      description: 'Đồng hồ nam cao cấp, sang trọng, phong cách business hoặc casual',
      sortOrder: 401,
      icon: '⌚',
      theme: 'indigo',
      attrs: [
        { code: 'color2', required: true, axis: true },
        { code: 'case_size', required: true, axis: true },
        { code: 'brand', required: true },
        { code: 'material2', required: true },
        { code: 'water_resistance' },
        { code: 'origin' },
        { code: 'warranty' },
      ],
    },
    {
      slug: 'dong-ho-nu',
      name: 'Đồng hồ nữ',
      description: 'Đồng hồ nữ thời trang, tinh tế, phù hợp mọi phong cách',
      sortOrder: 402,
      icon: '⌚',
      theme: 'rose',
      attrs: [
        { code: 'color2', required: true, axis: true },
        { code: 'case_size', required: true, axis: true },
        { code: 'brand', required: true },
        { code: 'material2', required: true },
        { code: 'water_resistance' },
        { code: 'origin' },
        { code: 'warranty' },
      ],
    },
    {
      slug: 'kinh-mat',
      name: 'Kính mắt',
      description: 'Kính mắt nam nữ, kính chống nắng, kính thời trang',
      sortOrder: 403,
      icon: '🕶️',
      theme: 'amber',
      attrs: [
        { code: 'color2', required: true, axis: true },
        { code: 'frame_shape', required: true },
        { code: 'brand', required: true },
        { code: 'material2', required: true },
        { code: 'origin' },
      ],
    },
    {
      slug: 'trang-suc',
      name: 'Trang sức',
      description: 'Trang sức bạc, nhẫn, dây chuyền, vòng tay',
      sortOrder: 404,
      icon: '💍',
      theme: 'violet',
      attrs: [
        { code: 'brand', required: true },
        { code: 'color2', axis: true },
        { code: 'jewelry_size' },
        { code: 'chain_length' },
        { code: 'material2', required: true },
        { code: 'origin' },
        { code: 'warranty' },
      ],
    },
  ],
  products: [
    // ---- ĐỒNG HỒ NAM (8 sản phẩm, shop: time-lab) ----
    { slug: 'dong-ho-nam-timeforge-sport', name: 'Đồng hồ nam TIMEFORGE Sport', shop: 'time-lab', category: 'dong-ho-nam', price: 1890000, listPrice: 2190000, short: 'Đồng hồ thể thao, kính chống xước, kháng nước 10ATM, dây cao su chắc chắn.', desc: 'TIMEFORGE Sport với vỏ thép không gỉ 42mm, mặt đen sang trọng. Máy quartz chính xác, kháng nước 10ATM phù hợp bơi lặn. Dây cao su thích hợp chơi thể thao. Bảo hành quốc tế 24 tháng.', attrs: { brand: 'TIMEFORGE', material2: 'Thép không gỉ', water_resistance: '10ATM', origin: 'Hàn Quốc', warranty: 'Bảo hành 24 tháng quốc tế' }, axes: [{ attr: 'color2', values: ['Đen', 'Xanh'] }, { attr: 'case_size', values: ['42mm', '44mm'] }], sold: 420, featured: true, tags: ['sale'], img: { emoji: '⌚', theme: 'navy', emoji2: '⚡', query: 'sports watch mens' } },
    { slug: 'dong-ho-nam-chrono-classic', name: 'Đồng hồ nam CHRONO ELITE Classic', shop: 'time-lab', category: 'dong-ho-nam', price: 2490000, short: 'Đồng hồ cơ, dây da thật, thiết kế cổ điển, sang trọng cho công sở.', attrs: { brand: 'CHRONO ELITE', material2: 'Da thật', water_resistance: '3ATM', origin: 'Thụy Sĩ', warranty: 'Bảo hành 36 tháng' }, axes: [{ attr: 'color2', values: ['Nâu', 'Đen'] }, { attr: 'case_size', values: ['40mm'] }], sold: 180, isNew: true, tags: ['new'], img: { emoji: '⌚', theme: 'brown', emoji2: '✨', query: 'leather watch mens' } },
    { slug: 'dong-ho-nam-luxtime-business', name: 'Đồng hồ nam LUXTIME Business', shop: 'time-lab', category: 'dong-ho-nam', price: 1450000, short: 'Đồng hồ kinh doanh, mặt bạc, dây inox, phù hợp suit lịch sự.', attrs: { brand: 'LUXTIME', material2: 'Thép không gỉ', water_resistance: '5ATM', origin: 'Trung Quốc', warranty: 'Bảo hành 12 tháng' }, axes: [{ attr: 'color2', values: ['Bạc', 'Vàng đồng'] }, { attr: 'case_size', values: ['36mm', '40mm'] }], sold: 610, img: { emoji: '⌚', theme: 'indigo', emoji2: '💼', query: 'business watch' } },
    { slug: 'dong-ho-nam-meridian-adventure', name: 'Đồng hồ nam MERIDIAN Adventure', shop: 'time-lab', category: 'dong-ho-nam', price: 3290000, listPrice: 3890000, short: 'Đồng hồ phiêu lưu, kháng nước 20ATM, dạ quang, bền cho du lịch.', desc: 'MERIDIAN Adventure với vỏ titanium 44mm nhẹ nhưng cứng cáp. Mặt dạ quang sáng 8 giờ, kháng nước 20ATM. Dây paracord tháo rời được. Bảo hành trọn đời máy.', attrs: { brand: 'MERIDIAN', material2: 'Titanium', water_resistance: '20ATM', origin: 'Đức', warranty: 'Bảo hành trọn đời' }, axes: [{ attr: 'color2', values: ['Xám', 'Xanh lá'] }, { attr: 'case_size', values: ['46mm'] }], sold: 150, featured: true, tags: ['sale'], img: { emoji: '⌚', theme: 'emerald', emoji2: '🏔️', query: 'adventure watch' } },
    { slug: 'dong-ho-nam-epoch-minimal', name: 'Đồng hồ nam EPOCH Minimal', shop: 'time-lab', category: 'dong-ho-nam', price: 850000, short: 'Đồng hồ tối giản, thiết kế sạch sẽ, mặt trắng đơn giản, giá tốt.', attrs: { brand: 'EPOCH', material2: 'Thép không gỉ', water_resistance: '5ATM', origin: 'Việt Nam', warranty: 'Bảo hành 12 tháng' }, axes: [{ attr: 'color2', values: ['Trắng', 'Đen'] }, { attr: 'case_size', values: ['36mm', '40mm'] }], sold: 820, img: { emoji: '⌚', theme: 'slate', emoji2: '⏰', query: 'minimalist watch' } },
    { slug: 'dong-ho-nam-chronogem-luxury', name: 'Đồng hồ nam CHRONOGEM Luxury', shop: 'time-lab', category: 'dong-ho-nam', price: 5890000, short: 'Đồng hồ sang trọng cấp cao, mặt Kim cương, dây vàng 18K.', attrs: { brand: 'CHRONOGEM', material2: 'Vàng 18K', water_resistance: '3ATM', origin: 'Ý', warranty: 'Bảo hành trọn đời' }, axes: [{ attr: 'color2', values: ['Vàng đồng'] }, { attr: 'case_size', values: ['40mm'] }], sold: 25, isNew: true, tags: ['new'], img: { emoji: '⌚', theme: 'sand', emoji2: '👑', query: 'luxury watch mens' } },
    { slug: 'dong-ho-nam-timeforge-diver', name: 'Đồng hồ nam TIMEFORGE Diver', shop: 'time-lab', category: 'dong-ho-nam', price: 2150000, short: 'Đồng hồ lặn, kháng nước 100ATM, vỏ đen mềm, chống quặt.', desc: 'TIMEFORGE Diver Pro với vỏ thép 46mm, kháng nước 100ATM an toàn cho lặn. Mặt có điểm sáng, lúm dễ đọc. Dây cao su rắc lực. Bảo hành quốc tế 24 tháng.', attrs: { brand: 'TIMEFORGE', material2: 'Thép không gỉ', water_resistance: '100ATM', origin: 'Hàn Quốc', warranty: 'Bảo hành 24 tháng' }, axes: [{ attr: 'color2', values: ['Đen'] }, { attr: 'case_size', values: ['46mm'] }], sold: 95, img: { emoji: '⌚', theme: 'teal', emoji2: '🤿', query: 'diving watch' } },
    { slug: 'dong-ho-nam-meridian-vintage', name: 'Đồng hồ nam MERIDIAN Vintage', shop: 'time-lab', category: 'dong-ho-nam', price: 1650000, short: 'Đồng hồ vintage cơ, dây da, mặt kem cổ điển, quai hạt thị.', attrs: { brand: 'MERIDIAN', material2: 'Da thật', water_resistance: '3ATM', origin: 'Đức', warranty: 'Bảo hành 24 tháng' }, axes: [{ attr: 'color2', values: ['Be', 'Nâu'] }, { attr: 'case_size', values: ['36mm', '40mm'] }], sold: 340, img: { emoji: '⌚', theme: 'sand', emoji2: '📜', query: 'vintage watch' } },

    // ---- ĐỒNG HỒ NỮ (8 sản phẩm, shop: time-lab) ----
    { slug: 'dong-ho-nu-luxtime-diamond', name: 'Đồng hồ nữ LUXTIME Diamond', shop: 'time-lab', category: 'dong-ho-nu', price: 2890000, short: 'Đồng hồ nữ, mặt đính kim cương nhân tạo, dáng nhỏ gọn sang trọng.', desc: 'LUXTIME Diamond với vỏ bạc 28mm, mặt trắng có 6 viên kim cương nhân tạo. Dây inox bạc mỏng nhưng chắc chắn. Kháng nước 5ATM an toàn hàng ngày. Bảo hành quốc tế 24 tháng.', attrs: { brand: 'LUXTIME', material2: 'Thép không gỉ', water_resistance: '5ATM', origin: 'Trung Quốc', warranty: 'Bảo hành 24 tháng' }, axes: [{ attr: 'color2', values: ['Bạc', 'Vàng đồng'] }, { attr: 'case_size', values: ['28mm', '32mm'] }], sold: 580, featured: true, img: { emoji: '⌚', theme: 'rose', emoji2: '✨', query: 'womens diamond watch' } },
    { slug: 'dong-ho-nu-chrono-elegant', name: 'Đồng hồ nữ CHRONO ELITE Elegant', shop: 'time-lab', category: 'dong-ho-nu', price: 1890000, listPrice: 2190000, short: 'Đồng hồ nữ thanh lịch, mặt tròn dạng ngọc trai, dây da thật.', attrs: { brand: 'CHRONO ELITE', material2: 'Da thật', water_resistance: '3ATM', origin: 'Thụy Sĩ', warranty: 'Bảo hành 36 tháng' }, axes: [{ attr: 'color2', values: ['Hồng', 'Nâu', 'Đen'] }, { attr: 'case_size', values: ['32mm'] }], sold: 420, tags: ['sale'], img: { emoji: '⌚', theme: 'coral', emoji2: '🌸', query: 'elegant womens watch' } },
    { slug: 'dong-ho-nu-epoch-minimalist', name: 'Đồng hồ nữ EPOCH Minimalist', shop: 'time-lab', category: 'dong-ho-nu', price: 720000, short: 'Đồng hồ nữ tối giản, mặt sạch sẽ, dây mỏng nhẹ, giá phải chăng.', attrs: { brand: 'EPOCH', material2: 'Thép không gỉ', water_resistance: '5ATM', origin: 'Việt Nam' }, axes: [{ attr: 'color2', values: ['Trắng', 'Xanh', { v: 'Vàng đồng', delta: 200000 }] }, { attr: 'case_size', values: ['28mm', '32mm'] }], sold: 1150, isNew: true, tags: ['new'], img: { emoji: '⌚', theme: 'mint', emoji2: '⏰', query: 'simple womens watch' } },
    { slug: 'dong-ho-nu-meridian-rose-gold', name: 'Đồng hồ nữ MERIDIAN Rose Gold', shop: 'time-lab', category: 'dong-ho-nu', price: 2450000, short: 'Đồng hồ nữ vàng hồng, sang trọng, phù hợp dự tiệc hay hẹn hò.', desc: 'MERIDIAN Rose Gold với vỏ mạ vàng hồng 34mm, mặt hạt ngọc. Dây inox với khúc gấp an toàn. Kháng nước 5ATM. Bảo hành 24 tháng.', attrs: { brand: 'MERIDIAN', material2: 'Hợp kim nhôm', water_resistance: '5ATM', origin: 'Đức', warranty: 'Bảo hành 24 tháng' }, axes: [{ attr: 'color2', values: ['Hồng'] }, { attr: 'case_size', values: ['34mm'] }], sold: 210, featured: true, img: { emoji: '⌚', theme: 'rose', emoji2: '👑', query: 'rose gold watch' } },
    { slug: 'dong-ho-nu-chronogem-fashion', name: 'Đồng hồ nữ CHRONOGEM Fashion', shop: 'time-lab', category: 'dong-ho-nu', price: 1120000, short: 'Đồng hồ nữ thời trang, mặt lớn nổi bật, dây lệch màu sắc.', attrs: { brand: 'CHRONOGEM', material2: 'Thép không gỉ', water_resistance: '5ATM', origin: 'Trung Quốc' }, axes: [{ attr: 'color2', values: ['Xanh', 'Tím', 'Hồng'] }, { attr: 'case_size', values: ['36mm'] }], sold: 640, img: { emoji: '⌚', theme: 'fuchsia', emoji2: '💕', query: 'fashion watch womens' } },
    { slug: 'dong-ho-nu-luxtime-sporty', name: 'Đồng hồ nữ LUXTIME Sporty', shop: 'time-lab', category: 'dong-ho-nu', price: 1350000, short: 'Đồng hồ nữ thể thao, dây silicone mềm, kháng nước 10ATM, phù hợp chạy bộ.', attrs: { brand: 'LUXTIME', material2: 'Silicone', water_resistance: '10ATM', origin: 'Trung Quốc', warranty: 'Bảo hành 12 tháng' }, axes: [{ attr: 'color2', values: ['Đen', 'Hồng', 'Xanh'] }, { attr: 'case_size', values: ['32mm'] }], sold: 720, img: { emoji: '⌚', theme: 'coral', emoji2: '🏃', query: 'sports watch womens' } },
    { slug: 'dong-ho-nu-epoch-pearl', name: 'Đồng hồ nữ EPOCH Pearl', shop: 'time-lab', category: 'dong-ho-nu', price: 890000, listPrice: 1080000, short: 'Đồng hồ nữ mặt ngọc trai, dây inox bạc, thiết kế thanh thoát.', attrs: { brand: 'EPOCH', material2: 'Thép không gỉ', water_resistance: '5ATM', origin: 'Việt Nam', warranty: 'Bảo hành 12 tháng' }, axes: [{ attr: 'color2', values: ['Trắng', 'Xám'] }, { attr: 'case_size', values: ['32mm'] }], sold: 490, tags: ['sale'], img: { emoji: '⌚', theme: 'indigo', emoji2: '🌙', query: 'pearl watch' } },
    { slug: 'dong-ho-nu-chronogem-romantic', name: 'Đồng hồ nữ CHRONOGEM Romantic', shop: 'time-lab', category: 'dong-ho-nu', price: 1650000, short: 'Đồng hồ nữ lãng mạn, mặt xoay 360, dây da thật màu hồng.', attrs: { brand: 'CHRONOGEM', material2: 'Da thật', water_resistance: '3ATM', origin: 'Hàn Quốc', warranty: 'Bảo hành 18 tháng' }, axes: [{ attr: 'color2', values: ['Hồng', 'Be'] }, { attr: 'case_size', values: ['28mm', '32mm'] }], sold: 310, img: { emoji: '⌚', theme: 'rose', emoji2: '💗', query: 'romantic watch' } },

    // ---- KÍNH MẮT (8 sản phẩm, shop: time-lab) ----
    { slug: 'kinh-mat-viewglass-pilot', name: 'Kính mắt VIEWGLASS Pilot', shop: 'time-lab', category: 'kinh-mat', price: 580000, listPrice: 720000, short: 'Kính pilot cổ điển, gương ánh bạc, tránh nắng hiệu quả, tác phong ngoài khơi.', desc: 'VIEWGLASS Pilot với lenses màu bạc phản chiếu UV 100%. Gọng kim loại nhẹ nhưng cứng cáp. Chân kính linh hoạt. Kèm bao case vải cao cấp.', attrs: { brand: 'VIEWGLASS', frame_shape: 'Oval', material2: 'Kim loại', origin: 'Trung Quốc' }, axes: [{ attr: 'color2', values: ['Bạc', 'Vàng'] }], sold: 450, tags: ['sale'], img: { emoji: '🕶️', theme: 'slate', emoji2: '✈️', query: 'pilot sunglasses' } },
    { slug: 'kinh-mat-luxvision-cat-eye', name: 'Kính mắt LUXVISION Cat Eye', shop: 'time-lab', category: 'kinh-mat', price: 420000, short: 'Kính mặt mèo retro, gọng đen bóng, gương gradient, hot trend TikTok.', attrs: { brand: 'LUXVISION', frame_shape: 'Mắt mèo', material2: 'Acetate', origin: 'Việt Nam' }, axes: [{ attr: 'color2', values: ['Đen', 'Nâu'] }], sold: 890, isNew: true, tags: ['new'], img: { emoji: '🕶️', theme: 'coral', emoji2: '😸', query: 'cat eye sunglasses' } },
    { slug: 'kinh-mat-shade-elite-wayfarer', name: 'Kính mắt SHADE ELITE Wayfarer', shop: 'time-lab', category: 'kinh-mat', price: 650000, short: 'Kính wayfarer vuông cúc, gọng bền, lenses polarized chắn lóa.', desc: 'SHADE ELITE Wayfarer với gọng nylon chắc chắn, lenses polarized giảm lóa 99%. Chống UV400. Kèm case chính hãng.', attrs: { brand: 'SHADE ELITE', frame_shape: 'Vuông', material2: 'Nylon', origin: 'Trung Quốc' }, axes: [{ attr: 'color2', values: ['Đen', 'Nâu'] }], sold: 520, featured: true, img: { emoji: '🕶️', theme: 'indigo', emoji2: '🌞', query: 'wayfarer sunglasses' } },
    { slug: 'kinh-mat-polarshade-round', name: 'Kính mắt POLARSHADE Round', shop: 'time-lab', category: 'kinh-mat', price: 380000, short: 'Kính tròn cổ điển, gọng vàng, lenses gradient hơi, phong cách John Lennon.', attrs: { brand: 'POLARSHADE', frame_shape: 'Tròn', material2: 'Kim loại', origin: 'Trung Quốc' }, axes: [{ attr: 'color2', values: ['Vàng', 'Bạc'] }], sold: 680, img: { emoji: '🕶️', theme: 'sand', emoji2: '🎸', query: 'round sunglasses' } },
    { slug: 'kinh-mat-shade-sport-performance', name: 'Kính mắt SHADE ELITE Sport Performance', shop: 'time-lab', category: 'kinh-mat', price: 750000, short: 'Kính thể thao, gọng wraparound chắc, lenses photochromic thay đổi màu.', desc: 'SHADE ELITE Sport với gọng wraparound bảo vệ 180°. Lenses photochromic thay đổi theo nắng. Chống UV 100%. Dây quai chuyên dụng. Bảo hành 24 tháng.', attrs: { brand: 'SHADE ELITE', frame_shape: 'Oval', material2: 'Polycarbonate', origin: 'Hàn Quốc' }, axes: [{ attr: 'color2', values: ['Xanh', 'Đen'] }], sold: 310, img: { emoji: '🕶️', theme: 'lime', emoji2: '🏃', query: 'sports sunglasses' } },
    { slug: 'kinh-mat-luxvision-oval', name: 'Kính mắt LUXVISION Oval', shop: 'time-lab', category: 'kinh-mat', price: 480000, listPrice: 620000, short: 'Kính oval bầu dục, gọng nhỏ gọn, phù hợp gương mặt tròn.', attrs: { brand: 'LUXVISION', frame_shape: 'Oval', material2: 'Acetate', origin: 'Việt Nam' }, axes: [{ attr: 'color2', values: ['Đen', 'Xám', 'Hồng'] }], sold: 540, tags: ['sale'], img: { emoji: '🕶️', theme: 'rose', emoji2: '👁️', query: 'oval sunglasses' } },
    { slug: 'kinh-mat-viewglass-oversized', name: 'Kính mắt VIEWGLASS Oversized', shop: 'time-lab', category: 'kinh-mat', price: 520000, short: 'Kính lớn che mặt, lenses gradient, sang chảnh, phù hợp sao.', attrs: { brand: 'VIEWGLASS', frame_shape: 'Vuông', material2: 'Acetate', origin: 'Trung Quốc' }, axes: [{ attr: 'color2', values: ['Đen', 'Nâu', 'Hồng'] }], sold: 720, img: { emoji: '🕶️', theme: 'fuchsia', emoji2: '⭐', query: 'oversized sunglasses' } },
    { slug: 'kinh-mat-polarshade-blue-light', name: 'Kính lọc ánh xanh POLARSHADE BlueLite', shop: 'time-lab', category: 'kinh-mat', price: 380000, short: 'Kính lọc ánh xanh, bảo vệ mắt khi dùng điện thoại, máy tính lâu.', attrs: { brand: 'POLARSHADE', frame_shape: 'Tròn', material2: 'Polycarbonate', origin: 'Việt Nam' }, axes: [{ attr: 'color2', values: ['Đen', 'Xám'] }], sold: 850, img: { emoji: '🕶️', theme: 'indigo', emoji2: '💻', query: 'blue light glasses' } },

    // ---- TRANG SỨC (8 sản phẩm, shop: time-lab) ----
    { slug: 'nhan-bac-silvergem-diamond', name: 'Nhẫn bạc SILVERGEM Diamond', shop: 'time-lab', category: 'trang-suc', price: 890000, short: 'Nhẫn bạc 925 độ, đính 1 viên kim cương nhân tạo, thiết kế thanh lịch.', desc: 'SILVERGEM Diamond Ring làm từ bạc 925 độ, có viên kim cương nhân tạo 5mm cắt sáng. Gọng uốn tỉ mỉ. Kèm giấy chứng chỉ bạc. Bảo hành trọn đời.', attrs: { brand: 'SILVERGEM', material2: 'Bạc 925', origin: 'Hàn Quốc', warranty: 'Bảo hành trọn đời' }, axes: [{ attr: 'color2', values: ['Bạc'] }], sold: 320, featured: true, img: { emoji: '💍', theme: 'indigo', emoji2: '✨', query: 'silver diamond ring' } },
    { slug: 'day-chuyen-bac-artisan-craft', name: 'Dây chuyền bạc ARTISAN CRAFT', shop: 'time-lab', category: 'trang-suc', price: 620000, short: 'Dây chuyền bạc 925, mắt xích dầy, thiết kế nâng hạt tinh tế.', desc: 'ARTISAN CRAFT Necklace với mắt xích bạc 925 độ dầy 3mm, tay thợ đan mịn. Dung tích tổng 16 inch. Kèm hộp đẹp và chứng chỉ.', attrs: { brand: 'ARTISAN CRAFT', material2: 'Bạc 925', chain_length: '40cm', origin: 'Việt Nam', warranty: 'Bảo hành 12 tháng' }, axes: [{ attr: 'color2', values: ['Bạc'] }], sold: 480, img: { emoji: '💍', theme: 'slate', emoji2: '🔗', query: 'silver chain necklace' } },
    { slug: 'vong-tay-bac-luna-shine', name: 'Vòng tay bạc LUNA SHINE', shop: 'time-lab', category: 'trang-suc', price: 520000, listPrice: 650000, short: 'Vòng tay bạc, hạt bạc tròn đều, kiểu dáng dễ mở, mệnh Thổ.', desc: 'LUNA SHINE Bracelet với 10 hạt bạc tròn 6mm. Dây bạc 925 vắt qua. Khóa an toàn dễ mở. Phù hợp nam nữ.', attrs: { brand: 'LUNA SHINE', material2: 'Bạc 925', origin: 'Việt Nam', warranty: 'Bảo hành 12 tháng' }, axes: [{ attr: 'color2', values: ['Bạc'] }], sold: 610, tags: ['sale'], img: { emoji: '💍', theme: 'mint', emoji2: '🌙', query: 'silver bead bracelet' } },
    { slug: 'nhan-do-i-aurora-gems', name: 'Nhẫn đôi AURORA GEMS', shop: 'time-lab', category: 'trang-suc', price: 1450000, short: 'Nhẫn đôi bạc, khắc tên, quà tặng cặp đôi lãng mạn.', desc: 'AURORA GEMS Couple Ring Set với 2 nhẫn bạc 925 độ từng cái 1 viên đá màu. Có thể khắc tên miễn phí. Kèm hộp quà sang trọng.', attrs: { brand: 'AURORA GEMS', material2: 'Bạc 925', origin: 'Hàn Quốc', warranty: 'Bảo hành trọn đời' }, axes: [{ attr: 'color2', values: ['Xanh', 'Hồng'] }], sold: 180, isNew: true, tags: ['new'], img: { emoji: '💍', theme: 'rose', emoji2: '💕', query: 'couple rings' } },
    { slug: 'tui-khuy-tai-bac-silvergem', name: 'Tụi khuy tai bạc SILVERGEM', shop: 'time-lab', category: 'trang-suc', price: 380000, short: 'Khuy tai bạc 925, hình hoa, bông tai nữ thanh lịch, tinh tế.', attrs: { brand: 'SILVERGEM', material2: 'Bạc 925', origin: 'Việt Nam', warranty: 'Bảo hành 12 tháng' }, axes: [{ attr: 'color2', values: ['Bạc'] }], sold: 720, img: { emoji: '💍', theme: 'rose', emoji2: '✨', query: 'silver earrings' } },
    { slug: 'vong-tay-charm-artisan-craft', name: 'Vòng tay Charm ARTISAN CRAFT', shop: 'time-lab', category: 'trang-suc', price: 890000, short: 'Vòng tay bạc Charm, mỗi hạt ghi một câu chuyện, phụ kiện thời trang nữa.', desc: 'ARTISAN CRAFT Charm Bracelet với dây bạc 925 độ 19cm, kèm 5 hạt charm bạc khác hình dạng (tuyết, trái tim, ngôi sao, lá, quả bóng). Hạt có thể tháo lắp để tùy chỉnh.', attrs: { brand: 'ARTISAN CRAFT', material2: 'Bạc 925', origin: 'Việt Nam', warranty: 'Bảo hành 12 tháng' }, axes: [{ attr: 'color2', values: ['Bạc'] }], sold: 410, featured: true, img: { emoji: '💍', theme: 'fuchsia', emoji2: '💫', query: 'charm bracelet' } },
    { slug: 'dau-khoa-tay-luna-shine', name: 'Dâu khóa tay LUNA SHINE', shop: 'time-lab', category: 'trang-suc', price: 450000, short: 'Dâu khóa tay bạc, trang trí hoa văn, đủ dài thoải mái đeo.', attrs: { brand: 'LUNA SHINE', material2: 'Bạc 925', chain_length: '40cm', origin: 'Hàn Quốc' }, axes: [{ attr: 'color2', values: ['Bạc'] }], sold: 550, img: { emoji: '💍', theme: 'indigo', emoji2: '🔐', query: 'silver anklet' } },
    { slug: 'nhan-theo-bac-aurora-gems-trend', name: 'Nhẫn theo bạc AURORA GEMS Trend', shop: 'time-lab', category: 'trang-suc', price: 280000, listPrice: 380000, short: 'Nhẫn theo bạc, thiết kế hiện đại, mix-match dễ, giá rẻ.', attrs: { brand: 'AURORA GEMS', material2: 'Bạc 925', origin: 'Việt Nam' }, axes: [{ attr: 'color2', values: ['Bạc'] }], sold: 920, tags: ['sale'], img: { emoji: '💍', theme: 'violet', emoji2: '💎', query: 'silver rings' } },
  ],
};

export default dept;
