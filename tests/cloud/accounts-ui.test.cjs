'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {JSDOM,VirtualConsole}=require('jsdom');
const source=fs.readFileSync(path.join(__dirname,'../../assets/accounts.js'),'utf8');
const account=(extra={})=>({id:'user1',nickname:'Ada',email:'ada@example.test',firstName:'Ada',lastName:'Private',role:'user',suspended:false,elo:500,ratedGames:0,wins:0,lastPlaces:0,placementSum:0,peakElo:500,...extra});
const tick=()=>new Promise(r=>setImmediate(r));
async function settle(){for(let i=0;i<5;i++)await tick();}
function page(handler,{url='https://troika.example.test/',local=false}={}){
 const calls=[],errors=[],events=[],notices=[];const vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e));
 const dom=new JSDOM(`<meta name="troika-api" content="${local?'api.php':'/api/game'}"><button id="account-button" hidden>Account</button><button id="ladder-button" hidden>Rankings</button><dialog id="account-dialog"><div id="account-content"></div></dialog>`,{url,runScripts:'outside-only',virtualConsole:vc,pretendToBeVisual:true});const w=dom.window;
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
 w.fetch=async(endpoint,options)=>{const body=JSON.parse(options.body);calls.push({endpoint,...body});const result=await handler(body,endpoint);return {ok:!result.error,json:async()=>result};};
 w.document.addEventListener('troika-account-change',e=>events.push(e.detail.user));w.document.addEventListener('troika-toast',e=>notices.push(e.detail.message));w.eval(source);
 return {w,calls,errors,events,notices,$:s=>w.document.querySelector(s),$$:s=>[...w.document.querySelectorAll(s)],async click(s){const el=w.document.querySelector(s);assert.ok(el,s);el.click();await settle();},input(name,value){w.document.querySelector(`[name="${name}"]`).value=value;},async submit(selector='form'){w.document.querySelector(selector).dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await settle();},close(){w.close();}};
}
test('local MAMP account controls stay hidden and make no cloud requests',async()=>{
 const p=page(()=>{throw Error('unexpected request');},{local:true});try{await settle();assert.equal(p.calls.length,0);assert.equal(p.$('#account-button').hidden,true);assert.equal(p.$('#ladder-button').hidden,true);assert.equal(p.w.TroikaAccounts.user(),null);}finally{p.close();}
});
test('owner setup consumes its private fragment, registers with the claim, and supports profile/password/logout',async()=>{
 let current=null;const p=page(async body=>{
  if(body.action==='me')return {user:current,ownerSetupAvailable:true};
  if(body.action==='register'){assert.equal(body.claimToken,'private-owner-claim');current=account({role:'admin',nickname:body.nickname,email:body.email});return {user:current};}
  if(body.action==='profile'){current={...current,nickname:body.nickname,firstName:body.firstName,lastName:body.lastName};return {user:current};}
  if(body.action==='password')return {user:current};
  if(body.action==='logout'){current=null;return {ok:true};}throw Error(body.action);
 },{url:'https://troika.example.test/?room=ABCDE#owner-setup=private-owner-claim'});
 try{
  await settle();assert.equal(p.$('#account-button').hidden,false);assert.equal(p.$('#ladder-button').hidden,false);assert.equal(p.w.location.hash,'');assert.equal(p.w.location.search,'?room=ABCDE');assert.ok(p.$('#account-dialog').open);assert.ok(p.$('#account-title').textContent.includes('Owner'));
  p.input('nickname','Owner');p.input('email','owner@example.test');p.input('password','long-private-password');await p.submit();assert.equal(p.w.TroikaAccounts.user().role,'admin');assert.equal(p.w.localStorage.length,0);assert.equal(p.$('[name="password"]'),null);assert.ok(p.events.some(u=>u?.nickname==='Owner'));
  assert.equal(p.$('#account-dialog').open,false,'registration closes the account dialog');assert.deepEqual(p.notices,['Profile saved. Happy gaming!']);
  await p.click('#account-button');assert.equal(p.$('#account-dialog').open,true);
  p.input('nickname','Renamed');p.input('firstName','Private first');p.input('lastName','Private last');await p.submit();assert.equal(p.w.TroikaAccounts.user().nickname,'Renamed');assert.equal(p.$('#account-button').textContent,'Renamed · 500');
  assert.equal(p.$('#account-dialog').open,false,'saving a profile closes the account dialog');assert.equal(p.notices.at(-1),'Profile saved. Happy gaming!');assert.equal(p.notices.length,2);
  await p.click('#account-button');
  current={...current,elo:900,ratedGames:1};await p.w.TroikaAccounts.refresh();assert.equal(p.$('.account-rating strong').textContent,'900','same-account rating refresh updates an open profile');assert.equal(p.$('#account-button').textContent,'Renamed · 900');
  await p.click('[data-account-view="password"]');p.input('currentPassword','long-private-password');p.input('password','another-long-password');await p.submit();assert.equal(p.calls.find(c=>c.action==='password').currentPassword,'long-private-password');
  await p.click('#account-logout');assert.equal(p.w.TroikaAccounts.user(),null);assert.equal(p.$('#account-button').textContent,'Account');assert.equal(p.errors.length,0);
 }finally{p.close();}
});
test('failed profile save keeps the dialog and entered information visible without a success notice',async()=>{
 const p=page(async body=>{if(body.action==='me')return {user:account()};if(body.action==='profile')return {error:'That nickname is already registered.'};throw Error(body.action);});
 try{
  await settle();await p.click('#account-button');p.input('nickname','AlreadyTaken');p.input('firstName','Keep this name');await p.submit();
  assert.equal(p.$('#account-dialog').open,true);assert.equal(p.$('[name="nickname"]').value,'AlreadyTaken');assert.equal(p.$('[name="firstName"]').value,'Keep this name');assert.equal(p.$('#account-message').hidden,false);assert.equal(p.$('#account-message').textContent,'That nickname is already registered.');assert.equal(p.$('#account-message').classList.contains('account-error'),true);assert.equal(p.$('form button').disabled,false);assert.deepEqual(p.notices,[]);assert.equal(p.w.TroikaAccounts.user().nickname,'Ada');assert.equal(p.errors.length,0);
 }finally{p.close();}
});
test('rankings and match history escape names; admin reset links stay private and corrections have a reason',async()=>{
 let current=account({role:'admin'}),target=account({id:'user2',nickname:'<img src=x onerror=alert(1)>',email:'target@example.test'});
 const p=page(async(body,endpoint)=>{
  if(body.action==='me')return {user:current};
  if(body.action==='leaderboard'){assert.equal(endpoint,'/api/ladder');return {players:[{nickname:target.nickname,tier:'Trash',elo:500,ratedGames:1,wins:1}]};}
  if(body.action==='history')return {matches:[{id:'round1',room:'ABCDE',place:2,change:-8,status:'rated',finishedAt:'2026-11-12T10:00:00Z',players:[{nickname:target.nickname}]}]};
  if(body.action==='admin_users')return {users:[current,target]};
  if(body.action==='admin_reset')return {resetToken:'private-reset-token',expiresAt:Date.now()+900000};
  if(body.action==='admin_suspend'){target={...target,suspended:body.suspended};return {ok:true};}
  if(body.action==='admin_correct'){assert.equal(endpoint,'/api/ladder');target={...target,elo:body.newRating};return {result:{userId:target.id,before:500,after:body.newRating,tier:'Bronze'}};}
  throw Error(body.action);
 });
 try{
  await settle();await p.click('#ladder-button');assert.equal(p.$('#account-content img'),null);assert.ok(p.$('.account-table').textContent.includes(target.nickname));
  await p.click('[data-account-view="history"]');assert.equal(p.$('#account-content img'),null);assert.ok(p.$('.account-match').textContent.includes('Place 2'));assert.ok(p.$('.account-match').textContent.includes('-8 Elo'));assert.ok(p.$('.account-match').textContent.includes(target.nickname));
  await p.click('[data-account-view="admin"]');await p.click('[data-manage-account="user2"]');await p.click('#account-admin-reset');assert.equal(p.$('#account-reset-link').value,'https://troika.example.test/#reset=private-reset-token');assert.equal(p.w.location.hash,'');assert.equal(p.w.localStorage.length,0);
  await p.click('#account-admin-suspend');assert.ok(p.$('#account-admin-suspend').textContent.includes('Restore'));
  p.input('newRating','850');p.input('reason','Correcting a recorded match');await p.submit();const correction=p.calls.find(c=>c.action==='admin_correct');assert.equal(correction.userId,'user2');assert.equal(correction.newRating,850);assert.equal(correction.reason,'Correcting a recorded match');assert.equal(p.errors.length,0);
 }finally{p.close();}
});
test('reset links remove tokens from the address and submit only to the reset endpoint',async()=>{
 const p=page(async body=>{if(body.action==='me')return {user:null};if(body.action==='reset'){assert.equal(body.resetToken,'one-time-reset');return {user:account()};}throw Error(body.action);},{url:'https://troika.example.test/#reset=one-time-reset'});
 try{await settle();assert.equal(p.w.location.hash,'');assert.ok(p.$('#account-title').textContent.includes('Reset'));p.input('password','long-new-password');await p.submit();assert.equal(p.w.TroikaAccounts.user().id,'user1');assert.equal(p.w.localStorage.length,0);assert.equal(p.errors.length,0);}finally{p.close();}
});


test('ranked conduct stays private in profile and leaves casual access available',async()=>{
 const limited=account({rankedStatus:{strikes:3,cooldownUntil:'2099-01-10T12:00:00Z',rankedAllowed:false,nextPenalty:'7 days'}});
 const p=page(async body=>{if(body.action==='me')return {user:limited};if(body.action==='leaderboard')return {players:[{nickname:'Ada',elo:500,rankedStatus:limited.rankedStatus}]};throw Error(body.action);});
 try{
  await settle();await p.click('#account-button');
  assert.ok(p.$('.account-conduct-limited'));assert.ok(p.$('.account-conduct-state').textContent.startsWith('Ranked cooldown until '));assert.ok(p.$('.account-conduct').textContent.includes('3 abandonments in the last 7 days'));assert.ok(p.$('.account-conduct').textContent.includes('Next: 7 days'));assert.ok(p.$('.account-conduct').textContent.includes('5 minutes to reconnect'));assert.ok(p.$('.account-conduct').textContent.includes('Casual games remain available'));
  await p.click('#ladder-button');assert.equal(p.$('.account-conduct'),null);assert.ok(!p.$('#account-content').textContent.includes('cooldown'));
  assert.equal(p.errors.length,0);
 }finally{p.close();}
 const legacy=page(async body=>{if(body.action==='me')return {user:account()};throw Error(body.action);});
 try{await settle();await legacy.click('#account-button');assert.equal(legacy.$('.account-conduct-state').textContent,'Ranked play available');assert.ok(legacy.$('.account-conduct').textContent.includes('0 abandonments'));}finally{legacy.close();}
});

test('administrator clears a selected player ranked penalties with a reason and refreshes private status',async()=>{
 const current=account({role:'admin'});let target=account({id:'user2',nickname:'Boris',rankedStatus:{strikes:2,cooldownUntil:'2099-01-10T12:00:00Z',rankedAllowed:false,nextPenalty:'60 minutes'}});
 const p=page(async(body,endpoint)=>{
  if(body.action==='me')return {user:current};
  if(body.action==='admin_users')return {users:[current,target]};
  if(body.action==='admin_forgive'){
   assert.equal(endpoint,'/api/account');assert.equal(body.userId,'user2');assert.equal(body.reason,'Connection outage verified by teacher');
   target={...target,rankedStatus:{strikes:0,cooldownUntil:null,rankedAllowed:true,nextPenalty:'warning'}};return {success:true};
  }
  throw Error(body.action);
 });
 try{
  await settle();await p.click('#account-button');await p.click('[data-account-view="admin"]');await p.click('[data-manage-account="user2"]');assert.ok(p.$('.account-admin-detail .account-conduct-state').textContent.startsWith('Ranked cooldown until '));
  const form=p.$('form[data-account-form="admin_forgive"]'),reason=form.querySelector('[name="reason"]');assert.equal(reason.minLength,5);assert.equal(reason.maxLength,500);reason.value='Connection outage verified by teacher';
  await p.submit('form[data-account-form="admin_forgive"]');
  assert.equal(p.calls.filter(c=>c.action==='admin_forgive').length,1);assert.equal(p.$('.account-admin-detail .account-conduct-state').textContent,'Ranked play available');assert.ok(p.$('.account-admin-detail .account-conduct').textContent.includes('0 abandonments'));assert.ok(p.$('#account-message').textContent.includes('audit history is kept'));assert.equal(p.$('#account-dialog').open,true);assert.equal(p.notices.length,0);assert.equal(p.errors.length,0);
 }finally{p.close();}
});

test('custom initials and colors are previewed safely and sent only when changed',async()=>{
 let current=account({avatar:{kind:'initial',text:'A',color:'gold'}});
 const p=page(async body=>{if(body.action==='me')return {user:current};if(body.action==='profile'){current={...current,nickname:body.nickname,avatar:Object.hasOwn(body,'avatar')?body.avatar:current.avatar};return {user:current};}throw Error(body.action);});
 try{
  await settle();await p.click('#account-button');assert.equal(p.$('#account-avatar-preview').textContent,'A');assert.ok(p.$('.account-avatar-editor').textContent.includes('visible to everyone'));
  p.$('#account-avatar-initial').value='<b';p.$('#account-avatar-initial').dispatchEvent(new p.w.Event('input',{bubbles:true}));
  assert.equal(p.$('#account-avatar-preview').textContent,'<b');assert.equal(p.$('#account-avatar-preview b'),null);
  p.$('#account-avatar-initial').value='XYZ';p.$('#account-avatar-initial').dispatchEvent(new p.w.Event('input',{bubbles:true}));assert.equal(p.$('#account-avatar-initial').value,'XY');
  await p.click('[data-avatar-color="violet"]');assert.equal(p.$('#account-avatar-preview').dataset.color,'violet');assert.equal(p.$('[data-avatar-color="violet"]').getAttribute('aria-pressed'),'true');
  await p.submit('form[data-account-form="profile"]');const saved=p.calls.find(c=>c.action==='profile');assert.deepEqual(saved.avatar,{kind:'initial',text:'XY',color:'violet'});assert.equal(saved.avatarInitial,undefined);assert.equal(p.$('#account-dialog').open,false);assert.equal(p.notices.at(-1),'Profile saved. Happy gaming!');
  await p.click('#account-button');assert.equal(p.$('#account-avatar-preview').textContent,'XY');await p.submit('form[data-account-form="profile"]');assert.equal(Object.hasOwn(p.calls.filter(c=>c.action==='profile').at(-1),'avatar'),false,'unchanged avatar is omitted');
  await p.click('#account-button');await p.click('#account-avatar-reset');assert.equal(p.$('#account-avatar-preview').textContent,'A');await p.submit('form[data-account-form="profile"]');assert.equal(p.calls.filter(c=>c.action==='profile').at(-1).avatar,null);assert.equal(p.w.localStorage.length,0);assert.equal(p.errors.length,0);
 }finally{p.close();}
});

test('raster upload crops a square preview without losing unsaved profile fields',async()=>{
 const encoded='data:image/webp;base64,UklGRgAAAABXRUJQ',draws=[],revoked=[];let current=account();
 const p=page(async body=>{if(body.action==='me')return {user:current};if(body.action==='profile'){current={...current,firstName:body.firstName,lastName:body.lastName,avatar:body.avatar};return {user:current};}throw Error(body.action);});
 try{
  await settle();await p.click('#account-button');
  p.w.URL.createObjectURL=()=> 'blob:avatar-test';p.w.URL.revokeObjectURL=url=>revoked.push(url);
  p.w.Image=class{constructor(){this.naturalWidth=200;this.naturalHeight=100;}set src(value){this._src=value;queueMicrotask(()=>this.onload());}};
  p.w.HTMLCanvasElement.prototype.getContext=()=>({drawImage:(...args)=>draws.push(args)});p.w.HTMLCanvasElement.prototype.toDataURL=function(type,quality){assert.equal(this.width,96);assert.equal(this.height,96);assert.equal(type,'image/webp');assert.ok(quality<=.78);return encoded;};
  p.input('firstName','Keep edited first');p.input('lastName','Keep edited last');p.$('#account-avatar-initial').value='AZ';p.$('#account-avatar-initial').dispatchEvent(new p.w.Event('input',{bubbles:true}));
  const file=new p.w.File(['small raster'],'photo.webp',{type:'image/webp'}),input=p.$('#account-avatar-file');Object.defineProperty(input,'files',{configurable:true,value:[file]});input.dispatchEvent(new p.w.Event('change',{bubbles:true}));
  assert.equal(p.$('form[data-account-form="profile"] button[type="submit"]').disabled,true);await settle();
  assert.equal(p.$('[name="firstName"]').value,'Keep edited first');assert.equal(p.$('[name="lastName"]').value,'Keep edited last');assert.equal(p.$('#account-avatar-initial').value,'AZ');assert.equal(p.$('#account-avatar-preview img').getAttribute('src'),encoded);assert.deepEqual(draws[0].slice(1),[50,0,100,100,0,0,96,96]);assert.deepEqual(revoked,['blob:avatar-test']);assert.equal(p.calls.filter(c=>c.action==='profile').length,0,'upload alone never saves');
  await p.submit('form[data-account-form="profile"]');const saved=p.calls.find(c=>c.action==='profile');assert.deepEqual(saved.avatar,{kind:'image',dataUrl:encoded});assert.equal(saved.firstName,'Keep edited first');assert.equal(saved.lastName,'Keep edited last');assert.equal(p.$('#account-dialog').open,false);assert.equal(p.errors.length,0);
 }finally{p.close();}
});

test('unsupported, oversized and unprocessable uploads keep the profile editable and never save',async()=>{
 const p=page(async body=>{if(body.action==='me')return {user:account({avatar:{kind:'image',dataUrl:'https://tracker.example/avatar.svg'}})};throw Error(body.action);});
 try{
  await settle();await p.click('#account-button');assert.equal(p.$('#account-avatar-preview img'),null,'external avatar URLs are not loaded');p.input('firstName','Keep this edit');
  const input=p.$('#account-avatar-file'),choose=async file=>{Object.defineProperty(input,'files',{configurable:true,value:[file]});input.dispatchEvent(new p.w.Event('change',{bubbles:true}));await settle();};
  await choose({type:'image/svg+xml',size:100});assert.ok(p.$('#account-avatar-status').textContent.includes('PNG, JPEG or WebP'));assert.equal(p.$('#account-dialog').open,true);
  await choose({type:'image/png',size:5*1024*1024+1});assert.ok(p.$('#account-avatar-status').textContent.includes('smaller than 5 MB'));
  const revoked=[];p.w.URL.createObjectURL=()=> 'blob:unsupported-canvas';p.w.URL.revokeObjectURL=url=>revoked.push(url);p.w.Image=class{constructor(){this.naturalWidth=100;this.naturalHeight=100;}set src(value){queueMicrotask(()=>this.onload());}};p.w.HTMLCanvasElement.prototype.getContext=()=>null;
  await choose({type:'image/png',size:100});assert.ok(p.$('#account-avatar-status').textContent.includes('cannot process avatar uploads'));assert.equal(p.$('[name="firstName"]').value,'Keep this edit');assert.equal(p.$('form[data-account-form="profile"] button[type="submit"]').disabled,false);assert.deepEqual(revoked,['blob:unsupported-canvas']);assert.equal(p.calls.filter(c=>c.action==='profile').length,0);assert.equal(p.$('#account-dialog').open,true);assert.equal(p.errors.length,0);
 }finally{p.close();}
});
