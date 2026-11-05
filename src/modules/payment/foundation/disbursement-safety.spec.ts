import { isLoopbackFinanceEndpoint } from './disbursement-safety';
describe('PLAN-0043 hàng rào tiền giả lập', () => {
  it.each(['http://127.0.0.1:4035', 'http://localhost:4035', 'http://[::1]:4035'])('cho mock loopback %s ngoài production', (url) => expect(isLoopbackFinanceEndpoint(url, 'test')).toBe(true));
  it.each(['https://api-merchant.payos.vn', 'https://localhost.evil.test', 'http://127.0.0.1.evil.test', 'file:///tmp/mock', 'http://name:secret@localhost:4000', 'not-a-url'])('không nhận %s là mock tài chính', (url) => expect(isLoopbackFinanceEndpoint(url, 'test')).toBe(false));
  it('production không cho loopback trở thành đường chi của đơn giả', () => expect(isLoopbackFinanceEndpoint('http://localhost:4035', 'production')).toBe(false));
});
