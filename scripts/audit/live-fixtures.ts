import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as argon2 from 'argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client';
import { syncPermissions } from '../sync-permissions';

/* Fixture riêng đúng DB audit localhost55446. Không đọc .env, không chứa tài khoản/thanh toán thật. */
export function assertLiveAuditDatabase(url:string):void {
  const db=new URL(url);
  if(!['localhost','127.0.0.1'].includes(db.hostname)||db.port!=='55446'||db.pathname!=='/fitly_live_audit'||db.username!=='fitly_live_audit')throw new Error('Chỉ cho phép DB fitly_live_audit localhost55446.');
}
const id=(name:string)=>{const h=createHash('sha256').update(`fitly-live-audit:${name}`).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;};

export async function seedLiveFixtures(db:PrismaClient) {
  await syncPermissions(db);
  const password='LiveAuditOnly2026!';const passwordHash=await argon2.hash(password);
  const roles=await db.role.findMany({where:{code:{in:['customer','admin','shop_owner','shop_staff']}}});const role=(code:string)=>{const r=roles.find(r=>r.code===code);if(!r)throw new Error('Thiếu vai audit '+code);return r.id;};
  const users:Record<string,{id:string;email:string;password:string}>={};
  for(const [key,fullName] of [['owner','Chủ shop audit'],['moderator','Điều hành audit'],['viewer','Người xem audit'],['viewerTwo','Người xem audit hai'],['admin','Quản trị audit'],['otherOwner','Chủ shop khác audit']] as const){
    const email=`live-audit-${key.toLowerCase()}@example.test`;const user=await db.user.upsert({where:{id:id(key)},create:{id:id(key),email,fullName,passwordHash,emailVerifiedAt:new Date(),roleId:role(key==='admin'?'admin':'customer')},update:{passwordHash,status:'active'}});users[key]={id:user.id,email,password};
  }
  const shop=await db.shop.upsert({where:{code:'LIVE-AUDIT-SHOP'},create:{id:id('shop'),code:'LIVE-AUDIT-SHOP',slug:'live-audit-studio',name:'Gian hàng audit livestream',status:'approved',ownerUserId:users.owner.id,logoUrl:'/static/seed/shop/time-lab/logo.jpg'},update:{status:'approved'}});
  const otherShop=await db.shop.upsert({where:{code:'LIVE-AUDIT-OTHER'},create:{id:id('other-shop'),code:'LIVE-AUDIT-OTHER',slug:'live-audit-other',name:'Gian hàng khác audit',status:'approved',ownerUserId:users.otherOwner.id},update:{status:'approved'}});
  for(const [key,shopId,roleCode] of [['owner',shop.id,'shop_owner'],['moderator',shop.id,'shop_staff'],['otherOwner',otherShop.id,'shop_owner']] as const){await db.shopMember.upsert({where:{shopId_userId:{shopId,userId:users[key].id}},create:{shopId,userId:users[key].id,roleId:role(roleCode),customPermissions:key==='moderator'?['shop.livestream.read','shop.livestream.moderate']:undefined},update:{status:'active'}});}
  const category=await db.category.upsert({where:{id:id('category')},create:{id:id('category'),slug:'live-audit-category',name:'Ngành hàng audit live',attributeMode:'dynamic'},update:{}});
  const product=await db.product.upsert({where:{id:id('product')},create:{id:id('product'),shopId:shop.id,slug:'live-audit-product',name:'Sản phẩm kiểm thử livestream',categoryId:category.id,categorySlug:category.slug,basePrice:'100000',status:'active',publishedAt:new Date(),images:{create:{url:'/static/seed/catalog/collections/thoi-trang.jpg',isPrimary:true}}},update:{status:'active'}});
  const variant=await db.productVariant.upsert({where:{id:id('variant')},create:{id:id('variant'),productId:product.id,shopId:shop.id,sku:'LIVE-AUDIT-SKU',stock:100,weightGram:300,lengthCm:18,widthCm:12,heightCm:4},update:{isActive:true}});
  return {users,shopId:shop.id,otherShopId:otherShop.id,productId:product.id,variantId:variant.id};
}

async function main() {
  const connectionString=process.env.EF_DATABASE_URL??'';assertLiveAuditDatabase(connectionString);
  const db=new PrismaClient({adapter:new PrismaPg({connectionString})});
  try {
    const fixtures=await seedLiveFixtures(db);const tokens:Record<string,string>={};
    for(const [key,user] of Object.entries(fixtures.users)){
      const response=await fetch('http://localhost:4006/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:user.email,password:user.password})});
      const result=await response.json() as {data?:{accessToken?:string}};if(!response.ok||!result.data?.accessToken)throw new Error(`Không đăng nhập được fixture ${key}: ${response.status}`);tokens[key]=result.data.accessToken;
    }
    const output=join(tmpdir(),'fitly-live-fixtures.json');await writeFile(output,JSON.stringify({...fixtures,tokens}),{mode:0o600});
    console.log(JSON.stringify({fixtureFile:output,users:Object.keys(fixtures.users),shopId:fixtures.shopId,productId:fixtures.productId}));
  }finally{await db.$disconnect();}
}
if(require.main===module)void main().catch((error:unknown)=>{console.error(error instanceof Error?error.message:'Fixture lỗi');process.exitCode=1;});
