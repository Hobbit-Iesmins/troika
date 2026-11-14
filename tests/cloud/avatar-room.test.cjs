'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomBytes,createHash}=require('node:crypto'),{Pool}=require('pg');
const E=require('../../cloud/engine.js'),A=require('../../cloud/accounts.js'),S=require('../../cloud/service.js');
const connectionString=process.env.TEST_DATABASE_URL;
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6u9kAAAAASUVORK5CYII=','base64');
const photo=n=>({kind:'image',dataUrl:'data:image/png;base64,'+Buffer.concat([png,Buffer.alloc(15000,n)]).toString('base64')});
const compact=image=>({kind:'image',version:createHash('sha256').update(image.dataUrl).digest('hex').slice(0,16)});
async function database(fn){const schema='troika_avatar_room_'+randomBytes(8).toString('hex'),admin=new Pool({connectionString,max:1});let pool;try{await admin.query('CREATE SCHEMA '+schema);pool=new Pool({connectionString,max:5,options:'-c search_path='+schema});await S.initDatabase(pool);await fn(pool);}finally{await pool?.end();await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();}}
async function register(pool,n){const nickname='ImageMember'+n,result=await A.dispatchAccount(pool,{action:'register',nickname,email:nickname+'@example.test',password:'test-password-only'},{secure:false,ip:nickname});return {id:result.body.user.id,nickname,cookie:result.cookie.split(';')[0]};}
async function profile(pool,user,avatar){return A.dispatchAccount(pool,{action:'profile',nickname:user.nickname,avatar},{cookie:user.cookie,ip:user.nickname});}
const auth=game=>({room:game.room,token:game.token});
test('a twelve-photo room stores compact references on create/join/poll and publishes versioned URLs',{skip:!connectionString},()=>database(async pool=>{
 const members=[];for(let i=0;i<12;i++){const user=await register(pool,i);await profile(pool,user,photo(i));members.push(user);}
 const game=await S.tk_dispatch(pool,{action:'create',mode:'expanded',maxPlayers:12,decks:4,seat:0},{cookie:members[0].cookie});
 for(let i=1;i<12;i++){const joined=await S.tk_dispatch(pool,{action:'join',room:game.room,seat:i},{cookie:members[i].cookie});await S.tk_dispatch(pool,{action:'ready',...auth(joined),ready:true},{cookie:members[i].cookie});}
 await S.tk_dispatch(pool,{action:'start',...auth(game)},{cookie:members[0].cookie});
 const stored=async()=>(await pool.query('SELECT state FROM troika_rooms WHERE code=$1',[game.room])).rows[0].state;
 const before=await stored();assert.equal(before.status,'playing');assert.equal(before.players.length,12);assert.ok(Buffer.byteLength(JSON.stringify(before))<40000,'the full four-deck game remains small with twelve large account photos');
 for(let i=0;i<12;i++)assert.deepEqual(before.players[i].avatar,compact(photo(i)));
 assert.ok(!JSON.stringify(before).includes('data:image/'));
 const state=(await S.tk_dispatch(pool,{action:'state',...auth(game)},{cookie:members[0].cookie})).state;
 for(let i=0;i<12;i++)assert.deepEqual(state.players[i].avatar,{kind:'image',url:'/api/avatar?user='+members[i].id+'&v='+compact(photo(i)).version});
 assert.equal(state.version,before.version,'ordinary photo-owner polling does not generate profile events');
 assert.ok(!JSON.stringify(await stored()).includes('data:image/'));
 const replacement=photo(99);await profile(pool,members[0],replacement);
 const changed=(await S.tk_dispatch(pool,{action:'state',...auth(game)},{cookie:members[0].cookie})).state;assert.equal(changed.version,state.version+1);assert.deepEqual((await stored()).players[0].avatar,compact(replacement));assert.ok(changed.players[0].avatar.url.endsWith(compact(replacement).version));
 const again=(await S.tk_dispatch(pool,{action:'state',...auth(game)},{cookie:members[0].cookie})).state;assert.equal(again.version,changed.version);
 const badge={kind:'initial',text:'ZZ',color:'coral'};await profile(pool,members[0],badge);const initial=(await S.tk_dispatch(pool,{action:'state',...auth(game)},{cookie:members[0].cookie})).state;assert.deepEqual(initial.players[0].avatar,badge);assert.deepEqual((await stored()).players[0].avatar,badge);
 await profile(pool,members[0],null);const reset=(await S.tk_dispatch(pool,{action:'state',...auth(game)},{cookie:members[0].cookie})).state;assert.ok(!('avatar' in reset.players[0]));assert.ok(!('avatar' in (await stored()).players[0]));
}));
test('a peer poll compacts every legacy inline photo without waiting for each owner to return',{skip:!connectionString},()=>database(async pool=>{
 const host=await register(pool,0),peer=await register(pool,1);await profile(pool,host,photo(0));await profile(pool,peer,photo(1));
 const made=await S.tk_dispatch(pool,{action:'create',seat:0},{cookie:host.cookie}),joined=await S.tk_dispatch(pool,{action:'join',room:made.room,seat:1},{cookie:peer.cookie});
 const g=(await pool.query('SELECT state FROM troika_rooms WHERE code=$1',[made.room])).rows[0].state;
 g.players[0].avatar=photo(0);g.players[1].avatar=photo(1);
 const orphan=E.tk_new_player('Old orphan photo',2,true);orphan.avatar=photo(2);g.players.push(orphan);
 const badge=E.tk_new_player('Legacy initial badge',3,true);badge.avatar={kind:'initial',text:'LL',color:'mint'};g.players.push(badge);
 await pool.query('UPDATE troika_rooms SET state=$2::jsonb WHERE code=$1',[made.room,JSON.stringify(g)]);
 const state=(await S.tk_dispatch(pool,{action:'state',...auth(joined)},{cookie:peer.cookie})).state;
 const stored=(await pool.query('SELECT state FROM troika_rooms WHERE code=$1',[made.room])).rows[0].state;
 assert.deepEqual(stored.players[0].avatar,compact(photo(0)));assert.deepEqual(stored.players[1].avatar,compact(photo(1)));assert.ok(!('avatar' in stored.players[2]));assert.deepEqual(stored.players[3].avatar,badge.avatar);
 assert.equal(state.version,g.version,'format migration keeps the same visible image and table version');assert.ok(!JSON.stringify(stored).includes('dataUrl'));assert.ok(state.players[0].avatar.url.endsWith(compact(photo(0)).version));assert.ok(!('avatar' in state.players[2]));
}));
