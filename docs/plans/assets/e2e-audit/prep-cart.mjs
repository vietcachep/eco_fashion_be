import * as L from './lib.mjs';
const sh = { t: await L.shopBySlug('techzone'), n: await L.shopBySlug('ngonviet') };
const vt = (await L.pickVariant({ shopId: sh.t.id, qty: 3, maxPrice: 600000 }))[0];
const vn = (await L.pickVariant({ shopId: sh.n.id, qty: 3, maxPrice: 600000 }))[0];
await L.api('DELETE', '/cart', { as: 'khach31' });
console.log((await L.api('POST', '/cart/items', { as: 'khach31', body: { variantId: vt.id, quantity: 1 } })).status, (await L.api('POST', '/cart/items', { as: 'khach31', body: { variantId: vn.id, quantity: 2 } })).status);
console.log(vt.name, '|', vn.name);
process.exit(0);
