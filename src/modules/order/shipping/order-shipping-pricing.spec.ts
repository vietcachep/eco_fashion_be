import type { ShippingAddress } from '@common/gateway/order-shipping.gateway';
import type { ProductQueryApi } from '@modules/product/queryapi/product.queryapi';
import type { ShopQueryApi } from '@modules/shop/queryapi/shop.queryapi';
import type { ShippingApplicationApi, QuoteInput, ShippingQuoteSnapshot } from '@modules/shipping/applicationapi/shipping.applicationapi';
import type { ShippingQueryApi } from '@modules/shipping/queryapi/shipping.queryapi';
import { OrderShippingPricingService, type CarrierPricingContext, type CarrierQuote } from './order-shipping-pricing.service';

const pickup: ShippingAddress = { name: 'Shop A', phone: '0900000000', street: '1 Nguyễn Huệ', provinceName: 'Hồ Chí Minh', districtName: 'Quận 1', wardName: 'Bến Nghé', provinceId: 202, districtId: 1442, wardCode: '20101', addressSystem: 'legacy_3level' };
const lines = [{ variantId: 'variant-A', quantity: 2, unitPrice: 250_000n }];
const context = (): CarrierPricingContext => ({ methodCode: 'cod', address: { recipientName: 'Khách A', phone: '0911111111', street: '2 Lê Lợi', provinceName: 'Hồ Chí Minh', districtName: 'Quận 1', wardName: 'Bến Nghé', addressSystem: 'legacy_3level', ghnProvinceId: 202, ghnDistrictId: 1442, ghnWardCode: '20101' } });

function fixture() {
  const shop = { id: 'shop-A', shippingCarrierEnabled: true, shippingPickup: { ...pickup }, shippingReturn: null as ShippingAddress | null };
  const variants = new Map<string, { weightGram: number | null; lengthCm: number | null; widthCm: number | null; heightCm: number | null }>([['variant-A', { weightGram: 500, lengthCm: 20, widthCm: 15, heightCm: 10 }]]);
  const findBrief = jest.fn((_id: string) => Promise.resolve(shop));
  const variantSnapshots = jest.fn((_ids: string[]) => Promise.resolve(variants));
  const createQuote = jest.fn((i: QuoteInput): Promise<CarrierQuote> => Promise.resolve({ id: 'quote-fresh', fingerprint: i.fingerprint ?? '', shippingFee: '35000', feeSource: 'fake', expiresAt: new Date(Date.now() + 300_000).toISOString(), provider: 'fake', environment: 'demo', snapshot: { pickup: i.pickup, destination: i.destination, returnAddress: i.returnAddress, parcel: i.parcel, quoteId: 'quote-fresh', quotedFee: '35000', provider: 'fake', environment: 'demo' } }));
  const readQuote = jest.fn((_id: string, _userId: string): Promise<ShippingQuoteSnapshot | null> => Promise.resolve(null));
  const service = new OrderShippingPricingService({ findBrief } as unknown as ShopQueryApi, { variantSnapshots } as unknown as ProductQueryApi, { quote: createQuote } as unknown as ShippingApplicationApi, { quote: readQuote } as unknown as ShippingQueryApi);
  const resolve = (ctx: CarrierPricingContext = context(), subtotal = 500_000n, fallback = 30_000n) => service.resolve('customer-A', 'shop-A', lines, subtotal, fallback, ctx);
  const cached = async (): Promise<ShippingQuoteSnapshot> => ({ ...(await resolve())!, userId: 'customer-A', shopId: 'shop-A' });
  return { shop, variants, createQuote, readQuote, variantSnapshots, service, resolve, cached };
}

describe('PLAN-0043 giá vận chuyển ngoài transaction', () => {
  const saved = { provider: process.env.SHIPPING_CARRIER, base: process.env.GHN_BASE_URL, account: process.env.GHN_SHOP_ID };
  beforeEach(() => { process.env.SHIPPING_CARRIER = 'fake'; process.env.GHN_BASE_URL = 'https://dev-online-gateway.ghn.vn'; process.env.GHN_SHOP_ID = 'audit-account'; });
  afterEach(() => { for (const [key, value] of Object.entries({ SHIPPING_CARRIER: saved.provider, GHN_BASE_URL: saved.base, GHN_SHOP_ID: saved.account })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

  it('tái dùng quote đúng khách/shop/fingerprint còn hạn mà không gọi hãng', async () => {
    const f = fixture(); const quote = await f.cached(); f.createQuote.mockClear(); f.readQuote.mockResolvedValue(quote);
    expect(await f.resolve({ ...context(), quoteIds: [quote.id] })).toBe(quote);
    expect(f.readQuote).toHaveBeenCalledWith(quote.id, 'customer-A');
    expect(f.createQuote).not.toHaveBeenCalled();
  });
  it('quote của khách khác được đọc theo ownership, không tái dùng khi query API trả null', async () => {
    const f = fixture(); const foreign = await f.cached(); foreign.userId = 'customer-B'; f.createQuote.mockClear();
    f.readQuote.mockImplementation((_id, userId) => Promise.resolve(userId === foreign.userId ? foreign : null));
    await f.resolve({ ...context(), quoteIds: ['quote-cua-nguoi-khac'] });
    expect(f.readQuote).toHaveBeenCalledWith('quote-cua-nguoi-khac', 'customer-A');
    expect(f.createQuote).toHaveBeenCalledTimes(1);
  });
  it.each(['wrong_shop', 'expired', 'wrong_fingerprint'])('không tái dùng quote %s', async (kind) => {
    const f = fixture(); const quote = await f.cached(); f.createQuote.mockClear();
    if (kind === 'wrong_shop') quote.shopId = 'shop-B';
    if (kind === 'expired') quote.expiresAt = new Date(Date.now() - 1).toISOString();
    if (kind === 'wrong_fingerprint') quote.fingerprint = 'khac';
    f.readQuote.mockResolvedValue(quote);
    const result = await f.resolve({ ...context(), quoteIds: [quote.id] });
    expect(result).not.toBe(quote); expect(f.createQuote).toHaveBeenCalledTimes(1);
  });
  it('ctx.prepared chỉ kiểm snapshot, không gọi quote/readQuote trong transaction', async () => {
    const f = fixture(); const quote = await f.cached(); f.createQuote.mockClear(); f.readQuote.mockClear();
    expect(await f.resolve({ ...context(), prepared: new Map([['shop-A', quote]]) })).toBe(quote);
    expect(f.createQuote).not.toHaveBeenCalled(); expect(f.readQuote).not.toHaveBeenCalled();
  });
  it.each(['address', 'pickup', 'parcel', 'return_address', 'provider', 'account', 'method', 'expiry'])('snapshot %s đổi phải rollback thay vì HTTP trong transaction', async (kind) => {
    const f = fixture(); const quote = await f.cached(); const ctx = context(); ctx.prepared = new Map([['shop-A', quote]]); f.createQuote.mockClear();
    if (kind === 'address') ctx.address.street = 'Địa chỉ mới';
    if (kind === 'pickup') f.shop.shippingPickup.street = 'Kho mới';
    if (kind === 'parcel') f.variants.get('variant-A')!.weightGram = 750;
    if (kind === 'return_address') f.shop.shippingReturn = { ...pickup, street: 'Địa chỉ hoàn mới' };
    if (kind === 'provider') process.env.SHIPPING_CARRIER = 'ghn';
    if (kind === 'account') process.env.GHN_SHOP_ID = 'other-account';
    if (kind === 'method') ctx.methodCode = 'payos';
    if (kind === 'expiry') quote.expiresAt = new Date(Date.now() - 1).toISOString();
    await expect(f.resolve(ctx)).rejects.toMatchObject({ errorCode: 'ORDER_SHIPPING_QUOTE_CHANGED', httpStatus: 409 });
    expect(f.createQuote).not.toHaveBeenCalled();
  });
  it('COD dùng subtotal + phí dự phòng trước voucher, không tạo vòng lặp phí/voucher', async () => {
    const f = fixture(); await f.resolve(context(), 500_000n, 30_000n);
    expect(f.createQuote.mock.calls[0][0].codValue).toBe('530000');
    expect(f.createQuote.mock.calls[0][0].parcel).toEqual({ weightGram: 1000, lengthCm: 20, widthCm: 15, heightCm: 20 });
  });
  it('online không yêu cầu hãng thu COD', async () => {
    const f = fixture(); await f.resolve({ ...context(), methodCode: 'payos' }); expect(f.createQuote.mock.calls[0][0].codValue).toBe('0');
  });
  it('self fallback không cần địa chỉ hãng/parcel/quote', async () => {
    const f = fixture(); f.shop.shippingCarrierEnabled = false;
    expect(await f.resolve({ ...context(), address: { ...context().address, ghnWardCode: null } })).toBeNull();
    expect(f.createQuote).not.toHaveBeenCalled(); expect(f.variantSnapshots).not.toHaveBeenCalled();
  });
  it('carrier bị tắt giữa chuẩn bị và transaction không âm thầm chuyển self', async () => {
    const f = fixture(); const quote = await f.cached(); f.shop.shippingCarrierEnabled = false;
    await expect(f.resolve({ ...context(), prepared: new Map([['shop-A', quote]]) })).rejects.toMatchObject({ errorCode: 'ORDER_SHIPPING_QUOTE_CHANGED' });
  });
  it('kiện vượt giới hạn bị chặn trước gọi báo giá', async () => {
    const f = fixture(); f.variants.get('variant-A')!.weightGram = 10_000;
    await expect(f.resolve()).rejects.toMatchObject({ errorCode: 'SHIPMENT_PARCEL_UNSUPPORTED' });
    expect(f.createQuote).not.toHaveBeenCalled();
  });
  it('thiếu mẫu pickup hoặc mã địa chỉ không được nhận đơn rồi lỗi lúc ship', async () => {
    const f = fixture(); await expect(f.resolve({ ...context(), address: { ...context().address, ghnWardCode: null } })).rejects.toMatchObject({ errorCode: 'SHIPMENT_ADDRESS_REQUIRED' });
    f.shop.shippingPickup = null as unknown as ShippingAddress;
    await expect(f.resolve()).rejects.toMatchObject({ errorCode: 'SHIPMENT_PICKUP_REQUIRED' });
    expect(f.createQuote).not.toHaveBeenCalled();
  });
});
