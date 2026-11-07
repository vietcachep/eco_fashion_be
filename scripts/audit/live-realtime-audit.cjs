/* Isolated API4006/Redis56392 audit: actual socket auth and worker outbox broadcast. */
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {io}=require('../../../fashion_frontend_user/node_modules/socket.io-client/build/cjs/index.js');
const fixtures=JSON.parse(fs.readFileSync(path.join(require('node:os').tmpdir(),'fitly-live-fixtures.json')));
const API='http://localhost:4006/api/v1';
async function main(){
  for(const role of ['owner','otherOwner']){const u=fixtures.users[role];const r=await fetch(API+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:u.email,password:u.password})});const d=await r.json();assert.ok(r.ok);fixtures.tokens[role]=d.data.accessToken;}
  async function api(route,body){const r=await fetch(API+route,{method:'POST',headers:{authorization:'Bearer '+fixtures.tokens.owner,'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();assert.ok(r.ok,'HTTP '+r.status);return d.data;}
  const s=await api('/shop/livestreams',{title:'Audit realtime authorization',productIds:[fixtures.productId]});
  const connect=role=>io('http://localhost:4006/live',{transports:['websocket'],forceNew:true,reconnection:false,auth:{sessionId:s.id,token:fixtures.tokens[role]},extraHeaders:{origin:'http://localhost:3415'}});
  const owner=connect('owner'),outsider=connect('otherOwner');
  try{
    await Promise.all([
      new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Owner socket timeout')),10000);owner.on('connect',()=>{clearTimeout(timer);resolve()});owner.on('live.error',()=>reject(new Error('Owner rejected')));}),
      new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Cross-shop socket not rejected')),10000);outsider.on('live.error',()=>{clearTimeout(timer);resolve()});}),
    ]);
    // Join authorization is asynchronous after Socket.IO connect; wait for the room join before mutation.
    await new Promise(resolve=>setTimeout(resolve,500));
    const received=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Worker Redis broadcast missing')),15000);owner.once('product.pinned',payload=>{clearTimeout(timer);resolve(payload)});});
    const changed=await api('/shop/livestreams/'+s.id+'/pin',{productId:fixtures.productId,version:s.version});
    const event=await received;assert.equal(event.productId,fixtures.productId);
    await api('/shop/livestreams/'+s.id+'/cancel',{version:changed.version});
    console.log('PASS socket owner admission, cross-shop rejection, durable pin outbox -> worker -> Redis -> authenticated room');
  }finally{owner.disconnect();outsider.disconnect();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
