'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {randomBytes}=require('node:crypto');
const {e,card,ids}=require('./fixtures.cjs');
const {tk_dispatch,initDatabase}=require('../../cloud/service.js');
const connectionString=process.env.TEST_DATABASE_URL;
let pool,admin,schema;
const dbTest=(name,fn)=>test(name,{skip:!connectionString},fn);
test.before(async()=>{
  if(!connectionString)return;
  const {Pool}=require('pg');schema='troika_test_'+randomBytes(8).toString('hex');admin=new Pool({connectionString,max:1});
  await admin.query('CREATE SCHEMA '+schema);pool=new Pool({connectionString,max:8,options:'-c search_path='+schema});await initDatabase(pool);
});
test.after(async()=>{if(pool)await pool.end();if(admin){await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();}});
const req=(action,auth={},data={})=>tk_dispatch(pool,{...auth,...data,action});
const auth=r=>({room:r.room,token:r.token});
async function load(room){return (await pool.query('SELECT state FROM troika_rooms WHERE code=$1',[room])).rows[0].state;}
async function save(g){await pool.query('UPDATE troika_rooms SET state=$2::jsonb WHERE code=$1',[g.room,JSON.stringify(g)]);}
async function fixture(settings={jumpIn:true}){
  const host=await req('create',{}, {nickname:'Ada',seat:0,...settings});const h=auth(host),people=[host],auths=[h];
  for(const [i,name] of ['Boris','Cora'].entries()){const r=await req('join',{room:host.room},{nickname:name,seat:i+1});people.push(r);auths.push(auth(r));await req('ready',auth(r),{ready:true});}
  await req('start',h);const g=await load(host.room);g.deck=[];g.pile=[card(13,'S'),card(13,'H'),card(13,'D')];g.hole=[];g.openingRank=null;g.turnId=g.players[0].id;g.botAt=e.tk_now()+3600;g.paused=false;g.lastMove=null;g.recentCards=[];
  for(const p of g.players){p.hand=[card(13,'C'),card(14)];p.up=[card(8)];p.down=[card(2)];p.finish=null;p.stats={pickups:0,burns:0};}await save(g);return {g,auths,people};
}

dbTest('PostgreSQL lobby validates settings and enforces seat ownership, auth and readiness',async()=>{
  await assert.rejects(()=>req('create',{}, {nickname:'Bad',mode:'expanded',maxPlayers:12,decks:2}));
  const host=await req('create',{}, {nickname:'Māra',seat:4}),h=auth(host);
  assert.equal(host.token.length,48);assert.equal(host.state.hostId,host.state.youId);assert.equal(host.state.players[0].ready,true);
  assert.deepEqual((await req('lobby',{room:host.room})).lobby,{room:host.room,status:'lobby',settings:{mode:'standard',maxPlayers:5,decks:1},players:[{name:'Māra',seat:4,bot:false}]});
  const guest=await req('join',{room:host.room},{nickname:'Guest',seat:0}),a=auth(guest);
  await assert.rejects(()=>req('join',{room:host.room},{nickname:'Other',seat:0}));
  await assert.rejects(()=>req('join',{room:host.room},{nickname:'māra',seat:1}));
  await assert.rejects(()=>req('state',{room:host.room,token:'0'.repeat(48)}),err=>err.status===401);
  await assert.rejects(()=>req('bot',a,{seat:1}),err=>err.status===403);
  await assert.rejects(()=>req('start',h));await req('ready',a,{ready:true});
  await req('seat',a,{seat:1});assert.equal((await req('state',a)).state.players.find(p=>p.id===guest.state.youId).ready,false);
  await req('ready',a,{ready:true});const started=(await req('start',h)).state;
  assert.equal(started.status,'playing');assert.equal(started.deckCount,34);
  for(const p of started.players){assert.equal(p.handCount,3);assert.equal(p.up.length,3);assert.equal(p.downCount,3);assert.equal(p.id===started.youId?Array.isArray(p.hand):p.hand===null,true);assert.ok(!('tokenHash' in p));}
  assert.equal(JSON.stringify(started).includes(host.token),false);
  await assert.rejects(()=>req('join',{room:host.room},{nickname:'Late',seat:2}));
});

dbTest('twelve-player multi-deck rooms persist through an independent pool',async()=>{
  const settings={mode:'expanded',maxPlayers:12,decks:3,burnRule:'all_suits',jumpIn:true};
  const host=await req('create',{}, {nickname:'Large host',seat:11,...settings}),h=auth(host);
  for(let seat=0;seat<11;seat++)await req('bot',h,{seat});
  await assert.rejects(()=>req('bot',h,{seat:12}));
  const view=(await req('start',h)).state;assert.equal(view.players.length,12);assert.equal(view.deckCount,48);assert.deepEqual(view.settings,settings);
  const g=await load(host.room);assert.equal(ids(g).length,156);assert.equal(new Set(ids(g)).size,156);
  const {Pool}=require('pg');const other=new Pool({connectionString,max:1,options:'-c search_path='+schema});
  try{const restored=await tk_dispatch(other,{action:'state',...h});assert.equal(restored.state.room,host.room);assert.equal(restored.state.youId,view.youId);assert.equal(restored.state.players.length,12);}finally{await other.end();}
});

dbTest('rejected moves rollback complete stored game including heartbeat',async()=>{
  const {g,auths}=await fixture();const before=await load(g.room);
  await assert.rejects(()=>req('play',auths[1],{source:'hand',cards:[g.players[1].hand[0].id]}));
  assert.deepEqual(await load(g.room),before);
  await assert.rejects(()=>req('play',auths[0],{source:'hand',cards:['not-owned']}));assert.deepEqual(await load(g.room),before);
});

dbTest('row lock lets exactly one of two simultaneous joins claim an empty seat',async()=>{
  const host=await req('create',{}, {nickname:'Race host'});
  const outcomes=await Promise.allSettled(['First','Second'].map(nickname=>req('join',{room:host.room},{nickname,seat:1})));
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(outcomes.filter(x=>x.status==='rejected').length,1);
  const g=await load(host.room);assert.equal(g.players.length,2);assert.equal(g.players.filter(p=>p.seat===1).length,1);
});

dbTest('row lock accepts one jump in a race and never consumes the losing card',async()=>{
  const {g,auths}=await fixture();const original=ids(g),version=g.version;
  const outcomes=await Promise.allSettled([1,2].map(i=>req('jump',auths[i],{source:'hand',card:g.players[i].hand[0].id,version})));
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(outcomes.filter(x=>x.status==='rejected').length,1);
  const after=await load(g.room);assert.equal(after.pile.length,0);assert.equal(after.hole.length,4);assert.deepEqual(ids(after),original);
  const winner=outcomes.findIndex(x=>x.status==='fulfilled')+1,loser=winner===1?2:1;
  assert.equal(after.turnId,g.players[winner].id);assert.ok(after.players[loser].hand.some(c=>c.id===g.players[loser].hand[0].id));assert.equal(after.lastMove.type,'jump');
});

dbTest('simultaneous legal play and heartbeat preserve both changes',async()=>{
  const {g,auths}=await fixture({jumpIn:false});
  g.players[1].lastSeen=0;await save(g);const played=g.players[0].hand[0].id;
  await Promise.all([req('play',auths[0],{source:'hand',cards:[played]}),req('state',auths[1])]);
  const after=await load(g.room);assert.equal(after.pile.length,0);assert.equal(after.hole.length,4);assert.ok(!after.players[0].hand.some(c=>c.id===played));assert.ok(after.players[1].lastSeen>0);
});

dbTest('pause freezes all game actions and bots; authority transfers if paused host leaves',async()=>{
  const {g,auths}=await fixture();await assert.rejects(()=>req('pause',auths[1],{paused:true}),err=>err.status===403);
  const paused=(await req('pause',auths[0],{paused:true})).state;assert.equal(paused.paused,true);assert.deepEqual(paused.jumpCards,[]);
  await assert.rejects(()=>req('play',auths[0],{source:'hand',cards:[g.players[0].hand[0].id]}));await assert.rejects(()=>req('pickup',auths[0]));
  await assert.rejects(()=>req('jump',auths[1],{source:'hand',card:g.players[1].hand[0].id,version:paused.version}));
  const before=await load(g.room);await req('state',auths[1]);assert.equal((await load(g.room)).turnId,before.turnId);
  await req('leave',auths[0]);const next=(await req('state',auths[1])).state;assert.equal(next.hostId,next.youId);assert.equal(next.paused,true);
  assert.equal((await req('pause',auths[1],{paused:false})).state.paused,false);
});

dbTest('disconnect takeover invalidates the old player key',async()=>{
  const {g,auths}=await fixture();g.players[1].lastSeen=0;g.paused=true;await save(g);
  const takeover=(await req('replace_bot',auths[0],{seat:1})).state;assert.equal(takeover.players[1].bot,true);
  await assert.rejects(()=>req('state',auths[1]),err=>err.status===401);
});

dbTest('host kicks a lobby player by ID, frees their seat, and rejects unauthorized or stale targets',async()=>{
  const host=await req('create',{}, {nickname:'Kick host',seat:4}),h=auth(host);
  const guest=await req('join',{room:host.room},{nickname:'Guest',seat:1}),a=auth(guest),target=guest.state.youId;
  await req('bot',h,{seat:2});const before=await load(host.room),bot=before.players.find(p=>p.bot);
  await assert.rejects(()=>req('kick',a,{playerId:host.state.youId}),err=>err.status===403);
  for(const playerId of [undefined,null,1,{},'',target+'x','f'.repeat(24),host.state.youId,bot.id]) {
    await assert.rejects(()=>req('kick',h,{playerId}));assert.deepEqual(await load(host.room),before);
  }
  const kicked=(await req('kick',h,{playerId:target})).state;
  assert.equal(kicked.players.length,2);assert.equal(kicked.players.some(p=>p.id===target),false);assert.equal(kicked.hostId,host.state.youId);
  assert.equal(kicked.events.at(-1).text,'Kick host kicked Guest from the table.');
  await assert.rejects(()=>req('state',a),err=>err.status===401);
  const replacement=await req('join',{room:host.room},{nickname:'Replacement',seat:1});
  const after=await load(host.room);await assert.rejects(()=>req('kick',h,{playerId:target}));assert.deepEqual(await load(host.room),after);
  assert.equal((await req('state',auth(replacement))).state.youId,replacement.state.youId);
});

dbTest('host can kick connected or offline players during active or paused rounds without losing cards',async()=>{
  for(const paused of [false,true])for(const offline of [false,true]) {
    const {g,auths}=await fixture({jumpIn:false});g.paused=paused;g.turnId=g.players[1].id;g.botAt=0;
    g.players[1].lastSeen=offline?0:e.tk_now();await save(g);
    const target=structuredClone(g.players[1]),cards=ids(g),turn=g.turnId,before=e.tk_now();
    const kicked=(await req('kick',auths[0],{playerId:target.id})).state,stored=await load(g.room),player=stored.players[1];
    assert.deepEqual(player,{...target,bot:true,tokenHash:'',ready:true});assert.deepEqual(ids(stored),cards);assert.equal(stored.turnId,turn);assert.equal(stored.paused,paused);
    assert.ok(stored.botAt>=before+0.85);assert.equal(kicked.events.at(-1).text,'Ada kicked Boris; a bot takes over.');
    assert.equal(kicked.players[1].hand,null);await assert.rejects(()=>req('state',auths[1]),err=>err.status===401);
    const snapshot=await load(g.room);await assert.rejects(()=>req('kick',auths[0],{playerId:target.id}));assert.deepEqual(await load(g.room),snapshot);
    stored.botAt=0;await save(stored);await req('state',auths[0]);const progressed=await load(g.room);
    if(paused){assert.deepEqual(progressed.players[1],player);assert.equal(progressed.turnId,turn);}
    else assert.equal(progressed.lastMove.playerId,target.id,'bot resumes kicked player turn on a later poll');
    assert.deepEqual(ids(progressed),cards);
  }
});

dbTest('kicking after a finished round keeps results and scoreboard intact and revokes the old key',async()=>{
  const {g,auths}=await fixture();g.status='finished';g.turnId=null;g.results=g.players.map(p=>p.id);
  g.players.forEach((p,i)=>p.finish=i+1);e.tk_record_scores(g);await save(g);
  const scores=structuredClone(g.scoreboard),results=[...g.results],target=g.players[1];
  const view=(await req('kick',auths[0],{playerId:target.id})).state;
  assert.equal(view.players.find(p=>p.id===target.id).bot,true);assert.deepEqual(view.results,results);assert.deepEqual((await load(g.room)).scoreboard,{...scores,[target.id]:{...scores[target.id],bot:true}});
  await assert.rejects(()=>req('state',auths[1]),err=>err.status===401);
  const rematch=(await req('rematch',auths[0])).state;assert.equal(rematch.players.find(p=>p.id===target.id).bot,true);
});

dbTest('rematches keep settings and completed score exactly once but reset replay and history',async()=>{
  const {g,auths}=await fixture({jumpIn:true,burnRule:'all_suits'});g.pile=[];g.results=[];g.turnId=g.players[0].id;
  for(const p of g.players){p.hand=[card(2)];p.up=[];p.down=[];p.stats={burns:2,pickups:3};}
  e.tk_play(g,g.players[0].id,'hand',[g.players[0].hand[0].id]);e.tk_play(g,g.players[1].id,'hand',[g.players[1].hand[0].id]);await save(g);
  const result=(await req('state',auths[0])).state,score=result.scoreboard;assert.equal(result.status,'finished');assert.equal(score.reduce((sum,p)=>sum+p.wins,0),1);
  await req('state',auths[1]);assert.deepEqual((await req('state',auths[0])).state.scoreboard,score);
  const rematch=(await req('rematch',auths[0])).state;assert.deepEqual(rematch.scoreboard,score);assert.deepEqual(rematch.settings,result.settings);assert.deepEqual(rematch.recentCards,[]);assert.equal(rematch.lastMove,null);assert.equal(rematch.paused,false);
});

dbTest('independent cold function pools can initialize the same new schema concurrently',async()=>{
  const {Pool}=require('pg'),coldSchema='troika_cold_'+randomBytes(8).toString('hex');
  await admin.query('CREATE SCHEMA '+coldSchema);
  const first=new Pool({connectionString,max:2,options:'-c search_path='+coldSchema});
  const second=new Pool({connectionString,max:2,options:'-c search_path='+coldSchema});
  try{
    await Promise.all([initDatabase(first),initDatabase(second)]);
    const created=await tk_dispatch(first,{action:'create',nickname:'Cold host',seat:0});
    const restored=await tk_dispatch(second,{action:'state',...auth(created)});
    assert.equal(restored.state.room,created.room);assert.equal(restored.state.youId,created.state.youId);
  }finally{await first.end();await second.end();await admin.query('DROP SCHEMA '+coldSchema+' CASCADE');}
});
