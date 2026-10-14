/*
 * Ngành gốc "Sách & Văn phòng phẩm" — Track D (PLAN-0017). Bắt chước khuôn `dien-thoai-phu-kien.ts` (đọc file đó trước).
 * Shop: book-cafe (shop chính chủ cho ngành này).
 */
import type { DeptSeed } from '../types';

const dept: DeptSeed = {
  slug: 'sach-van-phong-pham',
  name: 'Sách & Văn phòng phẩm',
  description: 'Sách văn học, kỹ năng, thiếu nhi, văn phòng phẩm, dụng cụ học tập',
  sortOrder: 550,
  icon: '📚',
  theme: 'sand',
  attributes: [
    { code: 'brand', name: 'Thương hiệu / NXB', inputType: 'select', values: ['NXB Hoa Mai', 'NXB Tuổi Trẻ', 'NXB Kim Đồng', 'NXB Đại Học', 'NXB Trao Đổi', 'NXB Sóng', 'Pen & Paper', 'Creative Mind', 'Wisdom Press', 'Dream Publishers'] },
    { code: 'page_count', name: 'Số trang', inputType: 'text' },
    { code: 'author', name: 'Tác giả', inputType: 'text' },
    { code: 'publisher', name: 'Nhà xuất bản', inputType: 'text' },
    { code: 'book_cover', name: 'Loại bìa', inputType: 'select', values: ['Bìa mềm', 'Bìa cứng'] },
    { code: 'paper_size', name: 'Khổ giấy', inputType: 'select', values: ['A6', 'A5', 'B5', 'A4'] },
    { code: 'language', name: 'Ngôn ngữ', inputType: 'select', values: ['Tiếng Việt', 'Tiếng Anh', 'Tiếng Nhật'] },
    { code: 'material2', name: 'Chất liệu', inputType: 'select', values: ['Giấy', 'Vải'] },
  ],
  categories: [
    {
      slug: 'sach-van-hoc-ky-nang',
      name: 'Sách văn học & Kỹ năng',
      description: 'Tiểu thuyết, truyện ngắn, sách kỹ năng sống, kinh doanh, tâm lý học',
      sortOrder: 551,
      icon: '📖',
      theme: 'indigo',
      attrs: [
        { code: 'brand', required: true },
        { code: 'author', required: true },
        { code: 'publisher' },
        { code: 'page_count' },
        { code: 'book_cover' },
        { code: 'language' },
      ],
    },
    {
      slug: 'sach-thieu-nhi',
      name: 'Sách thiếu nhi',
      description: 'Sách tranh, chuyện cổ tích, truyện phiêu lưu cho trẻ em',
      sortOrder: 552,
      icon: '📕',
      theme: 'rose',
      attrs: [
        { code: 'brand', required: true },
        { code: 'author' },
        { code: 'publisher' },
        { code: 'page_count' },
        { code: 'book_cover' },
      ],
    },
    {
      slug: 'van-phong-pham',
      name: 'Văn phòng phẩm',
      description: 'Bút, bút chì, tẩy, bút là, kéo, keo, bộ bút chuyên nghiệp',
      sortOrder: 553,
      icon: '✏️',
      theme: 'coral',
      attrs: [
        { code: 'color2', axis: true },
        { code: 'brand', required: true },
        { code: 'material2' },
        { code: 'origin' },
      ],
    },
    {
      slug: 'dung-cu-hoc-tap',
      name: 'Dụng cụ học tập',
      description: 'Vở, notebook, sổ ghi chép, sách giáo khoa hỗ trợ, giáo án học sinh',
      sortOrder: 554,
      icon: '📔',
      theme: 'sky',
      attrs: [
        { code: 'brand' },
        { code: 'color2', axis: true },
        { code: 'paper_size' },
        { code: 'material2' },
      ],
    },
  ],
  products: [
    // ---- Sách văn học & Kỹ năng ----
    { slug: 'sach-tinh-tu-chi-dung', name: 'Sách "Tinh tú chi dung" - Lê Phương Anh', shop: 'book-cafe', category: 'sach-van-hoc-ky-nang', price: 85000, listPrice: 120000, short: 'Tiểu thuyết văn học hiện đại về cuộc sống phụ nữ Việt Nam đương đại.', desc: 'Tiểu thuyết "Tinh tú chi dung" của tác giả Lê Phương Anh: kể câu chuyện ba thế hệ phụ nữ Việt Nam, yêu thương, hy sinh, tìm lại cái tôi. Bìa mềm, 312 trang, NXB Hoa Mai. Được bình chọn là tiểu thuyết hay nhất năm.', attrs: { brand: 'NXB Hoa Mai', author: 'Lê Phương Anh', publisher: 'NXB Hoa Mai', page_count: '312', book_cover: 'Bìa mềm', language: 'Tiếng Việt' }, sold: 2140, featured: true, tags: ['sale'], img: { emoji: '📖', theme: 'indigo', emoji2: '💔', query: 'vietnamese novel' } },
    { slug: 'sach-hanh-phuc-co-the-nen', name: 'Sách "Hạnh phúc có thể học được" - Dr. Mark', shop: 'book-cafe', category: 'sach-van-hoc-ky-nang', price: 165000, listPrice: 220000, short: 'Sách tâm lý tích cực: 10 kỹ năng xây dựng tình trạng xanh.', attrs: { brand: 'Wisdom Press', author: 'Dr. Mark Thompson', publisher: 'Wisdom Press', page_count: '268', book_cover: 'Bìa cứng', language: 'Tiếng Việt' }, sold: 850, featured: true, tags: ['sale'], img: { emoji: '😊', theme: 'coral', emoji2: '📚', query: 'happiness psychology book' } },
    { slug: 'sach-doanh-nhan-thong-minh-don-gian', name: 'Sách "Doanh nhân thông minh đơn giản" - Tạ Minh Tuấn', shop: 'book-cafe', category: 'sach-van-hoc-ky-nang', price: 125000, short: 'Kinh doanh nhỏ, lớn đơn giản: kinh tế học cho mọi người.', attrs: { brand: 'NXB Đại Học', author: 'Tạ Minh Tuấn', publisher: 'NXB Đại Học', page_count: '280', book_cover: 'Bìa mềm', language: 'Tiếng Việt' }, sold: 1230, tags: ['sale'], img: { emoji: '💼', theme: 'navy', emoji2: '📊', query: 'business book vietnamese' } },
    { slug: 'sach-ap-luc-kieu-xu-ly', name: 'Sách "Áp lực kiểu xử lý" - Hà Nội Press', shop: 'book-cafe', category: 'sach-van-hoc-ky-nang', price: 110000, listPrice: 160000, short: 'Kỹ năng quản lý áp lực, stress tại nơi làm việc hiệu quả.', attrs: { brand: 'NXB Tuổi Trẻ', author: 'Phạm Thu Hằng', publisher: 'NXB Tuổi Trẻ', page_count: '224', book_cover: 'Bìa mềm', language: 'Tiếng Việt' }, sold: 680, tags: ['sale'], img: { emoji: '😤', theme: 'rose', emoji2: '🧠', query: 'stress management book' } },
    { slug: 'sach-tieng-anh-giao-tiep-co-ban', name: 'Sách "Tiếng Anh giao tiếp cơ bản" - English Path', shop: 'book-cafe', category: 'sach-van-hoc-ky-nang', price: 95000, listPrice: 140000, short: '30 bài học tiếng Anh thực dụng, 100 câu giao tiếp hàng ngày.', attrs: { brand: 'Dream Publishers', author: 'Helen Morris', publisher: 'Dream Publishers', page_count: '186', book_cover: 'Bìa mềm', language: 'Tiếng Anh' }, sold: 1420, featured: true, tags: ['sale'], img: { emoji: '🗣️', theme: 'sky', emoji2: '🌍', query: 'english learning book' } },
    { slug: 'sach-tuyen-tap-tho-dep-dao-tao', name: 'Sách "Tuyển tập thơ đẹp" - Dao Tạo', shop: 'book-cafe', category: 'sach-van-hoc-ky-nang', price: 145000, short: 'Thơ lịch sử từ Trần Tế Xương, Hồ Xuân Hương, Nguyễn Công Trứ.', attrs: { brand: 'NXB Sóng', author: 'Tuyển chọn', publisher: 'NXB Sóng', page_count: '352', book_cover: 'Bìa cứng', language: 'Tiếng Việt' }, sold: 420, isNew: true, tags: ['new'], img: { emoji: '✍️', theme: 'indigo', emoji2: '💝', query: 'poetry collection' } },

    // ---- Sách thiếu nhi ----
    { slug: 'sach-tranh-thien-tuong-mien-phia-tay', name: 'Sách tranh "Thiên đường miền phía tây"', shop: 'book-cafe', category: 'sach-thieu-nhi', price: 95000, listPrice: 140000, short: 'Sách tranh dành cho trẻ 4-8 tuổi, chuyện về thiên nhiên kỳ diệu.', desc: 'Sách tranh cho trẻ em "Thiên đường miền phía tây": tập hợp 15 câu chuyện về động vật, rừng xanh và con suối tinh tú. Minh họa đầy màu sắc, công thức học tập qua truyện. Bìa cứng, 128 trang, NXB Kim Đồng.', attrs: { brand: 'NXB Kim Đồng', author: 'Lương Minh Trang', publisher: 'NXB Kim Đồng', page_count: '128', book_cover: 'Bìa cứng' }, sold: 1680, featured: true, tags: ['sale'], img: { emoji: '🌳', theme: 'emerald', emoji2: '🦁', query: 'children picture book' } },
    { slug: 'sach-tro-choi-thanh-lich-tre-em-5', name: 'Sách trò chơi "Thành lịch trẻ em 5+" - Tây Ban Nha', shop: 'book-cafe', category: 'sach-thieu-nhi', price: 75000, short: 'Sách hoạt động: tìm khác biệt, xếp hình, cái từ ẩn cho bé 5+.', attrs: { brand: 'Dream Publishers', author: 'Sofia Garcia', publisher: 'Dream Publishers', page_count: '96', book_cover: 'Bìa mềm' }, sold: 920, img: { emoji: '🧩', theme: 'coral', emoji2: '🎮', query: 'activity book children' } },
    { slug: 'sach-chuyen-co-tich-co-dien-3-tap', name: 'Sách chuyện cổ tích cổ điển 3 tập', shop: 'book-cafe', category: 'sach-thieu-nhi', price: 185000, listPrice: 280000, short: '3 cuốn cổ tích: Tấm Cám, Sơn Tinh Thủy Tinh, Thạch Sanh.', attrs: { brand: 'NXB Tuổi Trẻ', author: 'Tuyển chọn', publisher: 'NXB Tuổi Trẻ', page_count: '360', book_cover: 'Bìa cứng' }, sold: 520, tags: ['sale'], img: { emoji: '📖', theme: 'rose', emoji2: '✨', query: 'vietnamese fairy tales' } },
    { slug: 'sach-phieu-luu-phia-duoi-bien', name: 'Sách "Phiêu lưu phía dưới biển" - David Hunt', shop: 'book-cafe', category: 'sach-thieu-nhi', price: 110000, short: 'Truyện phiêu lưu: 4 cậu bé tìm kho báu dưới đáy biển sâu.', attrs: { brand: 'Wisdom Press', author: 'David Hunt', publisher: 'Wisdom Press', page_count: '152', book_cover: 'Bìa mềm' }, sold: 650, isNew: true, tags: ['new'], img: { emoji: '🌊', theme: 'sky', emoji2: '🏴‍☠️', query: 'adventure story children' } },
    { slug: 'sach-lau-tot-tua-chi-2024', name: 'Sách "Lâu tối tựa chi" tiểu thuyết - Lù Tốt 2024', shop: 'book-cafe', category: 'sach-thieu-nhi', price: 125000, listPrice: 180000, short: 'Truyện manga/đồ họa dành cho thanh thiếu niên, hành động kỳ ảo.', attrs: { brand: 'NXB Sóng', author: 'Lù Tốt', publisher: 'NXB Sóng', page_count: '288', book_cover: 'Bìa mềm' }, sold: 380, tags: ['sale'], img: { emoji: '🗻', theme: 'navy', emoji2: '⚔️', query: 'manga graphic novel' } },

    // ---- Văn phòng phẩm ----
    { slug: 'but-gel-creative-mind-0-5mm-12-cay', name: 'Bộ bút gel Creative Mind 0.5mm - 12 cây', shop: 'book-cafe', category: 'van-phong-pham', price: 95000, listPrice: 140000, short: '12 bút gel màu sắc, viết mượt, lõi 0.5mm, không phai.', desc: 'Bộ 12 bút gel Creative Mind: lõi 0.5mm viết mịn màng, không phai, không lem, tay cảm ứng êm. Các màu: đen, xanh, đỏ, tím, hồng, cam... Phù hợp học sinh, sinh viên, văn phòng.', attrs: { brand: 'Creative Mind', material2: 'Nhựa', origin: 'Trung Quốc' }, axes: [{ attr: 'color2', values: ['Đen', 'Xanh'] }], sold: 1850, featured: true, tags: ['sale'], img: { emoji: '🖊️', theme: 'coral', emoji2: '✨', query: 'gel pen set' } },
    { slug: 'but-chi-h-faber-pencil-20-cay-hsd', name: 'Bộ bút chì HSD Faber 20 cây', shop: 'book-cafe', category: 'van-phong-pham', price: 120000, short: '20 bút chì gỗ độ cứng khác nhau, thuận cho vẽ và luyện chữ.', attrs: { brand: 'Pen & Paper', material2: 'Gỗ tự nhiên', origin: 'Việt Nam' }, axes: [{ attr: 'color2', values: ['Nâu'] }], sold: 720, img: { emoji: '✏️', theme: 'sand', emoji2: '🎨', query: 'pencil set' } },
    { slug: 'tay-but-liquid-pen-0-7mm-24-mau', name: 'Bộ bút lỏng Liquid Pen 0.7mm - 24 màu', shop: 'book-cafe', category: 'van-phong-pham', price: 185000, listPrice: 260000, short: '24 màu bút lỏng, nét viết 0.7mm, chân chính hơn bút gel.', attrs: { brand: 'Creative Mind', material2: 'Nhựa', origin: 'Trung Quốc' }, axes: [{ attr: 'color2', values: ['Đen'] }], sold: 540, tags: ['sale'], img: { emoji: '🖍️', theme: 'indigo', emoji2: '🌈', query: 'liquid pen markers' } },
    { slug: 'bo-butte-eraser-latex-free-bao', name: 'Bộ tẩy CAL-A Latex-free - bao lưới', shop: 'book-cafe', category: 'van-phong-pham', price: 80000, short: '5 tẩy không latex, an toàn da, tẩy sạch không để dư.', attrs: { brand: 'Pen & Paper', material2: 'Cao su', origin: 'Nhật Bản' }, axes: [{ attr: 'color2', values: ['Hồng', 'Xanh'] }], sold: 1290, img: { emoji: '🧹', theme: 'rose', emoji2: '✓', query: 'eraser pencil' } },
    { slug: 'but-la-highlight-fluor-5-cay', name: 'Bút lá Highlight Fluor 5 cây', shop: 'book-cafe', category: 'van-phong-pham', price: 65000, listPrice: 95000, short: '5 bút lá màu neon, tô sáng tài liệu học tập hiệu quả.', attrs: { brand: 'Creative Mind', material2: 'Nhựa', origin: 'Trung Quốc' }, axes: [{ attr: 'color2', values: ['Vàng', 'Xanh', 'Hồng', 'Cam'] }], sold: 2100, featured: true, tags: ['sale'], img: { emoji: '🟨', theme: 'amber', emoji2: '💡', query: 'highlighter markers' } },
    { slug: 'keo-dan-kem-500ml-craft-bond', name: 'Keo dán kem Craft Bond 500ml', shop: 'book-cafe', category: 'van-phong-pham', price: 35000, short: 'Keo dán kem an toàn cho trẻ, không độc hại, khô nhanh.', attrs: { brand: 'Pen & Paper', material2: 'Nhựa', origin: 'Việt Nam' }, axes: [{ attr: 'color2', values: ['Trắng'] }], sold: 3200, img: { emoji: '🧴', theme: 'sky', emoji2: '💫', query: 'craft glue' } },
    { slug: 'bao-keo-dap-office-set-50-cay', name: 'Bao keo dập Office Set - 50 cái', shop: 'book-cafe', category: 'van-phong-pham', price: 45000, short: '50 keo dập tránh rơi, nắm chắc, thanh lịch văn phòng.', attrs: { brand: 'Pen & Paper', material2: 'Thép không gỉ', origin: 'Trung Quốc' }, axes: [{ attr: 'color2', values: ['Đen'] }], sold: 1820, img: { emoji: '📎', theme: 'slate', emoji2: '🔗', query: 'paper clips' } },

    // ---- Dụng cụ học tập ----
    { slug: 'vo-dot-a5-nhat-ky-100-trang', name: 'Vở dột A5 nhật ký 100 trang', shop: 'book-cafe', category: 'dung-cu-hoc-tap', price: 45000, listPrice: 65000, short: 'Vở ghi chép A5 kẻ dòng, bìa cứng bền, giấy trắng sạch.', desc: 'Vở dột A5 kích thước 14.8 x 21cm, 100 trang giấy kẻ dòng, bìa cứng nhập khẩu bền vào 5 năm, có bookmark. Thích hợp ghi chép nhật ký, sổ tay, notebook học tập.', attrs: { brand: 'Pen & Paper', material2: 'Giấy', paper_size: 'A5' }, axes: [{ attr: 'color2', values: ['Đen', 'Xanh'] }], sold: 2340, featured: true, tags: ['sale'], img: { emoji: '📔', theme: 'navy', emoji2: '✍️', query: 'notebook diary' } },
    { slug: 'so-tay-to-chinh-grid-dot-b5-80-trang', name: 'Sổ tay tổ chức Grid Dot B5 80 trang', shop: 'book-cafe', category: 'dung-cu-hoc-tap', price: 55000, short: 'Sổ tay grid dot B5, luyến mềm, phù hợp hoạch định, vẽ sơ đồ tư duy.', attrs: { brand: 'Creative Mind', material2: 'Giấy', paper_size: 'B5' }, axes: [{ attr: 'color2', values: ['Xanh', 'Cam'] }], sold: 620, img: { emoji: '📊', theme: 'orange', emoji2: '📐', query: 'planner notebook' } },
    { slug: 'sach-giao-khoa-ho-tro-toan-lop-5', name: 'Sách giáo khoa hỗ trợ Toán lớp 5', shop: 'book-cafe', category: 'sach-van-hoc-ky-nang', price: 75000, listPrice: 110000, short: 'Toán lớp 5: 200 bài tập luyện tập từ cơ bản đến nâng cao.', attrs: { brand: 'NXB Đại Học', author: 'Nguyễn Văn Hạnh', publisher: 'NXB Đại Học', page_count: '180', book_cover: 'Bìa mềm', language: 'Tiếng Việt' }, sold: 850, tags: ['sale'], img: { emoji: '🔢', theme: 'indigo', emoji2: '📚', query: 'math textbook' } },
    { slug: 'hop-color-24-mau-faber-castle', name: 'Hộp màu 24 chiếc Faber-Castell', shop: 'book-cafe', category: 'van-phong-pham', price: 120000, listPrice: 180000, short: '24 bút màu nước gỗ, màu sắc sống động, không độc hại.', attrs: { brand: 'Pen & Paper', material2: 'Gỗ tự nhiên', origin: 'Đức' }, axes: [{ attr: 'color2', values: ['Vàng'] }], sold: 680, featured: true, tags: ['sale'], img: { emoji: '🎨', theme: 'coral', emoji2: '🌈', query: 'colored pencils' } },
    { slug: 'sach-giao-an-tieng-viet-lop-3-full', name: 'Sách giáo án Tiếng Việt lớp 3 đầy đủ', shop: 'book-cafe', category: 'sach-van-hoc-ky-nang', price: 95000, short: '1 năm học: 162 bài giảng phát triển kỹ năng ngôn ngữ.', attrs: { brand: 'NXB Tuổi Trẻ', author: 'Đội tác giả', publisher: 'NXB Tuổi Trẻ', page_count: '256', book_cover: 'Bìa mềm', language: 'Tiếng Việt' }, sold: 420, img: { emoji: '📚', theme: 'sky', emoji2: '✏️', query: 'textbook vietnamese' } },
    { slug: 'sach-luyen-chu-dep-lop-1-2', name: 'Sách luyện chữ đẹp lớp 1, 2', shop: 'book-cafe', category: 'sach-van-hoc-ky-nang', price: 60000, listPrice: 90000, short: 'Luyện viết chữ: từ chữ hoa đến chữ thường từng bước.', attrs: { brand: 'NXB Kim Đồng', author: 'Phạm Thị Hạnh', publisher: 'NXB Kim Đồng', page_count: '96', book_cover: 'Bìa mềm', language: 'Tiếng Việt' }, sold: 1120, tags: ['sale'], img: { emoji: '✍️', theme: 'sand', emoji2: '🎓', query: 'handwriting practice' } },
  ],
};

export default dept;
