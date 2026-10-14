/*
 * Ngành gốc "Mẹ & Bé" — Track D (PLAN-0017). Bắt chước khuôn `dien-thoai-phu-kien.ts` (đọc file đó trước).
 * Shop: baby-land (shop chính chủ cho ngành này).
 */
import type { DeptSeed } from '../types';

const dept: DeptSeed = {
  slug: 'me-be',
  name: 'Mẹ & Bé',
  description: 'Sữa, tã, đồ chơi, xe đẩy, quần áo trẻ em, dụng cụ chăm sóc bé',
  sortOrder: 500,
  icon: '🧸',
  theme: 'mint',
  attributes: [
    { code: 'brand', name: 'Thương hiệu', inputType: 'select', values: ['NutriBaby', 'LoveLittle', 'BabyPro', 'SmileCare', 'LittleZen', 'SafeBaby', 'CozyBaby', 'MagicMoment', 'PureJoy', 'TinyTown'] },
    { code: 'pack_size', name: 'Kích thước gói', inputType: 'select', values: ['Gói nhỏ (10-30)', 'Gói vừa (30-50)', 'Gói lớn (50-70)', 'Gói cực lớn (70+)'] },
    { code: 'age_group', name: 'Nhóm tuổi', inputType: 'select', values: ['0-6 tháng', '6-12 tháng', '1-3 tuổi', '3-6 tuổi', '6+ tuổi'] },
    { code: 'material2', name: 'Chất liệu', inputType: 'select', values: ['Cotton 100%', 'Organic cotton', 'Bamboo', 'Polyester', 'Thương mại', 'Nhựa an toàn'] },
  ],
  categories: [
    {
      slug: 'sua-ta-be',
      name: 'Sữa & Tã bé',
      description: 'Sữa công thức, sữa bột, tã giấy, lót tã cho trẻ sơ sinh',
      sortOrder: 501,
      icon: '🍼',
      theme: 'rose',
      attrs: [
        { code: 'brand', required: true },
        { code: 'pack_size', required: true, axis: true },
        { code: 'age_group', required: true },
        { code: 'origin' },
        { code: 'warranty' },
      ],
    },
    {
      slug: 'do-choi-tre-em',
      name: 'Đồ chơi trẻ em',
      description: 'Gấu bông, tòa nhà, xe, xếp hình, đồ chơi an toàn có chứng chỉ',
      sortOrder: 502,
      icon: '🎲',
      theme: 'fuchsia',
      attrs: [
        { code: 'age_group', required: true, axis: true },
        { code: 'brand' },
        { code: 'material2' },
      ],
    },
    {
      slug: 'xe-day-ghe-an-di-choi',
      name: 'Xe đẩy & Ghế ăn',
      description: 'Xe đẩy, xe 4 bánh, ghế ăn, nôi, ghế ngồi ô tô cho bé',
      sortOrder: 503,
      icon: '🚼',
      theme: 'sky',
      attrs: [
        { code: 'brand', required: true },
        { code: 'color2', axis: true },
        { code: 'material2' },
        { code: 'origin' },
        { code: 'warranty' },
      ],
    },
    {
      slug: 'quan-ao-so-sinh',
      name: 'Quần áo sơ sinh & Bé nhỏ',
      description: 'Bodysuit, quần áo ngủ, set quần áo, tất, nón cho trẻ 0-6 tuổi',
      sortOrder: 504,
      icon: '👶',
      theme: 'coral',
      attrs: [
        { code: 'age_group', required: true },
        { code: 'color2', required: true, axis: true },
        { code: 'brand', required: true },
        { code: 'material2' },
      ],
    },
  ],
  products: [
    // ---- Sữa & Tã bé ----
    { slug: 'sua-bot-nutribaby-so-1-600g', name: 'Sữa bột NutriBaby số 1 - 600g', shop: 'baby-land', category: 'sua-ta-be', price: 680000, listPrice: 820000, short: 'Sữa cho trẻ 0-6 tháng, chứa DHA, HMO giúp miễn dịch.', desc: 'Sữa công thức NutriBaby số 1 dành cho trẻ 0-6 tháng tuổi: cân bằng DHA, HMO, vitamin D giúp phát triển não bộ và tăng cường miễn dịch. Không chứa đường sữa lactose cao, dễ tiêu hóa. Hộp 600g pha được 30 bữa ăn.', attrs: { brand: 'NutriBaby', age_group: '0-6 tháng', origin: 'Việt Nam', warranty: '24 tháng' }, axes: [{ attr: 'pack_size', values: ['Gói nhỏ (10-30)'] }], sold: 1240, featured: true, tags: ['sale'], img: { emoji: '🍼', theme: 'rose', emoji2: '👶', query: 'infant formula milk' } },
    { slug: 'sua-bot-nutribaby-so-2-600g', name: 'Sữa bột NutriBaby số 2 - 600g', shop: 'baby-land', category: 'sua-ta-be', price: 720000, short: 'Sữa cho trẻ 6-12 tháng, giàu canxi, sắt, đủ dinh dưỡng phát triển.', attrs: { brand: 'NutriBaby', age_group: '6-12 tháng', origin: 'Việt Nam', warranty: '24 tháng' }, axes: [{ attr: 'pack_size', values: ['Gói vừa (30-50)'] }], sold: 980, tags: ['sale'], img: { emoji: '🍼', theme: 'rose', emoji2: '📈', query: 'baby formula 6 months' } },
    { slug: 'sua-bot-lovelit-so-3-800g', name: 'Sữa bột LoveLittle số 3 - 800g', shop: 'baby-land', category: 'sua-ta-be', price: 890000, listPrice: 1090000, short: 'Sữa cho bé 1-3 tuổi, tăng cường sự phát triển, công thức mới.', attrs: { brand: 'LoveLittle', age_group: '1-3 tuổi', origin: 'Hàn Quốc', warranty: '24 tháng' }, axes: [{ attr: 'pack_size', values: ['Gói lớn (50-70)'] }], sold: 650, isNew: true, tags: ['new', 'sale'], img: { emoji: '🥛', theme: 'coral', emoji2: '✨', query: 'toddler milk powder' } },
    { slug: 'ta-dieu-babypro-size-s-60-mieng', name: 'Tã dán BabyPro Size S - 60 miếng', shop: 'baby-land', category: 'sua-ta-be', price: 320000, listPrice: 420000, short: 'Tã dán Size S (3-8kg) cho trẻ 0-6 tháng, lõi siêu thấm, thay dễ dàng.', attrs: { brand: 'BabyPro', age_group: '0-6 tháng', origin: 'Thái Lan', warranty: 'Hạn dùng' }, axes: [{ attr: 'pack_size', values: ['Gói nhỏ (10-30)'] }], sold: 2100, featured: true, tags: ['sale'], img: { emoji: '👶', theme: 'mint', emoji2: '💧', query: 'baby diapers newborn' } },
    { slug: 'ta-dieu-babypro-size-m-50-mieng', name: 'Tã dán BabyPro Size M - 50 miếng', shop: 'baby-land', category: 'sua-ta-be', price: 380000, short: 'Tã dán Size M (6-12kg) cho trẻ 6-12 tháng, mềm an toàn da.', attrs: { brand: 'BabyPro', age_group: '6-12 tháng', origin: 'Thái Lan', warranty: 'Hạn dùng' }, axes: [{ attr: 'pack_size', values: ['Gói vừa (30-50)'] }], sold: 1650, tags: ['sale'], img: { emoji: '👶', theme: 'mint', emoji2: '💜', query: 'baby diapers medium' } },
    { slug: 'ta-dieu-safebaby-size-l-40-mieng', name: 'Tã dán SafeBaby Size L - 40 miếng', shop: 'baby-land', category: 'sua-ta-be', price: 420000, listPrice: 550000, short: 'Tã dán Size L (10-16kg) cho trẻ 1-3 tuổi, lối thoáng khí tốt.', attrs: { brand: 'SafeBaby', age_group: '1-3 tuổi', origin: 'Việt Nam', warranty: 'Hạn dùng' }, axes: [{ attr: 'pack_size', values: ['Gói vừa (30-50)'] }], sold: 980, tags: ['sale'], img: { emoji: '👶', theme: 'mint', emoji2: '🟨', query: 'baby diapers large' } },
    { slug: 'lot-ta-bamboo-babypro-100-mieng', name: 'Lót tã Bamboo BabyPro 100 miếng', shop: 'baby-land', category: 'sua-ta-be', price: 240000, short: 'Lót tã bamboo mỏng, thấm nhanh, an toàn da, khử mùi tự nhiên.', attrs: { brand: 'BabyPro', age_group: '0-6 tháng', origin: 'Trung Quốc', warranty: 'Hạn dùng' }, axes: [{ attr: 'pack_size', values: ['Gói lớn (50-70)'] }], sold: 1420, img: { emoji: '🍃', theme: 'emerald', emoji2: '💚', query: 'bamboo diaper liners' } },

    // ---- Đồ chơi trẻ em ----
    { slug: 'gau-bong-cozy-baby-40cm', name: 'Gấu bông Cozy Baby cao 40cm', shop: 'baby-land', category: 'do-choi-tre-em', price: 280000, listPrice: 380000, short: 'Gấu bông mềm, an toàn cho trẻ, chất cotton lạnh.', desc: 'Gấu bông CozyBaby kích thước 40cm: vải cotton 100% mềm mại, lũ bông polyester thực dàn bao, an toàn cho bé từ 0+ tuổi, rửa được. Chứng chỉ CE an toàn.', attrs: { brand: 'CozyBaby', material2: 'Cotton 100%' }, axes: [{ attr: 'age_group', values: ['0-6 tháng'] }], sold: 890, featured: true, tags: ['sale'], img: { emoji: '🧸', theme: 'fuchsia', emoji2: '🤎', query: 'stuffed teddy bear' } },
    { slug: 'toa-hinh-khoi-bao-set-36-mieng', name: 'Tòa hình khối bao nylon 36 miếng', shop: 'baby-land', category: 'do-choi-tre-em', price: 320000, short: 'Bộ 36 khối xếp hình, an toàn độc hại, phát triển tư duy không gian.', attrs: { brand: 'SmileCare', material2: 'Nhựa an toàn' }, axes: [{ attr: 'age_group', values: ['1-3 tuổi'] }], sold: 650, img: { emoji: '🧱', theme: 'coral', emoji2: '🎨', query: 'building blocks toys' } },
    { slug: 'xe-dia-playskool-mini-4-chiec', name: 'Xe địa hình PlayTown 4 chiếc', shop: 'baby-land', category: 'do-choi-tre-em', price: 180000, listPrice: 260000, short: '4 xe 4 màu, bánh quay, vật liệu nhựa an toàn không chứa BPA.', attrs: { brand: 'TinyTown', material2: 'Nhựa an toàn' }, axes: [{ attr: 'age_group', values: ['1-3 tuổi'] }], sold: 1200, featured: true, tags: ['sale'], img: { emoji: '🚗', theme: 'orange', emoji2: '🏎️', query: 'toy cars set' } },
    { slug: 'xep-hinh-jigsaw-50-mieng-hinata', name: 'Xếp hình Jigsaw 50 miếng mảnh', shop: 'baby-land', category: 'do-choi-tre-em', price: 150000, short: 'Xếp hình 50 miếng, tranh động vật, phát triển tư duy logic trẻ.', attrs: { brand: 'PureJoy', material2: 'Nhựa' }, axes: [{ attr: 'age_group', values: ['3-6 tuổi'] }], sold: 520, img: { emoji: '🧩', theme: 'sky', emoji2: '🦁', query: 'jigsaw puzzle' } },
    { slug: 'may-choi-nhac-bang-len', name: 'Máy chơi nhạc bằng lên cho bé', shop: 'baby-land', category: 'do-choi-tre-em', price: 210000, listPrice: 310000, short: '5 phím piano, nhạc vui nhộn, khuyến khích sáng tạo âm nhạc.', attrs: { brand: 'MagicMoment', material2: 'Nhựa an toàn' }, axes: [{ attr: 'age_group', values: ['1-3 tuổi'] }], sold: 750, tags: ['sale'], img: { emoji: '🎹', theme: 'indigo', emoji2: '🎵', query: 'baby piano toy' } },
    { slug: 'tro-chuot-rung-luon-little-zen', name: 'Rô-bốt rung lợn LittleZen cho bé', shop: 'baby-land', category: 'do-choi-tre-em', price: 240000, short: 'Rô-bốt rung, phát âm thanh vui, chạy bộ nhanh, phát triển vận động.', attrs: { brand: 'LittleZen', material2: 'Nhựa an toàn' }, axes: [{ attr: 'age_group', values: ['1-3 tuổi'] }], sold: 620, img: { emoji: '🐷', theme: 'rose', emoji2: '🏃', query: 'baby crawling toy' } },

    // ---- Xe đẩy & Ghế ăn ----
    { slug: 'xe-day-3-chiec-babygo-foldable', name: 'Xe đẩy 3 chiếc BabyGo gấp gọn', shop: 'baby-land', category: 'xe-day-ghe-an-di-choi', price: 2480000, listPrice: 3180000, short: 'Xe đẩy, nôi và ghế an toàn ô tô kết hợp, gấp 1 bước, nhẹ 7kg.', desc: 'Bộ xe 3 chiếc BabyGo: xe đẩy khung nhẹ nhôm, nôi giữ nhiệt tốt, ghế ô tô certified ISO. Dễ gập, chứa trong xe hơi, bánh khác 360°. Phù hợp trẻ 0-3 tuổi.', attrs: { brand: 'BabyPro', material2: 'Hợp kim nhôm', origin: 'Trung Quốc' }, axes: [{ attr: 'color2', values: ['Xám', 'Đen'] }], sold: 340, featured: true, tags: ['sale'], img: { emoji: '🚼', theme: 'sky', emoji2: '👶', query: 'baby stroller 3 in 1' } },
    { slug: 'xe-day-babypro-3-banh-nhe', name: 'Xe đẩy BabyPro 3 bánh siêu nhẹ', shop: 'baby-land', category: 'xe-day-ghe-an-di-choi', price: 1580000, short: 'Xe đẩy 3 bánh khung nhẹ, gấp gọn dễ dàng, thích hợp xén ngoài.', attrs: { brand: 'BabyPro', material2: 'Hợp kim nhôm', origin: 'Trung Quốc' }, axes: [{ attr: 'color2', values: ['Đen', 'Xanh'] }], sold: 620, isNew: true, tags: ['new'], img: { emoji: '🚼', theme: 'navy', emoji2: '💨', query: 'lightweight stroller' } },
    { slug: 'ghe-an-babypro-cao-khong-dieu-chinh', name: 'Ghế ăn BabyPro 6 độ cao', shop: 'baby-land', category: 'xe-day-ghe-an-di-choi', price: 890000, listPrice: 1190000, short: 'Ghế ăn 6 độ cao, bàn tháo rời dễ rửa, an toàn cho bé 6 tháng+.', attrs: { brand: 'BabyPro', material2: 'Nhựa an toàn', warranty: '12 tháng' }, axes: [{ attr: 'color2', values: ['Xám', 'Trắng'] }], sold: 480, featured: true, tags: ['sale'], img: { emoji: '🪑', theme: 'slate', emoji2: '🥄', query: 'baby high chair' } },
    { slug: 'chiec-noi-di-choi-safebaby-portable', name: 'Chiếc nôi di động SafeBaby', shop: 'baby-land', category: 'xe-day-ghe-an-di-choi', price: 650000, short: 'Nôi du lịch gấp gọn, nệm mềm, khung chắc chắn, lưới thoáng mát.', attrs: { brand: 'SafeBaby', material2: 'Nylon', warranty: '12 tháng' }, axes: [{ attr: 'color2', values: ['Xanh', 'Hồng'] }], sold: 280, img: { emoji: '🛏️', theme: 'mint', emoji2: '🏠', query: 'portable baby crib' } },
    { slug: 'ghe-oto-babypro-isofix-0-18kg', name: 'Ghế ngồi ô tô BabyPro ISOFIX', shop: 'baby-land', category: 'xe-day-ghe-an-di-choi', price: 1890000, listPrice: 2490000, short: 'Ghế ô tô ISOFIX cho bé 0-18kg, xoay 360°, tỷ lệ rủi ro thấp.', desc: 'Ghế ô tô BabyPro chứng chỉ ECE R44/04: ISOFIX, xoay 360° dễ đặt bé, chỗ ngã 7 vị trí, dây an toàn 5 điểm. Phù hợp từ sơ sinh đến 18kg.', attrs: { brand: 'BabyPro', material2: 'Nhựa an toàn', warranty: '24 tháng' }, axes: [{ attr: 'color2', values: ['Xám', 'Đen'] }], sold: 420, featured: true, tags: ['sale'], img: { emoji: '🚗', theme: 'slate', emoji2: '👶', query: 'car seat child isofix' } },

    // ---- Quần áo sơ sinh ----
    { slug: 'body-ao-so-sinh-lovelit-5-mieng', name: 'Body áo sơ sinh LoveLittle - 5 miếng', shop: 'baby-land', category: 'quan-ao-so-sinh', price: 280000, listPrice: 380000, short: '5 body áo cotton 100%, dễ thay tã, lạnh mũi an toàn.', desc: 'Bộ 5 body áo LoveLittle dành cho trẻ sơ sinh: vải cotton organic 100%, mềm mại, an toàn da nhạy cảm. Cúc bấm toàn thân, dễ thay tã diaper, kèm 1 túi bảo vệ không dệt.', attrs: { brand: 'LoveLittle', material2: 'Organic cotton', age_group: '0-6 tháng' }, axes: [{ attr: 'color2', values: ['Trắng', 'Xanh'] }], sold: 1320, featured: true, tags: ['sale'], img: { emoji: '👶', theme: 'coral', emoji2: '🤍', query: 'baby bodysuit newborn' } },
    { slug: 'quan-tay-dai-so-sinh-babypro-3-canh', name: 'Quần tay dài sơ sinh BabyPro - 3 cái', shop: 'baby-land', category: 'quan-ao-so-sinh', price: 190000, short: 'Quần tay dài cotton cho bé 0-6 tháng, thoáng khí, dễ giặt.', attrs: { brand: 'BabyPro', material2: 'Cotton 100%', age_group: '0-6 tháng' }, axes: [{ attr: 'color2', values: ['Trắng', 'Vàng'] }], sold: 680, img: { emoji: '👖', theme: 'amber', emoji2: '👶', query: 'baby pants set' } },
    { slug: 'ao-khoac-mua-bebecot-2-tui', name: 'Áo khoác mưa Bebecot - 2 túi tiện', shop: 'baby-land', category: 'quan-ao-so-sinh', price: 320000, listPrice: 450000, short: 'Áo khoác cotton dễ thấm hút, túi chứa, 1-3 tuổi.', attrs: { brand: 'CozyBaby', material2: 'Cotton', age_group: '1-3 tuổi' }, axes: [{ attr: 'color2', values: ['Xanh', 'Hồng'] }], sold: 540, tags: ['sale'], img: { emoji: '🧥', theme: 'sky', emoji2: '☔', query: 'toddler jacket' } },
    { slug: 'ao-ngu-tang-lon-babypro-cotton-mua-he', name: 'Áo ngủ tăng lớn BabyPro cotton mùa hè', shop: 'baby-land', category: 'quan-ao-so-sinh', price: 150000, short: 'Áo ngủ khoảnh cotton, thoáng khí, thích hợp ngủ ngày hè.', attrs: { brand: 'BabyPro', material2: 'Cotton 100%', age_group: '0-6 tháng' }, axes: [{ attr: 'color2', values: ['Trắng', 'Be'] }], sold: 890, img: { emoji: '🌙', theme: 'amber', emoji2: '😴', query: 'baby sleep gown' } },
    { slug: 'tat-tre-em-safebaby-3-doi', name: 'Tất trẻ em SafeBaby - 3 đôi siêu dàn', shop: 'baby-land', category: 'quan-ao-so-sinh', price: 110000, short: '3 đôi tất cotton thoáng khí, không cục lồi, mút non an toàn.', attrs: { brand: 'SafeBaby', material2: 'Cotton 100%', age_group: '0-6 tháng' }, axes: [{ attr: 'color2', values: ['Trắng', 'Xanh'] }], sold: 1450, img: { emoji: '🧦', theme: 'mint', emoji2: '👶', query: 'baby socks' } },
    { slug: 'set-quan-ao-cho-be-gai-lovelit-full-set', name: 'Set quần áo bộ bé gái LoveLittle', shop: 'baby-land', category: 'quan-ao-so-sinh', price: 280000, listPrice: 380000, short: 'Set áo khoảch quần, 3 mảnh, họa tiết xinh xắn.', attrs: { brand: 'LoveLittle', material2: 'Cotton', age_group: '1-3 tuổi' }, axes: [{ attr: 'color2', values: ['Hồng', 'Xanh'] }], sold: 620, featured: true, tags: ['sale'], img: { emoji: '👗', theme: 'rose', emoji2: '👧', query: 'baby girl outfit' } },
    { slug: 'set-quan-ao-cho-be-trai-smilecare-full', name: 'Set quần áo bộ bé trai SmileCare', shop: 'baby-land', category: 'quan-ao-so-sinh', price: 270000, short: 'Set áo thun quần ngắn, 2 màu, thoáng khí mùa hè.', attrs: { brand: 'SmileCare', material2: 'Cotton', age_group: '1-3 tuổi' }, axes: [{ attr: 'color2', values: ['Xanh', 'Đen'] }], sold: 540, img: { emoji: '👕', theme: 'navy', emoji2: '👦', query: 'baby boy outfit' } },
  ],
};

export default dept;
