/* WebRTC audit thật local: browser host phát canvas/audio qua BE token, browser khác decode frame.
   Chỉ dùng API4006/LiveKit7880 và fixture audit; giữ browser/room cho commerce audit tiếp theo. */
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const fixturePath=path.join(os.tmpdir(),'fitly-live-fixtures.json');
const API='http://localhost:4006/api/v1';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
class CDP {
  constructor(url){this.socket=new WebSocket(url);this.serial=0;this.pending=new Map();this.ready=new Promise((resolve,reject)=>{this.socket.onopen=resolve;this.socket.onerror=reject;});this.socket.onmessage=event=>{const value=JSON.parse(String(event.data));if(value.id){const waiter=this.pending.get(value.id);this.pending.delete(value.id);if(value.error)waiter?.reject(new Error(value.error.message));else waiter?.resolve(value.result);}};}
  async call(method,params={}){await this.ready;const id=++this.serial;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.socket.send(JSON.stringify({id,method,params}));});}
  async evaluate(expression){const r=await this.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;}
  close(){this.socket.close();}
}
async function main(){
  const fixtures=JSON.parse(await fs.readFile(fixturePath,'utf8'));
  async function api(method,route,role='owner',body){const response=await fetch(API+route,{method,headers:{authorization:'Bearer '+fixtures.tokens[role],'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});const data=await response.json();if(!response.ok)throw new Error(`${method} ${route}: ${response.status} ${data.error?.code||data.message}`);return data.data;}
  const profile=path.resolve(__dirname,'../../../.live-browser-audit/profile');
  let browser;try{browser=await(await fetch('http://127.0.0.1:9229/json/version')).json();}catch{}
  let chromePid=fixtures.chromePid;
  if(!browser){const chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port=9229','--remote-debugging-address=127.0.0.1','--user-data-dir='+profile,'--autoplay-policy=no-user-gesture-required','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--disable-background-timer-throttling','--disable-renderer-backgrounding','about:blank'],{windowsHide:true,stdio:'ignore'});chrome.unref();chromePid=chrome.pid;}
  for(let i=0;!browser&&i<60;i++){try{browser=await(await fetch('http://127.0.0.1:9229/json/version')).json();break;}catch{await delay(250);}}if(!browser)throw new Error('Chrome audit chưa sẵn sàng.');
  const browserCdp=new CDP(browser.webSocketDebuggerUrl);
  async function page(){const context=await browserCdp.call('Target.createBrowserContext');const target=await browserCdp.call('Target.createTarget',{url:'about:blank',browserContextId:context.browserContextId});const list=await(await fetch('http://127.0.0.1:9229/json/list')).json();const entry=list.find(p=>p.id===target.targetId);return new CDP(entry.webSocketDebuggerUrl);}
  const host=await page(),viewer=await page();
  const sdk=await fs.readFile(path.resolve(__dirname,'../../../fashion_frontend_user/node_modules/livekit-client/dist/livekit-client.umd.js'),'utf8');
  await host.evaluate(sdk+';true');await viewer.evaluate(sdk+';true');
  const session=await api('POST','/shop/livestreams','owner',{title:'Phiên kiểm chứng video thật local',productIds:[fixtures.productId]});
  fixtures.sessionId=session.id;fixtures.chromePid=chromePid;fixtures.chromeProfile=profile;await fs.writeFile(fixturePath,JSON.stringify(fixtures));
  await api('PUT',`/shop/livestreams/${session.id}/moderators`,'owner',{userIds:[fixtures.users.moderator.id]});
  const grant=await api('POST',`/shop/livestreams/${session.id}/start`,'owner',{});
  await host.evaluate(`(async()=>{globalThis.room=new LivekitClient.Room();await room.connect(${JSON.stringify(grant.serverUrl)},${JSON.stringify(grant.token)});const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;document.body.append(canvas);let frame=0;setInterval(()=>{const c=canvas.getContext('2d');c.fillStyle=frame++%2?'#ff6f61':'#315fa8';c.fillRect(0,0,640,360);c.fillStyle='white';c.font='32px sans-serif';c.fillText('FITLY LIVE AUDIT '+frame,25,100);},100);const video=canvas.captureStream(10).getVideoTracks()[0];await room.localParticipant.publishTrack(video,{source:LivekitClient.Track.Source.Camera,name:'audit-canvas'});globalThis.audioContext=new AudioContext();const oscillator=audioContext.createOscillator(),volume=audioContext.createGain(),output=audioContext.createMediaStreamDestination();volume.gain.value=0.01;oscillator.connect(volume).connect(output);oscillator.start();await audioContext.resume();await room.localParticipant.publishTrack(output.stream.getAudioTracks()[0],{source:LivekitClient.Track.Source.Microphone,name:'audit-audio'});return {state:room.state,tracks:room.localParticipant.trackPublications.size};})()`);
  let state;for(let i=0;i<40;i++){state=await api('GET',`/livestreams/${session.id}`,'viewer');if(state.state==='live')break;await delay(500);}if(state.state!=='live')throw new Error('BE chưa chuyển live từ webhook media thật.');
  const viewGrant=await api('POST',`/livestreams/${session.id}/viewer-session`,'viewer',{});fixtures.viewerAdmissionId=viewGrant.admissionId;
  await viewer.evaluate(`(async()=>{globalThis.room=new LivekitClient.Room();globalThis.received={video:false,audio:false};room.on(LivekitClient.RoomEvent.TrackSubscribed,(track)=>{const element=track.attach();document.body.append(element);if(track.kind==='video'){element.id='audit-video';element.muted=true;element.play().catch(()=>{});received.video=true;}if(track.kind==='audio'){received.audio=true;}});await room.connect(${JSON.stringify(viewGrant.serverUrl)},${JSON.stringify(viewGrant.token)});return room.state;})()`);
  let proof;for(let i=0;i<60;i++){proof=await viewer.evaluate(`(()=>{const video=document.getElementById('audit-video');return {...received,state:room.state,participants:room.remoteParticipants.size,width:video?.videoWidth,height:video?.videoHeight,frames:video?.getVideoPlaybackQuality?.().totalVideoFrames||0};})()`);if(proof.frames>3&&proof.audio&&proof.video)break;await delay(500);}if(!proof.frames||!proof.audio||!proof.video)throw new Error('Không chứng minh được frame/audio nhận qua media server: '+JSON.stringify(proof));
  fixtures.mediaReady=true;fixtures.mediaProof=proof;await fs.writeFile(fixturePath,JSON.stringify(fixtures));
  console.log(JSON.stringify({sessionId:session.id,chromePid,proof,kind:'REAL local WebRTC canvas/audio; not camera hardware or Cloud load benchmark'}));
  if(process.env.FITLY_AUDIT_TERMINAL_REPLAY==='true'){
    const guests=[];
    for(let i=0;i<9;i++){
      const key=crypto.randomUUID();const r=await fetch(API+`/livestreams/${session.id}/viewer-session`,{method:'POST',headers:{'x-guest-key':key,'content-type':'application/json'},body:'{}'});const d=await r.json();if(!r.ok)throw new Error('Guest admission quota test '+r.status);guests.push({key,id:d.data.admissionId});
    }
    const overflow=await fetch(API+`/livestreams/${session.id}/viewer-session`,{method:'POST',headers:{'x-guest-key':crypto.randomUUID(),'content-type':'application/json'},body:'{}'});
    if(overflow.status!==409)throw new Error('11th admission was not rejected409.');
    for(let i=0;i<30;i++){const g=guests[i%guests.length];const r=await fetch(API+`/livestreams/${session.id}/heartbeat`,{method:'POST',headers:{'x-guest-key':g.key,'content-type':'application/json'},body:JSON.stringify({admissionId:g.id})});if(!r.ok)throw new Error('Shared-IP heartbeat rejected '+r.status);}
    const stolen=await fetch(API+`/livestreams/${session.id}/heartbeat`,{method:'POST',headers:{'x-guest-key':crypto.randomUUID(),'content-type':'application/json'},body:JSON.stringify({admissionId:guests[0].id})});
    if(stolen.status!==403)throw new Error('Foreign guest admission accepted.');
    console.log('PASS admission gate10/11th409, shared-IP30heartbeats, foreign guest ownership403 (not media/load benchmark).');
    const ended=await api('POST',`/admin/livestreams/${session.id}/terminate`,'admin',{reason:'Audit terminal token replay'});
    if(ended.state!=='terminated'||ended.mediaStopStatus!=='confirmed')throw new Error('Force-stop chưa xác nhận xoá phòng media.');
    const replay=await viewer.evaluate(`(async()=>{const replay=new LivekitClient.Room();try{await replay.connect(${JSON.stringify(grant.serverUrl)},${JSON.stringify(grant.token)},{maxRetries:0});await replay.disconnect();return {rejected:false};}catch{return {rejected:true};}})()`);
    if(!replay.rejected)throw new Error('Token host cũ đã tái tạo được phòng terminal. Kiểm room.auto_create:false.');
    console.log(JSON.stringify({terminalReplayRejected:true,mediaStopStatus:ended.mediaStopStatus,sessionId:session.id}));
    const rehearsal=await api('POST',`/shop/livestreams/${session.id}/start`,'owner',{rehearsal:true});
    const privateAttempt=await fetch(API+`/livestreams/${rehearsal.session.id}/viewer-session`,{method:'POST',headers:{'x-guest-key':crypto.randomUUID(),'content-type':'application/json'},body:'{}'});
    if(privateAttempt.status!==404)throw new Error('Uninvited guest entered private rehearsal '+privateAttempt.status);
    await api('POST',`/shop/livestreams/${rehearsal.session.id}/end`,'owner',{reason:'Audit private rehearsal isolation'});
    console.log('PASS private rehearsal rejects uninvited guest404.');
    host.close();viewer.close();browserCdp.close();return;
  }
  // Keep this tool session alive: Windows exec tears down the child Chrome job on exit.
  // Maintain the real viewer admission while other agents audit commerce in separate pages.
  for (;;) {
    await delay(20_000);
    await api('POST',`/livestreams/${session.id}/heartbeat`,'viewer',{admissionId:viewGrant.admissionId}).catch(()=>{});
  }
}
main().catch(error=>{console.error(error.message);process.exit(1);});
