'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomBytes}=require('node:crypto'),{Pool}=require('pg');
const E=require('../../cloud/engine.js'),A=require('../../cloud/accounts.js'),S=require('../../cloud/service.js');
const {fixture}=require('./fixtures.cjs');
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6u9kAAAAASUVORK5CYII=';
const initial={kind:'initial',text:'ĀB',color:'mint'};
test('avatar validation accepts bounded initials and raster images without external URLs or extra fields',()=>{
 assert.deepEqual(E.tk_avatar(initial),initial);assert.deepEqual(E.tk_avatar({kind:'initial'}),{kind:'initial',text:'',color:'gold'});assert.deepEqual(E.tk_avatar({kind:'image',dataUrl:png}),{kind:'image',dataUrl:png});
 const fake=Buffer.alloc(30);fake.write('RIFF',0);fake.write('WEBP',8);fake.write('VP8X',12);fake.writeUIntLE(95,24,3);fake.writeUIntLE(95,27,3);assert.ok(E.tk_avatar({kind:'image',dataUrl:'data:image/webp;base64,'+fake.toString('base64')}));
 for(const value of [null,[],{},'A',{kind:'initial',text:'ABC',color:'gold'},{kind:'initial',text:'<',color:'gold'},{kind:'initial',text:'A\n',color:'gold'},{kind:'initial',text:'A',color:'javascript:alert(1)'},{...initial,email:'private@example.test'},{kind:'image',dataUrl:'https://external.example/avatar.jpg'},{kind:'image',dataUrl:'data:image/svg+xml;base64,'+Buffer.from('<svg/>').toString('base64')},{kind:'image',dataUrl:png.replace('png','jpeg')},{kind:'image',dataUrl:'data:image/png;base64,'+'A'.repeat(24000)},{kind:'image',dataUrl:png,url:'https://external.example/'}])assert.equal(E.tk_avatar(value),null,JSON.stringify(value).slice(0,120));
 const huge=Buffer.from(png.split(',')[1],'base64');huge.writeUInt32BE(257,16);assert.equal(E.tk_avatar({kind:'image',dataUrl:'data:image/png;base64,'+huge.toString('base64')}),null);
});
test('public avatar views are detached and omit malformed or private metadata',()=>{
 const g=fixture();g.players[0].avatar=structuredClone(initial);g.players[0].email='private@example.test';const view=E.tk_view(g,g.players[1].id);assert.deepEqual(view.players[0].avatar,initial);assert.ok(!JSON.stringify(view).includes('private@example.test'));view.players[0].avatar.text='Z';assert.equal(g.players[0].avatar.text,'ĀB');
 g.players[0].avatar={kind:'image',dataUrl:'javascript:alert(1)'};assert.ok(!('avatar' in E.tk_view(g,g.players[1].id).players[0]));
});
const connectionString=process.env.TEST_DATABASE_URL;
async function database(fn){const schema='troika_avatar_'+randomBytes(8).toString('hex'),admin=new Pool({connectionString,max:1});let pool;try{await admin.query('CREATE SCHEMA '+schema);pool=new Pool({connectionString,max:5,options:'-c search_path='+schema});await S.initDatabase(pool);await fn(pool);}finally{await pool?.end();await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();}}
async function register(pool,name){const r=await A.dispatchAccount(pool,{action:'register',nickname:name,email:name+'@example.test',password:'test-password-only'},{secure:false,ip:name});return {user:r.body.user,cookie:r.cookie.split(';')[0]};}
test('profile avatar persists, omission preserves it, null resets it, and invalid updates roll back',{skip:!connectionString},()=>database(async pool=>{
 const member=await register(pool,'AvatarUser');assert.equal(member.user.avatar,null);const req=data=>A.dispatchAccount(pool,{action:'profile',nickname:'AvatarUser',firstName:'Private',lastName:'Person',...data},{cookie:member.cookie});
 assert.deepEqual((await req({avatar:initial})).body.user.avatar,initial);assert.deepEqual((await req({})).body.user.avatar,initial);
 await assert.rejects(()=>req({avatar:{kind:'image',dataUrl:'https://tracker.example/avatar.jpg'}}),e=>e.status===400);assert.deepEqual((await A.dispatchAccount(pool,{action:'me'},{cookie:member.cookie})).body.user.avatar,initial);
 assert.deepEqual((await req({avatar:{kind:'image',dataUrl:png}})).body.user.avatar,{kind:'image',dataUrl:png});assert.equal((await req({avatar:null})).body.user.avatar,null);
}));
test('signed-in seats snapshot avatars and refresh their avatar once on the next own authenticated state',{skip:!connectionString},()=>database(async pool=>{
 const host=await register(pool,'AvatarHost'),peer=await register(pool,'AvatarPeer');const profile=data=>A.dispatchAccount(pool,{action:'profile',nickname:'AvatarHost',...data},{cookie:host.cookie});await profile({avatar:initial});
 const made=await S.tk_dispatch(pool,{action:'create',seat:0},{cookie:host.cookie}),auth={room:made.room,token:made.token};assert.deepEqual(made.state.players[0].avatar,initial);
 const joined=await S.tk_dispatch(pool,{action:'join',room:made.room,seat:1},{cookie:peer.cookie});assert.deepEqual(joined.state.players[0].avatar,initial);assert.ok(!JSON.stringify(joined.state).includes('AvatarHost@example.test'));
 const before=(await pool.query('SELECT state FROM troika_rooms WHERE code=$1',[made.room])).rows[0].state;const changed={kind:'initial',text:'Z',color:'violet'};await profile({avatar:changed});
 assert.deepEqual((await pool.query('SELECT state FROM troika_rooms WHERE code=$1',[made.room])).rows[0].state.players[0].avatar,initial,'profile change does not mutate a previously stored snapshot');
 const next=(await S.tk_dispatch(pool,{action:'state',...auth},{cookie:host.cookie})).state;assert.deepEqual(next.players[0].avatar,changed);assert.equal(next.version,before.version+1);
 const again=(await S.tk_dispatch(pool,{action:'state',...auth},{cookie:host.cookie})).state;assert.equal(again.version,next.version,'unchanged avatar heartbeats do not restart turn animations');
 await profile({avatar:null});const cleared=(await S.tk_dispatch(pool,{action:'state',...auth},{cookie:host.cookie})).state;assert.ok(!('avatar' in cleared.players[0]));
}));
