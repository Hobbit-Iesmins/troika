'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {JSDOM,VirtualConsole}=require('jsdom');
const source=fs.readFileSync(path.join(__dirname,'../../assets/accounts.js'),'utf8');
const account=(extra={})=>({id:'user1',nickname:'Ada',email:'ada@example.test',firstName:'Ada',lastName:'Private',role:'user',suspended:false,elo:500,ratedGames:0,wins:0,lastPlaces:0,placementSum:0,peakElo:500,...extra});
const tick=()=>new Promise(r=>setImmediate(r));
async function settle(){for(let i=0;i<5;i++)await tick();}
function page(handler,{url='https://troika.example.test/',local=false}={}){
 const calls=[],errors=[],events=[];const vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e));
 const dom=new JSDOM(`<meta name="troika-api" content="${local?'api.php':'/api/game'}"><button id="account-button" hidden>Account</button><button id="ladder-button" hidden>Rankings</button><dialog id="account-dialog"><div id="account-content"></div></dialog>`,{url,runScripts:'outside-only',virtualConsole:vc,pretendToBeVisual:true});const w=dom.window;
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
 w.fetch=async(endpoint,options)=>{const body=JSON.parse(options.body);calls.push({endpoint,...body});const result=await handler(body,endpoint);return {ok:!result.error,json:async()=>result};};
 w.document.addEventListener('troika-account-change',e=>events.push(e.detail.user));w.eval(source);
 return {w,calls,errors,events,$:s=>w.document.querySelector(s),$$:s=>[...w.document.querySelectorAll(s)],async click(s){const el=w.document.querySelector(s);assert.ok(el,s);el.click();await settle();},input(name,value){w.document.querySelector(`[name="${name}"]`).value=value;},async submit(){w.document.querySelector('form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await settle();},close(){w.close();}};
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
  p.input('nickname','Renamed');p.input('firstName','Private first');p.input('lastName','Private last');await p.submit();assert.equal(p.w.TroikaAccounts.user().nickname,'Renamed');assert.equal(p.$('#account-button').textContent,'Renamed · 500');
  current={...current,elo:900,ratedGames:1};await p.w.TroikaAccounts.refresh();assert.equal(p.$('.account-rating strong').textContent,'900','same-account rating refresh updates an open profile');assert.equal(p.$('#account-button').textContent,'Renamed · 900');
  await p.click('[data-account-view="password"]');p.input('currentPassword','long-private-password');p.input('password','another-long-password');await p.submit();assert.equal(p.calls.find(c=>c.action==='password').currentPassword,'long-private-password');
  await p.click('#account-logout');assert.equal(p.w.TroikaAccounts.user(),null);assert.equal(p.$('#account-button').textContent,'Account');assert.equal(p.errors.length,0);
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
