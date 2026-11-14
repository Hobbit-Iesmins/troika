'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomBytes}=require('node:crypto');
const C=require('../../cloud/conduct.js');
const connectionString=process.env.TEST_DATABASE_URL;
let pool,admin,schema;
const T=1700000000,id=()=>randomBytes(12).toString('hex'),match=()=>randomBytes(16).toString('hex');
const dbTest=(name,fn)=>test(name,{skip:!connectionString},fn);
test.before(async()=>{if(!connectionString)return;const {Pool}=require('pg');schema='troika_conduct_'+randomBytes(8).toString('hex');admin=new Pool({connectionString,max:1});await admin.query('CREATE SCHEMA '+schema);pool=new Pool({connectionString,max:8,options:'-c search_path='+schema});await pool.query("CREATE TABLE troika_accounts(id TEXT PRIMARY KEY,role TEXT NOT NULL DEFAULT 'user',suspended BOOLEAN NOT NULL DEFAULT FALSE)");await pool.query(C.SQL);});
test.after(async()=>{await pool?.end();if(admin){await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();}});
async function transaction(fn){const c=await pool.connect();try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
async function account(role='user'){const accountId=id();await pool.query('INSERT INTO troika_accounts(id,role) VALUES($1,$2)',[accountId,role]);return accountId;}
async function record(accountId,at=T,other={}){return transaction(c=>C.recordAbandonment(c,{matchId:match(),accountId,room:'TESTX',reason:'left',occurredAt:at,...other}));}
async function fixture(count=3){const players=[];for(let i=0;i<count;i++)players.push({id:id(),accountId:await account(),name:'Player '+i,bot:false,finish:null,lastSeen:T,tokenHash:'seat-key',ready:true});return {ranked:true,status:'playing',paused:false,room:'TESTX',players,hostId:players[0].id,ranking:{id:match(),status:'pending',startedAt:new Date(T*1000).toISOString(),participants:players.map(p=>({accountId:p.accountId,playerId:p.id}))},version:1,events:[],eventSeq:0,botAt:T};}

dbTest('four departures escalate warning, 30 minutes, 60 minutes and seven days using a rolling window',async()=>{
 const who=await account();const entries=[];for(let i=0;i<4;i++)entries.push(await record(who,T+i));
 assert.deepEqual(entries.map(e=>e.level),[1,2,3,4]);assert.equal(entries[0].warning,true);assert.equal(entries[0].cooldownUntil,null);
 assert.deepEqual(entries.slice(1).map((e,i)=>Date.parse(e.cooldownUntil)/1000-(T+i+1)),[1800,3600,C.WEEK]);
 const status=await C.getStatus(pool,who,T+4);assert.equal(status.strikes,4);assert.equal(status.rankedAllowed,false);assert.equal(status.nextPenalty,'7 days');
 await assert.rejects(()=>C.assertEligible(pool,who,T+4),e=>e.status===403&&e.message.includes(entries[3].cooldownUntil)&&e.message.includes('Casual'));
 const expired=await C.getStatus(pool,who,T+C.WEEK+4);assert.deepEqual(expired,{strikes:0,cooldownUntil:null,rankedAllowed:true,nextPenalty:'warning'});
 assert.equal((await record(who,T+C.WEEK+5)).level,1);
});
dbTest('a warning alone permits ranked play and expired shorter bans do not block while strikes remain',async()=>{
 const who=await account();await record(who,T);assert.equal((await C.assertEligible(pool,who,T+1)).nextPenalty,'30 minutes');await record(who,T+2);
 const status=await C.assertEligible(pool,who,T+1803);assert.equal(status.strikes,2);assert.equal(status.nextPenalty,'60 minutes');assert.equal(status.cooldownUntil,null);
});
dbTest('duplicate and concurrent departure retries cannot add strikes twice',async()=>{
 const who=await account(),matchId=match();const results=await Promise.all([record(who,T,{matchId}),record(who,T+100,{matchId})]);
 assert.deepEqual(results.map(e=>e.recorded).sort(),[false,true]);assert.equal((await C.getStatus(pool,who,T+101)).strikes,1);
 const rows=(await pool.query('SELECT * FROM troika_ranked_abandonments WHERE account_id=$1',[who])).rows;assert.equal(rows.length,1);
});
dbTest('late and concurrent different-round events retain chronological escalation instead of extra warnings',async()=>{
 const who=await account();const newer=await record(who,T+10);await record(who,T);
 const levels=(await pool.query('SELECT level FROM troika_ranked_abandonments WHERE account_id=$1 ORDER BY occurred_at',[who])).rows.map(r=>r.level);assert.deepEqual(levels,[1,2]);assert.equal((await C.getStatus(pool,who,T+11)).rankedAllowed,false);
 const other=await account();await Promise.all([record(other,T+20),record(other,T)]);assert.equal((await C.getStatus(pool,other,T+21)).strikes,2);assert.equal((await C.getStatus(pool,other,T+21)).rankedAllowed,false);
 assert.equal(newer.recorded,true);
});
dbTest('batch status returns safe per-account fields in one query, without private identity',async()=>{
 const a=await account(),b=await account();await record(a);let queries=0;const client={query(...args){queries++;return pool.query(...args);}};
 const statuses=await C.getStatuses(client,[a,b],T+1);assert.equal(queries,1);assert.equal(statuses[a].strikes,1);assert.equal(statuses[b].strikes,0);assert.equal(statuses[b].nextPenalty,'warning');assert.ok(!JSON.stringify(statuses).includes('email'));assert.deepEqual(await C.getStatuses(pool,[],T),{});
});
dbTest('five-minute boundary counts at the exact deadline, revokes the key and transfers the host',async()=>{
 const g=await fixture();g.players[1].lastSeen=T+100;g.players[2].lastSeen=T+100;
 assert.deepEqual(await transaction(c=>C.processRoom(c,g,T+299)),{changed:false,penalties:[]});assert.equal(g.players[0].bot,false);
 const result=await transaction(c=>C.processRoom(c,g,T+300));assert.equal(result.changed,true);assert.equal(result.penalties.length,1);assert.equal(result.penalties[0].occurredAt,T+300);assert.equal(g.players[0].bot,true);assert.equal(g.players[0].tokenHash,'');assert.equal(g.hostId,g.players[1].id);assert.equal(g.botAt,T+300.85);assert.ok(g.events[0].text.includes('five minutes'));assert.deepEqual(g.events[0].cards,[]);
 assert.equal((await transaction(c=>C.processRoom(c,g,T+301))).changed,false);assert.equal((await C.getStatus(pool,g.players[0].accountId,T+301)).strikes,1);
});
dbTest('a reconnect before timeout refreshes lastSeen and paused-room credit extends the deadline',async()=>{
 const g=await fixture(2);g.players[0].lastSeen=T+299;g.players[1].rankedPauseCredit=120;
 assert.equal((await transaction(c=>C.processRoom(c,g,T+300))).changed,false);assert.equal((await transaction(c=>C.processRoom(c,g,T+419))).changed,false);
 const expired=await transaction(c=>C.processRoom(c,g,T+420));assert.equal(expired.penalties.length,1);assert.equal(expired.penalties[0].playerId,g.players[1].id);assert.equal(g.players[0].bot,false);
});
dbTest('finished seats, host-kicked bots, paused and casual rounds never receive disconnect strikes',async()=>{
 const g=await fixture();g.players[0].finish=1;g.players[1].bot=true;g.players[2].lastSeen=T+1000;
 assert.equal((await transaction(c=>C.processRoom(c,g,T+500))).changed,false);
 for(const change of [x=>x.paused=true,x=>x.ranked=false,x=>x.status='finished',x=>delete x.ranking.startedAt]){
  const copy=await fixture();change(copy);assert.equal((await transaction(c=>C.processRoom(c,copy,T+1000))).changed,false);
  for(const p of copy.players)assert.equal((await C.getStatus(pool,p.accountId,T+1000)).strikes,0);
 }
});
dbTest('delayed timeout discovery anchors cooldowns to departure deadlines rather than the next visit',async()=>{
 const g=await fixture(2);await record(g.players[0].accountId,T-1000);g.players[1].lastSeen=T+10000;
 const result=await transaction(c=>C.processRoom(c,g,T+300+1801));assert.equal(result.penalties[0].level,2);assert.equal(Date.parse(result.penalties[0].cooldownUntil)/1000,T+300+1800);
 const status=await C.getStatus(pool,g.players[0].accountId,T+300+1801);assert.equal(status.strikes,2);assert.equal(status.rankedAllowed,true);
});
dbTest('administrator forgiveness clears active penalties while preserving records and an audit trail',async()=>{
 const owner=await account('admin'),who=await account(),outsider=await account();await record(who,T);await record(who,T+1);
 await assert.rejects(()=>transaction(c=>C.forgive(c,{id:outsider},who,'Reviewed a connection failure',T+2)),e=>e.status===403);
 await assert.rejects(()=>transaction(c=>C.forgive(c,{id:owner},who,'no',T+2)));
 const result=await transaction(c=>C.forgive(c,{id:owner},who,'Reviewed a connection failure',T+2));assert.equal(result.forgiven,2);assert.equal(result.rankedStatus.rankedAllowed,true);assert.equal(result.rankedStatus.strikes,0);
 assert.equal((await pool.query('SELECT count(*)::integer AS n FROM troika_ranked_abandonments WHERE account_id=$1',[who])).rows[0].n,2);
 const audit=(await pool.query('SELECT * FROM troika_conduct_audit WHERE account_id=$1',[who])).rows[0];assert.equal(audit.admin_id,owner);assert.equal(audit.forgiven_count,2);assert.equal(audit.kind,'forgive');assert.equal((await record(who,T+3)).level,1);
});
dbTest('ranked admin kicks have an authenticated moderation audit without penalizing the target',async()=>{
 const owner=await account('admin'),who=await account();await assert.rejects(()=>transaction(c=>C.auditKick(c,{id:who},owner,'TESTX',match())),e=>e.status===403);
 const matchId=match();await transaction(c=>C.auditKick(c,{id:owner},who,'TESTX',matchId));const audit=(await pool.query("SELECT * FROM troika_conduct_audit WHERE account_id=$1 AND kind='kick'",[who])).rows[0];assert.equal(audit.room,'TESTX');assert.equal(audit.match_id,matchId);assert.equal((await C.getStatus(pool,who,T)).strikes,0);
});
