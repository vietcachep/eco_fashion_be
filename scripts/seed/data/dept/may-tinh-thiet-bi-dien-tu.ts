/*
 * Ngành gốc "Máy tính & Thiết bị điện tử" — Track D (PLAN-0017). Bắt chước khuôn `dien-thoai-phu-kien.ts`.
 * 28 sản phẩm trên 4 ngành lá: laptop, chuot-ban-phim, tai-nghe-loa, man-hinh-linh-kien.
 */
import type { DeptSeed } from '../types';

const dept: DeptSeed = {
  slug: 'may-tinh-thiet-bi-dien-tu',
  name: 'Máy tính & Thiết bị điện tử',
  description: 'Laptop, linh kiện, màn hình, chuột bàn phím, tai nghe, loa và thiết bị điện tử',
  sortOrder: 150,
  icon: '💻',
  theme: 'sky',
  attributes: [
    { code: 'brand', name: 'Thương hiệu', inputType: 'select', values: ['ProBook', 'EliteWire', 'TechMaster', 'SoundWave', 'TechVision', 'PowerLink', 'EliteKey', 'DualCore', 'CloudMax', 'VisionPro'] },
    { code: 'processor', name: 'Bộ xử lý', inputType: 'select', values: ['Intel Core i3', 'Intel Core i5', 'Intel Core i7', 'Intel Core i9', 'AMD Ryzen 3', 'AMD Ryzen 5', 'AMD Ryzen 7', 'Apple M1', 'Apple M2'] },
    { code: 'screen_resolution', name: 'Độ phân giải', inputType: 'select', values: ['1920x1080 (Full HD)', '2560x1440 (2K)', '2880x1800', '3840x2160 (4K)', '1366x768 (HD+)', '2560x1600'] },
    { code: 'panel_type', name: 'Loại bảng', inputType: 'select', values: ['IPS', 'VA', 'TN', 'OLED', 'Mini-LED'] },
    { code: 'connection_type', name: 'Loại kết nối', inputType: 'select', values: ['Wired USB', 'Wireless 2.4GHz', 'Bluetooth', 'Wired 3.5mm', 'USB-C', 'Dual Wireless', 'Lightning'] },
  ],
  categories: [
    {
      slug: 'laptop', name: 'Laptop', description: 'Laptop cho học tập, làm việc, chơi game', sortOrder: 151, icon: '💻', theme: 'indigo',
      attrs: [
        { code: 'color2', required: true, axis: true },
        { code: 'storage', required: true, axis: true },
        { code: 'brand', required: true },
        { code: 'processor', required: true },
        { code: 'ram', required: true },
        { code: 'origin' },
        { code: 'warranty' },
      ],
    },
    {
      slug: 'chuot-ban-phim', name: 'Chuột & Bàn phím', description: 'Chuột, bàn phím cơ và phụ kiện nhập liệu', sortOrder: 152, icon: '⌨️', theme: 'slate',
      attrs: [
        { code: 'connection_type', required: true, axis: true },
        { code: 'color2' },
        { code: 'brand' },
        { code: 'material2' },
        { code: 'origin' },
        { code: 'warranty' },
      ],
    },
    {
      slug: 'tai-nghe-loa', name: 'Tai nghe & Loa', description: 'Tai nghe gaming, loa ngoài, loa không dây', sortOrder: 153, icon: '🎧', theme: 'violet',
      attrs: [
        { code: 'color2', required: true, axis: true },
        { code: 'connection_type', required: true, axis: true },
        { code: 'brand' },
        { code: 'origin' },
        { code: 'warranty' },
      ],
    },
    {
      slug: 'man-hinh-linh-kien', name: 'Màn hình & Linh kiện', description: 'Màn hình máy tính, SSD, RAM, linh kiện khác', sortOrder: 154, icon: '🖥️', theme: 'teal',
      attrs: [
        { code: 'screen_resolution', axis: true },
        { code: 'panel_type', axis: true },
        { code: 'brand' },
        { code: 'origin' },
        { code: 'warranty' },
      ],
    },
  ],
  products: [
    // Laptop: 7 sản phẩm
    { slug: 'laptop-probook-elite-13', name: 'Laptop ProBook Elite 13', shop: 'techzone-vn', category: 'laptop', price: 16990000, listPrice: 18990000, short: 'i7 8 nhân, RAM 16GB, SSD 512GB, màn hình 13.3" 2K, pin 10 giờ, trọng lượng 1.2kg.', desc: 'ProBook Elite 13 là laptop ultrabook cho chuyên gia: CPU Intel Core i7 12th gen, RAM 16GB, SSD 512GB NVMe cực nhanh, màn hình IPS 13.3" 2K sắc nét, pin 60Wh sử dụng 10+ giờ, trọng lượng 1.2kg dễ mang. Thiết kế nhôm nguyên khối, chuối phím Chiclet.', attrs: { brand: 'ProBook', processor: 'Intel Core i7', ram: '16GB', origin: 'Trung Quốc', warranty: '24 tháng chính hãng' }, axes: [{ attr: 'color2', values: ['Bạc', 'Xám'] }, { attr: 'storage', values: ['512GB', { v: '1TB', delta: 3000000 }] }], sold: 180, featured: true, tags: ['sale'], img: { emoji: '💻', theme: 'indigo', emoji2: '⚡', query: 'ultrabook laptop' } },
    { slug: 'laptop-cloudmax-pro-15', name: 'Laptop CloudMax Pro 15', shop: 'techzone-vn', category: 'laptop', price: 21990000, short: 'i9 12 nhân, RTX 4070, RAM 32GB, 15.6" 2.5K 165Hz, chơi game 2024 mượt mà.', attrs: { brand: 'CloudMax', processor: 'Intel Core i9', ram: '32GB', origin: 'Trung Quốc', warranty: '24 tháng chính hãng' }, axes: [{ attr: 'color2', values: ['Đen', 'Trắng'] }, { attr: 'storage', values: ['512GB', { v: '1TB', delta: 2000000 }] }], sold: 95, featured: true, img: { emoji: '💻', theme: 'coral', emoji2: '🎮', query: 'gaming laptop' } },
    { slug: 'laptop-techvision-standard-14', name: 'Laptop TechVision Standard 14', shop: 'techzone-vn', category: 'laptop', price: 12490000, listPrice: 14490000, short: 'i5 8 nhân, RAM 8GB, SSD 256GB, màn hình 14" Full HD, pin 7 giờ, giá sinh viên.', attrs: { brand: 'TechVision', processor: 'Intel Core i5', ram: '8GB', origin: 'Trung Quốc', warranty: '12 tháng chính hãng' }, axes: [{ attr: 'color2', values: ['Xám', 'Bạc'] }, { attr: 'storage', values: ['256GB', { v: '512GB', delta: 2000000 }] }], sold: 420, tags: ['sale'], img: { emoji: '💻', theme: 'sky', emoji2: '📚', query: 'student laptop' } },
    { slug: 'laptop-dualcore-ryzen-pro-16', name: 'Laptop DualCore Ryzen Pro 16', shop: 'techzone-vn', category: 'laptop', price: 19990000, short: 'Ryzen 7 8 nhân, RAM 16GB, SSD 512GB, màn hình 16" 2.5K 90Hz, pin 9 giờ, CPU AMD.', attrs: { brand: 'DualCore', processor: 'AMD Ryzen 7', ram: '16GB', origin: 'Trung Quốc', warranty: '24 tháng chính hãng' }, axes: [{ attr: 'color2', values: ['Đen', 'Xám'] }, { attr: 'storage', values: ['512GB', { v: '1TB', delta: 2500000 }] }], sold: 210, img: { emoji: '💻', theme: 'navy', emoji2: '🔧', query: 'workstation laptop' } },
    { slug: 'laptop-elitewire-compact-11', name: 'Laptop EliteWire Compact 11', shop: 'techzone-vn', category: 'laptop', price: 8990000, short: 'Pentium N6000, RAM 4GB, SSD 128GB, màn hình 11.6" HD, pin 6 giờ, cho công việc offline.', attrs: { brand: 'EliteWire', processor: 'Intel Core i3', ram: '4GB', origin: 'Trung Quốc', warranty: '12 tháng chính hãng' }, axes: [{ attr: 'color2', values: ['Đen', 'Bạc'] }, { attr: 'storage', values: ['128GB', { v: '256GB', delta: 1500000 }] }], sold: 650, img: { emoji: '💻', theme: 'amber', emoji2: '💼', query: 'netbook ultraportable' } },
    { slug: 'laptop-powerlink-apple-m2-13', name: 'Laptop PowerLink Apple M2 13', shop: 'techzone-vn', category: 'laptop', price: 28990000, listPrice: 31990000, short: 'Chip Apple M2, RAM 16GB, SSD 512GB, màn hình Retina 13.3", pin 18 giờ, siêu mỏng.', desc: 'PowerLink Apple M2 13 mang chip Apple M2 mạnh mẽ, RAM 16GB unified, SSD 512GB cực nhanh, màn hình Retina 13.3" 2K sắc nét, pin 18+ giờ sử dụng, trọng lượng 1.24kg. Hoàn hảo cho lập trình, thiết kế, video.', attrs: { brand: 'PowerLink', processor: 'Apple M2', ram: '16GB', origin: 'Mỹ', warranty: '12 tháng chính hãng' }, axes: [{ attr: 'color2', values: ['Bạc', 'Xám'] }, { attr: 'storage', values: ['512GB', { v: '1TB', delta: 4000000 }] }], sold: 125, featured: true, tags: ['sale'], img: { emoji: '💻', theme: 'rose', emoji2: '✨', query: 'macbook m2' } },
    { slug: 'laptop-techmaster-ryzen-budget-15', name: 'Laptop TechMaster Ryzen Budget 15', shop: 'techzone-vn', category: 'laptop', price: 10990000, short: 'Ryzen 5, RAM 8GB, SSD 256GB, màn hình 15.6" Full HD, pin 6 giờ, giá rẻ bất ngờ.', attrs: { brand: 'TechMaster', processor: 'AMD Ryzen 5', ram: '8GB', origin: 'Trung Quốc', warranty: '12 tháng chính hãng' }, axes: [{ attr: 'color2', values: ['Đen', 'Đỏ'] }, { attr: 'storage', values: ['256GB', { v: '512GB', delta: 1500000 }] }], sold: 580, img: { emoji: '💻', theme: 'lime', emoji2: '💰', query: 'budget laptop' } },

    // Chuột & Bàn phím: 7 sản phẩm
    { slug: 'chuot-gaming-elitekey-dpi-16000', name: 'Chuột Gaming EliteKey DPI 16000', shop: 'techzone-vn', category: 'chuot-ban-phim', price: 789000, listPrice: 899000, short: 'Chuột chuyên gaming, DPI 16000, 8 nút, sạc dây, RGB LED chuyên động.', attrs: { brand: 'EliteKey', color2: 'Đen', material2: 'Nhựa', origin: 'Trung Quốc', warranty: '12 tháng' }, axes: [{ attr: 'connection_type', values: ['Wired USB', { v: 'Wireless 2.4GHz', delta: 200000 }] }], sold: 850, featured: true, tags: ['sale'], img: { emoji: '🖱️', theme: 'coral', emoji2: '⚡', query: 'gaming mouse' } },
    { slug: 'chuot-khong-day-techvision-2-4ghz', name: 'Chuột không dây TechVision 2.4GHz', shop: 'techzone-vn', category: 'chuot-ban-phim', price: 249000, short: 'Chuột wireless nhỏ gọn, pin AA, DPI điều chỉnh 1200/2000/3200, đủ dùng hàng ngày.', attrs: { brand: 'TechVision', color2: 'Đen', material2: 'Nhựa', origin: 'Trung Quốc', warranty: '6 tháng' }, axes: [{ attr: 'connection_type', values: ['Wireless 2.4GHz', { v: 'Bluetooth', delta: 50000 }] }], sold: 2100, img: { emoji: '🖱️', theme: 'sky', emoji2: '🔋', query: 'wireless mouse' } },
    { slug: 'ban-phim-co-elitekey-rgb', name: 'Bàn phím cơ EliteKey RGB', shop: 'techzone-vn', category: 'chuot-ban-phim', price: 1490000, listPrice: 1790000, short: 'Bàn phím cơ Hotswap, switch Brown, RGB đầy màu, USB-C type C, dây nylon bền.', desc: 'EliteKey RGB là bàn phím cơ chuyên game: khung nhôm CNC, hotswap socket cho switch đổi nhanh, switch Gateron Brown êm ái, RGB ánh sáng 16 triệu màu, kết nối USB-C, dây bọc nylon bền bỉ. Hỗ trợ Windows/Mac.', attrs: { brand: 'EliteKey', color2: 'Đen', material2: 'Kim loại', origin: 'Trung Quốc', warranty: '24 tháng' }, axes: [{ attr: 'connection_type', values: ['Wired USB', { v: 'Wireless 2.4GHz', delta: 500000 }] }], sold: 420, featured: true, tags: ['sale'], img: { emoji: '⌨️', theme: 'indigo', emoji2: '🎮', query: 'mechanical keyboard' } },
    { slug: 'ban-phim-office-powerlink-im-sac', name: 'Bàn phím Office PowerLink ím sắc', shop: 'techzone-vn', category: 'chuot-ban-phim', price: 399000, short: 'Bàn phím chiclet siêu ím, pin AA 18 tháng, wireless 2.4GHz, kích thước compact.', attrs: { brand: 'PowerLink', color2: 'Bạc', material2: 'Nhựa', origin: 'Trung Quốc', warranty: '12 tháng' }, axes: [{ attr: 'connection_type', values: ['Wireless 2.4GHz', { v: 'Bluetooth', delta: 100000 }] }], sold: 1200, img: { emoji: '⌨️', theme: 'slate', emoji2: '💼', query: 'office keyboard' } },
    { slug: 'bo-chuot-ban-phim-probook-combo', name: 'Bộ chuột bàn phím ProBook Combo', shop: 'techzone-vn', category: 'chuot-ban-phim', price: 549000, short: 'Combo chuột + bàn phím wireless, pin lâu, kết nối USB 2.4GHz chung 1 receiver.', attrs: { brand: 'ProBook', color2: 'Đen', material2: 'Nhựa', origin: 'Trung Quốc', warranty: '12 tháng' }, axes: [{ attr: 'connection_type', values: ['Wireless 2.4GHz'] }], sold: 1800, img: { emoji: '⌨️', theme: 'navy', emoji2: '🖱️', query: 'keyboard mouse combo' } },
    { slug: 'chuot-trackball-dualcore-ergonomic', name: 'Chuột trackball DualCore ergonomic', shop: 'techzone-vn', category: 'chuot-ban-phim', price: 649000, short: 'Trackball ergonomic, giảm đau cổ tay, wireless Bluetooth, quả cầu 40mm mượt mà.', attrs: { brand: 'DualCore', color2: 'Đen', material2: 'Cao su', origin: 'Trung Quốc', warranty: '12 tháng' }, axes: [{ attr: 'connection_type', values: ['Bluetooth'] }], sold: 380, img: { emoji: '🖱️', theme: 'teal', emoji2: '👋', query: 'trackball mouse' } },
    { slug: 'ban-phim-gaming-techmster-linear', name: 'Bàn phím Gaming TechMaster Linear Switch', shop: 'techzone-vn', category: 'chuot-ban-phim', price: 1790000, short: 'Switch linear nhanh, RGB Per-key, macro lập trình, khung hợp kim nhôm, tilt.', attrs: { brand: 'TechMaster', color2: 'Đen', material2: 'Hợp kim nhôm', origin: 'Trung Quốc', warranty: '24 tháng' }, axes: [{ attr: 'connection_type', values: ['Wired USB', { v: 'Wireless 2.4GHz', delta: 600000 }] }], sold: 240, featured: true, img: { emoji: '⌨️', theme: 'fuchsia', emoji2: '⚡', query: 'gaming keyboard' } },

    // Tai nghe & Loa: 7 sản phẩm
    { slug: 'tai-nghe-gaming-soundwave-7-1', name: 'Tai nghe Gaming SoundWave 7.1 USB', shop: 'techzone-vn', category: 'tai-nghe-loa', price: 1290000, listPrice: 1490000, short: 'Tai nghe gaming 7.1 virtual, mic noise cancel, driver 50mm, âm bass mạnh, USB.', desc: 'SoundWave 7.1 USB là tai nghe gaming với âm thế 7.1 virtual surround, driver 50mm bass sâu, mic microphone chống ồn, bảng điều khiển âm lượng, dây 2m bọc nylon, sponge đệm tai êm. Chuyên game, xem phim.', attrs: { brand: 'SoundWave', origin: 'Trung Quốc', warranty: '12 tháng' }, axes: [{ attr: 'color2', values: ['Đen', 'Đỏ'] }, { attr: 'connection_type', values: ['Wired USB'] }], sold: 620, featured: true, tags: ['sale'], img: { emoji: '🎧', theme: 'rose', emoji2: '🎮', query: 'gaming headset' } },
    { slug: 'tai-nghe-bluetooth-visionpro-anh', name: 'Tai nghe Bluetooth VisionPro Anh', shop: 'techzone-vn', category: 'tai-nghe-loa', price: 1890000, short: 'Tai nghe Bluetooth, chống ồn chủ động, pin 30 giờ, bass 40Hz, bộ nhớ kết nối 8 thiết bị.', attrs: { brand: 'VisionPro', origin: 'Trung Quốc', warranty: '12 tháng' }, axes: [{ attr: 'color2', values: ['Đen', 'Bạc', 'Xanh'] }, { attr: 'connection_type', values: ['Bluetooth'] }], sold: 510, featured: true, img: { emoji: '🎧', theme: 'indigo', emoji2: '🔊', query: 'anc bluetooth headphones' } },
    { slug: 'tai-nghe-tron-ba-khong-day-cloudmax', name: 'Tai nghe trdon ba không dây CloudMax', shop: 'techzone-vn', category: 'tai-nghe-loa', price: 2490000, short: 'Tai nghe không dây, vòng quanh tai, bluetooth 5.2, pin 25 giờ, chống ồn tích cực.', attrs: { brand: 'CloudMax', origin: 'Trung Quốc', warranty: '24 tháng' }, axes: [{ attr: 'color2', values: ['Đen', 'Xám'] }, { attr: 'connection_type', values: ['Bluetooth', { v: 'Wired 3.5mm', delta: -500000 }] }], sold: 280, img: { emoji: '🎧', theme: 'violet', emoji2: '👂', query: 'over ear headphones' } },
    { slug: 'tai-nghe-gaming-co-day-elitewire', name: 'Tai nghe Gaming có dây EliteWire', shop: 'techzone-vn', category: 'tai-nghe-loa', price: 789000, short: 'Tai nghe gaming 3.5mm/USB, driver 40mm, mic linh hoạt, khung giãn cách tốt.', attrs: { brand: 'EliteWire', origin: 'Trung Quốc', warranty: '12 tháng' }, axes: [{ attr: 'color2', values: ['Đen'] }, { attr: 'connection_type', values: ['Wired 3.5mm', { v: 'Wired USB', delta: 100000 }] }], sold: 950, img: { emoji: '🎧', theme: 'coral', emoji2: '🎤', query: 'wired gaming headset' } },
    { slug: 'loa-tivi-techvision-2-1', name: 'Loa tivi TechVision 2.1 Bluetooth', shop: 'techzone-vn', category: 'tai-nghe-loa', price: 1590000, listPrice: 1890000, short: 'Loa ngoài 2.1 Bluetooth, bass 100W, driver 90mm, sạc Pin 12 giờ, remote IR.', attrs: { brand: 'TechVision', origin: 'Trung Quốc', warranty: '12 tháng' }, axes: [{ attr: 'color2', values: ['Đen', 'Bạc'] }, { attr: 'connection_type', values: ['Bluetooth', { v: 'Wired 3.5mm', delta: 0 }] }], sold: 420, tags: ['sale'], img: { emoji: '🔊', theme: 'navy', emoji2: '📺', query: 'tv soundbar' } },
    { slug: 'loa-xach-tay-powerlink-portable', name: 'Loa xách tay PowerLink Portable', shop: 'techzone-vn', category: 'tai-nghe-loa', price: 890000, short: 'Loa bluetooth xách tay, chống nước IPX5, pin 24 giờ, bass 360 độ, kích 6cm.', attrs: { brand: 'PowerLink', origin: 'Trung Quốc', warranty: '12 tháng' }, axes: [{ attr: 'color2', values: ['Đen', 'Hồng', 'Xanh'] }, { attr: 'connection_type', values: ['Bluetooth'] }], sold: 1650, img: { emoji: '🔊', theme: 'teal', emoji2: '💧', query: 'portable bluetooth speaker' } },
    { slug: 'tai-nghe-khong-day-dualcore-true-wireless', name: 'Tai nghe không dây DualCore True Wireless', shop: 'techzone-vn', category: 'tai-nghe-loa', price: 549000, short: 'Tai nghe True Wireless, Bluetooth 5.1, pin 4 giờ/20 giờ case, chống ồn.', attrs: { brand: 'DualCore', origin: 'Trung Quốc', warranty: '12 tháng' }, axes: [{ attr: 'color2', values: ['Đen', 'Bạc'] }, { attr: 'connection_type', values: ['Bluetooth'] }], sold: 2200, img: { emoji: '🎧', theme: 'lime', emoji2: '📱', query: 'true wireless earbuds' } },

    // Màn hình & Linh kiện: 7 sản phẩm
    { slug: 'man-hinh-gaming-144hz-cloudmax-27', name: 'Màn hình Gaming 144Hz CloudMax 27', shop: 'techzone-vn', category: 'man-hinh-linh-kien', price: 5490000, listPrice: 6290000, short: 'Màn hình 27" 1920x1080 144Hz, TN panel, time 1ms, G-Sync, chơi game mượt.', desc: 'CloudMax 27 Gaming 144Hz là màn hình chiến game: 27" Full HD 1920x1080 TN panel, 144Hz 1ms response, G-Sync compatible, chân đế điều chỉnh cao độ, HDMI + DP, speaker tích hợp. Hoàn hảo cho FPS, multiplayer.', attrs: { brand: 'CloudMax', origin: 'Trung Quốc', warranty: '24 tháng' }, axes: [{ attr: 'screen_resolution', values: ['1920x1080 (Full HD)'] }, { attr: 'panel_type', values: ['TN'] }], sold: 280, featured: true, tags: ['sale'], img: { emoji: '🖥️', theme: 'coral', emoji2: '🎮', query: 'gaming monitor 144hz' } },
    { slug: 'man-hinh-2k-ips-probook-24', name: 'Màn hình 2K IPS ProBook 24', shop: 'techzone-vn', category: 'man-hinh-linh-kien', price: 3890000, short: 'Màn hình 24" 2560x1440 IPS 75Hz, màu chuẩn cho thiết kế, USB-C Power Delivery.', attrs: { brand: 'ProBook', origin: 'Trung Quốc', warranty: '24 tháng' }, axes: [{ attr: 'screen_resolution', values: ['2560x1440 (2K)'] }, { attr: 'panel_type', values: ['IPS'] }], sold: 165, featured: true, img: { emoji: '🖥️', theme: 'indigo', emoji2: '🎨', query: 'designer monitor 2k' } },
    { slug: 'man-hinh-4k-va-visionpro-32', name: 'Màn hình 4K VA VisionPro 32', shop: 'techzone-vn', category: 'man-hinh-linh-kien', price: 7890000, short: 'Màn hình 32" 3840x2160 4K VA, HDR1000, 60Hz, calibrated, cho cắt video 4K.', attrs: { brand: 'VisionPro', origin: 'Trung Quốc', warranty: '24 tháng' }, axes: [{ attr: 'screen_resolution', values: ['3840x2160 (4K)'] }, { attr: 'panel_type', values: ['VA'] }], sold: 85, img: { emoji: '🖥️', theme: 'rose', emoji2: '📹', query: 'professional 4k monitor' } },
    { slug: 'man-hinh-ultrawide-dell-49', name: 'Màn hình Ultrawide TechMaster 49', shop: 'techzone-vn', category: 'man-hinh-linh-kien', price: 12990000, short: 'Màn hình 49" màn hình cực rộng, 5120x1440, 144Hz, PBP/PIP, chơi game/làm việc.', attrs: { brand: 'TechMaster', origin: 'Trung Quốc', warranty: '24 tháng' }, axes: [{ attr: 'screen_resolution', values: ['2560x1440 (2K)'] }, { attr: 'panel_type', values: ['VA'] }], sold: 42, featured: true, img: { emoji: '🖥️', theme: 'navy', emoji2: '🏢', query: 'ultrawide monitor gaming' } },
    { slug: 'o-ssd-nvme-powerlink-1tb', name: 'Ổ SSD NVMe PowerLink 1TB M.2', shop: 'techzone-vn', category: 'man-hinh-linh-kien', price: 1290000, listPrice: 1490000, short: 'SSD NVMe M.2 1TB, tốc độ 7000MB/s, nhiệt độ ổn định, bảo hành 5 năm.', attrs: { brand: 'PowerLink', origin: 'Trung Quốc', warranty: '60 tháng' }, axes: [{ attr: 'screen_resolution', values: ['1920x1080 (Full HD)'] }, { attr: 'panel_type', values: ['IPS'] }], sold: 1800, tags: ['sale'], img: { emoji: '💾', theme: 'teal', emoji2: '⚡', query: 'nvme ssd' } },
    { slug: 'ram-ddr4-dualcore-32gb', name: 'RAM DDR4 DualCore 32GB (2x16)', shop: 'techzone-vn', category: 'man-hinh-linh-kien', price: 2290000, short: 'RAM DDR4 32GB kit (2x16GB) 3600MHz CAS 18, RGB LED, hỗ trợ AMD + Intel.', attrs: { brand: 'DualCore', origin: 'Trung Quốc', warranty: '12 tháng' }, axes: [{ attr: 'screen_resolution', values: ['1920x1080 (Full HD)'] }, { attr: 'panel_type', values: ['IPS'] }], sold: 1100, img: { emoji: '💾', theme: 'violet', emoji2: '🔧', query: 'ddr4 ram memory' } },
    { slug: 'man-hinh-oled-gaming-techvision-28', name: 'Màn hình OLED Gaming TechVision 28', shop: 'techzone-vn', category: 'man-hinh-linh-kien', price: 9890000, short: 'Màn hình 28" OLED 3840x2160 4K 144Hz 0.03ms, màu sắc siêu sắc nét, chân đế Ergo.', desc: 'TechVision 28 OLED 4K 144Hz là màn hình cao cấp: OLED 28" 4K 3840x2160, 144Hz 0.03ms, 99.5% DCI-P3 màu tự nhiên, response siêu nhanh, flicker-free. Chân đế điều chỉnh toàn diện, DisplayPort 2.1 UHBR20.', attrs: { brand: 'TechVision', origin: 'Trung Quốc', warranty: '36 tháng' }, axes: [{ attr: 'screen_resolution', values: ['3840x2160 (4K)'] }, { attr: 'panel_type', values: ['OLED'] }], sold: 58, featured: true, isNew: true, tags: ['new'], img: { emoji: '🖥️', theme: 'fuchsia', emoji2: '✨', query: 'oled gaming monitor 4k 144hz' } },
  ],
};

export default dept;
