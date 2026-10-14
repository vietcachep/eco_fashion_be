/*
 * Ngành gốc "Thú cưng" — thức ăn, đồ chơi, phụ kiện chăm sóc cho chó, mèo và các loài vật nuôi.
 */
import type { DeptSeed } from '../types';

const dept: DeptSeed = {
  slug: 'thu-cung',
  name: 'Thú cưng',
  description: 'Thức ăn, đồ chơi, phụ kiện và dụng cụ chăm sóc cho chó, mèo, chim, cá và các loài vật nuôi',
  sortOrder: 120,
  icon: '🐶',
  theme: 'teal',
  attributes: [
    { code: 'brand', name: 'Thương hiệu', inputType: 'select', values: ['Pet Care Pro', 'Happy Paws', 'Nutri Pet', 'Pure Life Pets', 'PawsGold', 'SmartPet', 'FurFresh', 'VetCare', 'TailsUp', 'PetNutrition'] },
    { code: 'pet_type', name: 'Loại thú cưng', inputType: 'select', values: ['Chó', 'Mèo', 'Chó & Mèo', 'Chim', 'Cá'] },
    { code: 'pet_age', name: 'Tuổi thú cưng', inputType: 'select', values: ['Con', 'Trưởng thành', 'Lão', 'Mọi lứa tuổi'] },
    { code: 'net_weight', name: 'Khối lượng', inputType: 'select', values: ['50g', '100g', '200g', '400g', '500g', '1kg', '1.5kg', '2kg', '5kg', '10kg', '15kg'] },
    { code: 'ingredient', name: 'Thành phần chính', inputType: 'text' },
    { code: 'material2', name: 'Chất liệu', inputType: 'select', values: ['Nhựa', 'Kim loại', 'Inox 304', 'Thép không gỉ', 'Gỗ tự nhiên', 'Gỗ công nghiệp', 'Da PU', 'Da thật', 'Vải canvas', 'Vải cotton', 'Thủy tinh', 'Gốm sứ', 'Silicone', 'Nylon', 'Polyester', 'Lưới thoáng khí', 'Sợi carbon', 'Hợp kim nhôm', 'Cao su', 'Tre', 'Mây tre đan', 'Vải', 'Lông'] },
  ],
  categories: [
    {
      slug: 'thuc-an-thu-cung', name: 'Thức ăn thú cưng', description: 'Thức ăn khô, ướt, đóng hộp, thức ăn chuyên biệt cho chó mèo', sortOrder: 121, icon: '🦴', theme: 'coral',
      attrs: [
        { code: 'brand', required: true },
        { code: 'pet_type', required: true },
        { code: 'pet_age' },
        { code: 'net_weight', required: true, axis: true },
        { code: 'ingredient', required: true },
        { code: 'origin' },
      ],
    },
    {
      slug: 'phu-kien-do-choi-thu-cung', name: 'Phụ kiện & Đồ chơi', description: 'Vòng cổ, dây dắt, võng, nhà nuôi, đồ chơi kích thích, xương cắn', sortOrder: 122, icon: '🎾', theme: 'rose',
      attrs: [
        { code: 'brand' },
        { code: 'pet_type', required: true },
        { code: 'color2' },
        { code: 'material2' },
        { code: 'origin' },
      ],
    },
    {
      slug: 've-sinh-cham-soc-thu-cung', name: 'Vệ sinh & Chăm sóc', description: 'Dầu gội, sữa tắm, bàn chải, cặp cắn, thuốc nhỏ tai, lót chuồng', sortOrder: 123, icon: '🧼', theme: 'mint',
      attrs: [
        { code: 'brand' },
        { code: 'pet_type', required: true },
        { code: 'origin' },
        { code: 'warranty' },
        { code: 'color2' },
        { code: 'material2' },
      ],
    },
  ],
  products: [
    // ---- THUC-AN-THU-CUNG (Pet Food) ----
    { slug: 'thuc-an-cho-smart-meal', name: 'Thức ăn chó Smart Meal', shop: 'pet-world', category: 'thuc-an-thu-cung', price: 185000, listPrice: 225000, short: 'Thức ăn khô chó, cân bằng dinh dưỡng, lông mượt, cơ khoẻ.', desc: 'Thức ăn chó Smart Meal chứa protein cao, khoáng chất đầy đủ, giúp chó mạnh khỏe, lông bóng mượt, tiêu hóa tốt. Phù hợp cho chó trưởng thành mọi kích thước.', attrs: { brand: 'SmartPet', pet_type: 'Chó', pet_age: 'Trưởng thành', ingredient: 'Thịt gia cầm, gạo, rau quả', origin: 'Trung Quốc' }, axes: [{ attr: 'net_weight', values: ['1kg', { v: '5kg', delta: 280000 }] }], sold: 840, featured: true, tags: ['sale'], img: { emoji: '🦴', theme: 'coral', emoji2: '🐕', query: 'dog food kibble' } },
    { slug: 'thuc-an-cho-puppy-nutri', name: 'Thức ăn chó con Nutri Pet', shop: 'pet-world', category: 'thuc-an-thu-cung', price: 156000, short: 'Thức ăn chó con, giàu DHA, phát triển não, xương chắc.', attrs: { brand: 'Nutri Pet', pet_type: 'Chó', pet_age: 'Con', ingredient: 'Thịt cá, yến mạch, dầu cá', origin: 'Trung Quốc' }, axes: [{ attr: 'net_weight', values: ['400g', { v: '2kg', delta: 320000 }] }], sold: 520, isNew: true, tags: ['new'], img: { emoji: '🐶', theme: 'rose', emoji2: '👶', query: 'puppy food' } },
    { slug: 'thuc-an-cho-lao-healthylife', name: 'Thức ăn chó già Healthy Life', shop: 'pet-world', category: 'thuc-an-thu-cung', price: 142000, listPrice: 178000, short: 'Cho chó lão, cơ mềm, tiêu hóa dễ, khớp khoẻ.', attrs: { brand: 'Pure Life Pets', pet_type: 'Chó', pet_age: 'Lão', ingredient: 'Thịt bò, gạo mền, glucosamine', origin: 'Thái Lan' }, axes: [{ attr: 'net_weight', values: ['1kg', { v: '5kg', delta: 300000 }] }], sold: 310, tags: ['sale'], img: { emoji: '👴', theme: 'sand', emoji2: '🐕', query: 'senior dog food' } },
    { slug: 'thuc-an-meo-hairball', name: 'Thức ăn mèo Hair Ball Care', shop: 'pet-world', category: 'thuc-an-thu-cung', price: 128000, short: 'Mèo trưởng thành, giảm búi lông, tiêu hóa tốt, lông sáng.', attrs: { brand: 'Pet Care Pro', pet_type: 'Mèo', pet_age: 'Trưởng thành', ingredient: 'Thịt cá, tôm, chất xơ', origin: 'Trung Quốc' }, axes: [{ attr: 'net_weight', values: ['500g', { v: '2kg', delta: 250000 }] }], sold: 1100, img: { emoji: '🐱', theme: 'violet', emoji2: '✨', query: 'cat hairball food' } },
    { slug: 'thuc-an-meo-con-momscare', name: 'Thức ăn mèo con Mom\'s Care', shop: 'pet-world', category: 'thuc-an-thu-cung', price: 112000, listPrice: 139000, short: 'Mèo con 2-12 tháng, xương chắc, não phát triển, miễn dịch tốt.', attrs: { brand: 'FurFresh', pet_type: 'Mèo', pet_age: 'Con', ingredient: 'Thịt gà, cá biển, sữa', origin: 'Trung Quốc' }, axes: [{ attr: 'net_weight', values: ['400g', { v: '1.5kg', delta: 180000 }] }], sold: 780, featured: true, tags: ['sale'], img: { emoji: '🐱', theme: 'fuchsia', emoji2: '👶', query: 'kitten formula' } },
    { slug: 'thuc-an-chung-vat-nuoi-balanced', name: 'Thức ăn chung chó mèo Balanced', shop: 'pet-world', category: 'thuc-an-thu-cung', price: 98000, short: 'Thích hợp chó lẫn mèo trưởng thành, cân bằng tâm lý.', attrs: { brand: 'Happy Paws', pet_type: 'Chó & Mèo', pet_age: 'Trưởng thành', ingredient: 'Thịt gia cầm, cá, rau quả', origin: 'Việt Nam' }, axes: [{ attr: 'net_weight', values: ['500g', { v: '2kg', delta: 180000 }] }], sold: 620, img: { emoji: '🐕', theme: 'teal', emoji2: '🐱', query: 'mixed pet food' } },
    { slug: 'thuc-an-ca-canh-premium', name: 'Thức ăn cá cảnh Premium', shop: 'pet-world', category: 'thuc-an-thu-cung', price: 68000, short: 'Cá cảnh, tôm, cua nhỏ, kích sắc màu, ích gây sinh sản.', attrs: { brand: 'VetCare', pet_type: 'Cá', ingredient: 'Tôm, cua, tảo', origin: 'Thái Lan' }, axes: [{ attr: 'net_weight', values: ['50g', { v: '100g', delta: 35000 }] }], sold: 420, isNew: true, tags: ['new'], img: { emoji: '🐟', theme: 'sky', emoji2: '🌈', query: 'fish food flakes' } },
    { slug: 'xa-lon-pate-cho-meo', name: 'Xà lộn pâté cho chó mèo', shop: 'pet-world', category: 'thuc-an-thu-cung', price: 45000, listPrice: 55000, short: 'Hộp nhỏ pâté, thịt tươi, dễ tiêu, ngon miệng.', attrs: { brand: 'TailsUp', pet_type: 'Chó & Mèo', pet_age: 'Mọi lứa tuổi', ingredient: 'Thịt bò, thịt cá', origin: 'Trung Quốc' }, axes: [{ attr: 'net_weight', values: ['100g', { v: '200g', delta: 38000 }] }], sold: 950, tags: ['sale'], img: { emoji: '🍖', theme: 'coral', emoji2: '🐾', query: 'pet pate can' } },
    { slug: 'snack-thuong-cho-cheo', name: 'Snack thưởng chó Cheo', shop: 'pet-world', category: 'thuc-an-thu-cung', price: 78000, short: 'Xương cắn chế biến, cứng vừa, tăng chân rắc dành cắn.', attrs: { brand: 'PawsGold', pet_type: 'Chó', ingredient: 'Thịt chế biến, canxi', origin: 'Trung Quốc' }, axes: [{ attr: 'net_weight', values: ['200g', { v: '500g', delta: 120000 }] }], sold: 680, img: { emoji: '🦴', theme: 'brown', emoji2: '😋', query: 'dog chew treats' } },

    // ---- PHU-KIEN-DO-CHOI-THU-CUNG (Accessories & Toys) ----
    { slug: 'day-dak-thu-cung-nylon', name: 'Dây dắt thú cưng Nylon', shop: 'pet-world', category: 'phu-kien-do-choi-thu-cung', price: 55000, listPrice: 69000, short: 'Dây dắt chó mèo, dù chắc, lỗ thoát nước, thoải mái.', attrs: { brand: 'Happy Paws', pet_type: 'Chó & Mèo', color2: 'Đen', material2: 'Nylon', origin: 'Trung Quốc' }, sold: 1420, tags: ['sale'], img: { emoji: '🐕', theme: 'slate', emoji2: '🪢', query: 'dog leash rope' } },
    { slug: 'vong-co-thu-cung-luminous', name: 'Vòng cổ thú cưng phát sáng', shop: 'pet-world', category: 'phu-kien-do-choi-thu-cung', price: 48000, short: 'Vòng cổ LED, sạc USB, an toàn ban đêm, có tên thú cưng.', attrs: { brand: 'TailsUp', pet_type: 'Chó & Mèo', color2: 'Xanh', material2: 'Silicone', origin: 'Trung Quốc' }, sold: 780, isNew: true, tags: ['new'], img: { emoji: '💡', theme: 'indigo', emoji2: '🐶', query: 'led dog collar' } },
    { slug: 'do-choi-banh-tennis-meo-cho', name: 'Đồ chơi bóng tennis chó mèo', shop: 'pet-world', category: 'phu-kien-do-choi-thu-cung', price: 32000, listPrice: 42000, short: 'Bóng tennis kích thích chơi, đàn hồi tốt, an toàn.', attrs: { brand: 'Pet Care Pro', pet_type: 'Chó & Mèo', color2: 'Vàng', material2: 'Vải', origin: 'Trung Quốc' }, sold: 2100, featured: true, tags: ['sale'], img: { emoji: '🎾', theme: 'lime', emoji2: '🐕', query: 'tennis ball dog toy' } },
    { slug: 'do-choi-chuot-cho-meo', name: 'Đồ chơi chuột vệ sinh cho mèo', shop: 'pet-world', category: 'phu-kien-do-choi-thu-cung', price: 28000, short: 'Chuột vải, giã chuông, kích thích thú tính mèo.', attrs: { brand: 'FurFresh', pet_type: 'Mèo', color2: 'Xám', material2: 'Vải', origin: 'Trung Quốc' }, sold: 1580, img: { emoji: '🐭', theme: 'rose', emoji2: '🐱', query: 'cat mouse toy' } },
    { slug: 'nha-thau-cho-meo-hang-khong', name: 'Nhà thau chó mèo hạng không', shop: 'pet-world', category: 'phu-kien-do-choi-thu-cung', price: 185000, listPrice: 235000, short: 'Nhà hơi nở, nhẹ, dễ vận chuyển, mát thoáng.', attrs: { brand: 'Nutri Pet', pet_type: 'Chó & Mèo', color2: 'Xanh', material2: 'Nylon', origin: 'Trung Quốc' }, sold: 310, tags: ['sale'], img: { emoji: '🏠', theme: 'sky', emoji2: '✈️', query: 'portable pet house' } },
    { slug: 'sac-lap-vo-thu-cung', name: 'Sạc lắp võ thú cưng', shop: 'pet-world', category: 'phu-kien-do-choi-thu-cung', price: 95000, short: 'Đồ chơi kéo giật thú cưng, rope cotton, bền lâu.', attrs: { brand: 'Pure Life Pets', pet_type: 'Chó', color2: 'Đỏ', material2: 'Vải cotton', origin: 'Trung Quốc' }, sold: 520, img: { emoji: '🧵', theme: 'coral', emoji2: '🦴', query: 'tug rope toy' } },
    { slug: 'nhu-cau-truong-1m-xin', name: 'Nhu cầu trường 1m cho chó mèo', shop: 'pet-world', category: 'phu-kien-do-choi-thu-cung', price: 62000, short: 'Nhu cầu dài, kích thích chơi, dự phòng chạy lạc.', attrs: { brand: 'Happy Paws', pet_type: 'Chó & Mèo', color2: 'Đen', material2: 'Nylon', origin: 'Trung Quốc' }, sold: 720, img: { emoji: '🪢', theme: 'slate', emoji2: '🐕', query: 'retractable leash' } },
    { slug: 'giam-ap-thuy-tinh-cho-meo', name: 'Giàn áp thủy tinh cho mèo', shop: 'pet-world', category: 'phu-kien-do-choi-thu-cung', price: 145000, short: 'Giàn cây cao, mèo trèo cào, thư giãn thoải mái.', attrs: { brand: 'VetCare', pet_type: 'Mèo', color2: 'Be', material2: 'Gỗ tự nhiên', origin: 'Trung Quốc' }, sold: 280, featured: true, img: { emoji: '🌳', theme: 'emerald', emoji2: '🐱', query: 'cat tree condo' } },

    // ---- VE-SINH-CHAM-SOC-THU-CUNG (Grooming & Care) ----
    { slug: 'dau-goi-cho-truong-long', name: 'Dầu gội chó tóc dài', shop: 'pet-world', category: 've-sinh-cham-soc-thu-cung', price: 118000, listPrice: 148000, short: 'Dầu gội chó, lông mượt, không rối, thơm tự nhiên.', desc: 'Dầu gội chó chuyên cho lông dài, công thức nhẹ nhàng, không chứa chất hóa học mạnh, giúp lông mượt mềm, thơm lâu, mát da đầu.', attrs: { brand: 'Pet Care Pro', pet_type: 'Chó', origin: 'Thái Lan', warranty: 'Bảo hành 18 tháng' }, sold: 420, tags: ['sale'], img: { emoji: '🧴', theme: 'coral', emoji2: '🧴', query: 'dog shampoo' } },
    { slug: 'sua-tam-meo-tranh-ve', name: 'Sữa tắm mèo chống ve', shop: 'pet-world', category: 've-sinh-cham-soc-thu-cung', price: 98000, short: 'Sữa tắm mèo, đuổi ve chấy, chứa tinh dầu tự nhiên.', attrs: { brand: 'FurFresh', pet_type: 'Mèo', origin: 'Việt Nam', warranty: '12 tháng' }, sold: 620, img: { emoji: '🧴', theme: 'mint', emoji2: '🐱', query: 'cat flea shampoo' } },
    { slug: 'ban-chai-lot-long-thu-cung', name: 'Bàn chải lót lông thú cưng', shop: 'pet-world', category: 've-sinh-cham-soc-thu-cung', price: 72000, listPrice: 89000, short: 'Chải lông chó mèo, tránh rơi, thoải mái, an toàn.', attrs: { brand: 'TailsUp', pet_type: 'Chó & Mèo', color2: 'Xanh', material2: 'Nhựa', origin: 'Trung Quốc' }, sold: 1840, featured: true, tags: ['sale'], img: { emoji: '🪮', theme: 'rose', emoji2: '✨', query: 'pet grooming brush' } },
    { slug: 'nhot-nho-tai-cho-meo-ve-sinh', name: 'Nhỏ nhó tai cho mèo vệ sinh', shop: 'pet-world', category: 've-sinh-cham-soc-thu-cung', price: 65000, short: 'Huyết thanh nhỏ tai, sạch tai, hết ngứa, thơm.', attrs: { brand: 'VetCare', pet_type: 'Mèo', origin: 'Thái Lan', warranty: '12 tháng' }, sold: 410, img: { emoji: '👂', theme: 'teal', emoji2: '🧴', query: 'cat ear cleaner' } },
    { slug: 'giuong-thu-cung-len-goi', name: 'Giường thú cưng lông gối', shop: 'pet-world', category: 've-sinh-cham-soc-thu-cung', price: 155000, listPrice: 195000, short: 'Giường lót lông mềm, nóng áp, ngủ thoải mái.', attrs: { brand: 'Nutri Pet', pet_type: 'Chó & Mèo', color2: 'Be', material2: 'Lông', origin: 'Trung Quốc' }, sold: 280, featured: true, tags: ['sale'], img: { emoji: '🛏️', theme: 'brown', emoji2: '😴', query: 'pet bed cushion' } },
    { slug: 'nuoi-chu-canh-10l-cat-litter', name: 'Cát vệ sinh mèo 10L', shop: 'pet-world', category: 've-sinh-cham-soc-thu-cung', price: 85000, short: 'Cát bentonite, cắt bụi ít, keo cơm, hút ẩm tốt.', attrs: { brand: 'Pure Life Pets', pet_type: 'Mèo', origin: 'Trung Quốc', warranty: '24 tháng bảo hành chất lượng' }, sold: 1520, img: { emoji: '🚽', theme: 'amber', emoji2: '💨', query: 'cat litter 10l' } },
  ],
};

export default dept;
