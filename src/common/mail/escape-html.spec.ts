import { escapeHtml, escapeHtmlMultiline } from './escape-html';

describe('escapeHtml (AUD-11c / NTF-04 — email không để lọt HTML thô của người dùng)', () => {
  it('[NTF-04] <script>alert(1)</script> không còn thẻ thô trong kết quả', () => {
    const out = escapeHtml('<script>alert(1)</script>');
    expect(out).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
  });

  it('[NTF-04] dấu nháy kép / đơn / backtick được thoát — không phá được giá trị thuộc tính "onerror="', () => {
    const out = escapeHtml(`" onerror="alert(1)" x='y' \`z\``);
    expect(out).toBe('&quot; onerror=&quot;alert(1)&quot; x=&#39;y&#39; &#96;z&#96;');
    expect(out).not.toMatch(/["'`]/);
  });

  it('[NTF-04] & được thoát đúng một lần (không thoát đôi chuỗi đã là thực thể khi gọi một lần)', () => {
    expect(escapeHtml('A & B &amp; C')).toBe('A &amp; B &amp;amp; C');
  });

  it('chuỗi thường (tiếng Việt, số, dấu câu) giữ nguyên', () => {
    expect(escapeHtml('Giao hàng không thành công — khách hẹn lại 15/11, SĐT 0909.000.222')).toBe('Giao hàng không thành công — khách hẹn lại 15/11, SĐT 0909.000.222');
  });

  it('null / undefined → rỗng; số → chuỗi', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(42)).toBe('42');
  });

  it('escapeHtmlMultiline: escape trước, đổi xuống dòng → <br> sau (chỉ <br> do chính hàm sinh ra)', () => {
    const out = escapeHtmlMultiline('Dòng 1\r\nDòng <b>2</b>\nDòng 3');
    expect(out).toBe('Dòng 1<br>Dòng &lt;b&gt;2&lt;/b&gt;<br>Dòng 3');
    expect(out.match(/<[^>]+>/g)).toEqual(['<br>', '<br>']);
  });
});
