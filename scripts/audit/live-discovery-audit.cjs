/* Real HTTP pagination/filter audit. Only the guarded isolated database is writable. */
require('ts-node/register/transpile-only');require('tsconfig-paths/register');require('reflect-metadata');
const fs=require('node:fs');const {randomUUID}=require('node:crypto');const assert=require('node:assert/strict');
const {PrismaClient}=require('../../src/generated/prisma/client');const {PrismaPg}=require('@prisma/adapter-pg');const {assertLiveAuditDatabase}=require('./live-fixtures');
async function main(){
  assertLiveAuditDatabase(process.env.EF_DATABASE_URL);
  const db=new PrismaClient({adapter:new PrismaPg({connectionString:process.env.EF_DATABASE_URL})});
  const f=JSON.parse(fs.readFileSync(process.env.TEMP+'/fitly-live-fixtures.json'));const ids=[];let token;
  async function api(method,route,body){const r=await fetch('http://localhost:4006/api/v1'+route,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json();assert.ok(r.ok,'HTTP '+r.status+' '+route);return d.data;}
  try{
    const login=await api('POST','/auth/login',{email:f.users.owner.email,password:f.users.owner.password});token=login.accessToken;
    const category=await db.category.upsert({where:{id:'00000000-0000-4000-8000-000000004502'},update:{},create:{id:'00000000-0000-4000-8000-000000004502',name:'Other live audit category',slug:'live-audit-other-category',attributeMode:'dynamic'}});
    const other=await db.product.create({data:{shopId:f.shopId,name:'Other audit category product',slug:'live-audit-other-'+randomUUID(),categoryId:category.id,categorySlug:category.slug,basePrice:'100000',status:'active',publishedAt:new Date()}});
    const shop=await db.shop.findUniqueOrThrow({where:{id:f.shopId}});
    for(let i=0;i<17;i++){const s=await api('POST','/shop/livestreams',{title:'Discovery audit '+i,scheduledAt:new Date(Date.now()+3600000).toISOString(),productIds:[i===16?other.id:f.productId]});ids.push(s);}
    const params='?q='+encodeURIComponent(shop.name)+'&categorySlug=live-audit-category&size=15';
    const first=await api('GET','/livestreams'+params+'&page=1'),second=await api('GET','/livestreams'+params+'&page=2');
    assert.equal(first.totalElements,16);assert.equal(first.content.length,15);assert.equal(second.totalElements,16);assert.equal(second.content.length,1);assert.equal(new Set([...first.content,...second.content].map(s=>s.id)).size,16);
    const missing=await api('GET','/livestreams?categorySlug=no-such-audit-category');assert.equal(missing.totalElements,0);
    console.log('PASS exact category before pagination: total16, pages15+1, no duplicate, missing category0; shop-name q matched titles without query.');
  }finally{for(const s of ids)await api('POST','/shop/livestreams/'+s.id+'/cancel',{version:s.version}).catch(()=>{});await db.$disconnect();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
