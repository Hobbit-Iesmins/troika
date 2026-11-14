'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {randomBytes}=require('node:crypto');
const R=require('../../cloud/rankings.js');
const connectionString=process.env.TEST_DATABASE_URL;
let pool,admin,schema;
const dbTest=(name,fn)=>test(name,{skip:!connectionString},fn);
test.before(async()=>{
  if(!connectionString)return;
  const {Pool}=require('pg');schema='troika_ranking_'+randomBytes(8).toString('hex');admin=new Pool({connectionString,max:1});
  await admin.query('CREATE SCHEMA '+schema);pool=new Pool({connectionString,max:8,options:'-c search_path='+schema});
  await pool.query(`CREATE TABLE troika_accounts(id TEXT PRIMARY KEY,nickname TEXT NOT NULL,role TEXT DEFAULT 'user',suspended BOOLEAN DEFAULT FALSE,
    elo INTEGER DEFAULT 500,rated_games INTEGER DEFAULT 0,wins INTEGER DEFAULT 0,last_places INTEGER DEFAULT 0,placement_sum INTEGER DEFAULT 0,peak_elo INTEGER DEFAULT 500)`);
  await transaction(c=>R.initRankings(c));
});
test.after(async()=>{await pool?.end();if(admin){await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();}});
async function transaction(fn){const c=await pool.connect();try{await c.query('BEGIN');const value=await fn(c);await c.query('COMMIT');return value;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
async function fixture(count=3){
  const g={room:'TESTX',round:1,status:'playing',ranked:true,settings:{mode:'standard',maxPlayers:5,decks:1},players:[],results:[]};
  for(let i=0;i<count;i++){
    const id=randomBytes(12).toString('hex');await pool.query('INSERT INTO troika_accounts(id,nickname) VALUES($1,$2)',[id,'Person '+id.slice(0,4)]);
    g.players.push({id:randomBytes(12).toString('hex'),accountId:id,name:'Seat '+i,bot:false});
  }
  await transaction(c=>R.startRankedRound(c,g));g.status='finished';g.results=g.players.map(p=>p.id);return g;
}
const accounts=async g=>(await pool.query('SELECT * FROM troika_accounts WHERE id=ANY($1::text[]) ORDER BY id',[g.players.map(p=>p.accountId)])).rows;

test('tiers use the full Trash-to-Grandmaster boundaries',()=>{
  assert.deepEqual([-5,500,599,600,799,800,999,1000,1199,1200,1400,1600,1800,1999,2000,9999].map(R.tier),
    ['Trash','Trash','Trash','Rookie','Rookie','Bronze','Bronze','Silver','Silver','Gold','Platinum','Diamond','Master','Master','Grandmaster','Grandmaster']);
});
test('multiplayer Elo rewards position, stronger opposition, and provisional placement games',()=>{
  const people=Array.from({length:5},(_,i)=>({accountId:String(i),elo:500,ratedGames:10,place:i+1}));
  assert.deepEqual(R.ratingChanges(people).map(p=>p.change),[16,8,0,-8,-16]);
  assert.deepEqual(R.ratingChanges(people.map(p=>({...p,ratedGames:9}))).map(p=>p.change),[32,16,0,-16,-32]);
  const upset=R.ratingChanges([{accountId:'a',elo:500,ratedGames:10,place:1},{accountId:'b',elo:900,ratedGames:10,place:2}]);
  assert.ok(upset[0].change>16);assert.equal(upset[0].change,-upset[1].change);
  assert.throws(()=>R.ratingChanges([{accountId:'a',elo:500,ratedGames:0,place:1},{accountId:'a',elo:500,ratedGames:0,place:2}]));
  assert.throws(()=>R.ratingChanges(people.map(p=>({...p,place:1}))));
});
dbTest('ranked starts reject bots, guests, duplicate identities and suspended accounts',async()=>{
  const g=await fixture();g.status='playing';
  for(const tweak of [x=>x.players[0].bot=true,x=>delete x.players[0].accountId,x=>x.players[1].accountId=x.players[0].accountId]){
    const invalid=structuredClone(g);tweak(invalid);await assert.rejects(()=>transaction(c=>R.startRankedRound(c,invalid)));
  }
  await pool.query('UPDATE troika_accounts SET suspended=TRUE WHERE id=$1',[g.players[0].accountId]);
  await assert.rejects(()=>transaction(c=>R.startRankedRound(c,g)));
});
dbTest('finished ranked rounds update persistent stats once and preserve public result snapshots',async()=>{
  const g=await fixture();const participants=structuredClone(g.ranking.participants);
  const result=await transaction(c=>R.finalizeRankedRound(c,g));assert.equal(result.status,'rated');assert.deepEqual(result.results.map(p=>p.change),[32,0,-32]);
  for(const p of g.players){const row=(await accounts(g)).find(a=>a.id===p.accountId);assert.equal(row.rated_games,1);assert.equal(row.placement_sum,g.players.indexOf(p)+1);assert.equal(row.wins,p===g.players[0]?1:0);assert.equal(row.last_places,p===g.players.at(-1)?1:0);}
  const before=await accounts(g);await transaction(c=>R.finalizeRankedRound(c,g));assert.deepEqual(await accounts(g),before);
  const oldCopy=structuredClone(g);oldCopy.ranking={...oldCopy.ranking,status:'pending',participants};await transaction(c=>R.finalizeRankedRound(c,oldCopy));assert.equal(oldCopy.ranking.status,'rated');assert.deepEqual(await accounts(g),before);
  const own=await R.history(pool,g.players[0].accountId);assert.equal(own.length,1);assert.equal(own[0].place,1);assert.equal(own[0].change,32);assert.equal(own[0].players.length,3);assert.ok(!JSON.stringify(own).includes('accountId'));
});
dbTest('simultaneous finalize retries cannot score the same match twice',async()=>{
  const g=await fixture();const copies=[structuredClone(g),structuredClone(g)];
  await Promise.all(copies.map(copy=>transaction(c=>R.finalizeRankedRound(c,copy))));
  assert.ok((await accounts(g)).every(p=>p.rated_games===1));assert.deepEqual(copies[0].ranking.results,copies[1].ranking.results);
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM troika_ranked_matches WHERE id=$1',[g.ranking.id])).rows[0].n,1);
});
dbTest('different simultaneous matches with shared accounts serialize without lost rating updates',async()=>{
  const g=await fixture(),other=structuredClone(g);other.status='playing';other.round=2;await transaction(c=>R.startRankedRound(c,other));other.status='finished';other.results.reverse();
  await Promise.all([g,other].map(copy=>transaction(c=>R.finalizeRankedRound(c,copy))));
  assert.ok((await accounts(g)).every(p=>p.rated_games===2));
  for(const p of g.players){const history=await R.history(pool,p.accountId);assert.equal(history.length,2);const sum=history.reduce((total,m)=>total+m.change,500);assert.equal((await accounts(g)).find(a=>a.id===p.accountId).elo,sum);}
});
dbTest('legacy void round snapshots finish and retain history without changing ratings or stats',async()=>{
  const prior=await fixture();prior.status='playing';prior.ranking.status='void';prior.ranking.reason='host_kick';
  // This state was persisted by the old policy; new kicks no longer produce it.
  const g=JSON.parse(JSON.stringify(prior));assert.equal(await transaction(c=>R.finalizeRankedRound(c,g)),null);
  const before=await accounts(g);g.status='finished';await transaction(c=>R.finalizeRankedRound(c,g));assert.deepEqual(await accounts(g),before);assert.ok(g.ranking.results.every(p=>p.change===0));
  const own=await R.history(pool,g.players[1].accountId);assert.equal(own[0].status,'void');assert.equal(own[0].reason,'host_kick');
  const retry=JSON.parse(JSON.stringify(prior));retry.status='finished';await transaction(c=>R.finalizeRankedRound(c,retry));assert.equal(retry.ranking.status,'void');assert.equal(retry.ranking.reason,'host_kick');assert.deepEqual(await accounts(g),before);
});
dbTest('voluntary leave keeps its account in the eventual result even if a bot finishes the seat',async()=>{
  const g=await fixture();g.players[2].bot=true;await transaction(c=>R.finalizeRankedRound(c,g));
  const departed=(await accounts(g)).find(a=>a.id===g.players[2].accountId);assert.equal(departed.rated_games,1);assert.equal(departed.last_places,1);assert.equal(departed.elo,468);
});
dbTest('incomplete results rollback every stat and leaderboard exposes no private profile fields',async()=>{
  const g=await fixture();const before=await accounts(g);g.results.pop();await assert.rejects(()=>transaction(c=>R.finalizeRankedRound(c,g)));assert.deepEqual(await accounts(g),before);
  const hidden=g.players[1].accountId;await pool.query('UPDATE troika_accounts SET suspended=TRUE WHERE id=$1',[hidden]);
  const ladder=await R.leaderboard(pool);assert.ok(ladder.players.length>0);assert.ok(!ladder.players.some(p=>p.nickname===before.find(a=>a.id===hidden).nickname));
  assert.ok(ladder.players.every(p=>!('id' in p)&&!('email' in p)&&!('firstName' in p)));assert.equal(ladder.players.find(p=>p.nickname===before.find(a=>a.id===g.players[0].accountId).nickname).averagePlacement,null);
});
dbTest('rating corrections recheck administrator authority and record an immutable audit entry',async()=>{
  const g=await fixture();const owner={id:g.players[0].accountId},target=g.players[1].accountId;
  await assert.rejects(()=>transaction(c=>R.correctRating(c,owner,target,1200,'Correct invalid result')),e=>e.status===403);
  await pool.query("UPDATE troika_accounts SET role='admin' WHERE id=$1",[owner.id]);
  await assert.rejects(()=>transaction(c=>R.correctRating(c,owner,target,1200,'')));
  const fixed=await transaction(c=>R.correctRating(c,owner,target,1200,'Correct invalid result'));assert.equal(fixed.before,500);assert.equal(fixed.after,1200);assert.equal(fixed.tier,'Gold');
  const audit=(await pool.query('SELECT * FROM troika_rating_audit WHERE account_id=$1',[target])).rows;assert.equal(audit.length,1);assert.equal(audit[0].admin_id,owner.id);assert.equal(audit[0].reason,'Correct invalid result');
});
dbTest('an admin rating correction and match scoring acquire shared accounts in consistent order',async()=>{
  const g=await fixture(2),sorted=g.players.map(p=>p.accountId).sort(),target=sorted[0],owner={id:sorted[1]};
  await pool.query("UPDATE troika_accounts SET role='admin' WHERE id=$1",[owner.id]);
  const match=await pool.connect(),correction=await pool.connect();let correcting;
  try{
    await match.query('BEGIN');await correction.query('BEGIN');
    await match.query("SET LOCAL statement_timeout='5000ms'");await correction.query("SET LOCAL statement_timeout='5000ms'");
    // A match has reached the first account. The correction must wait for that same
    // first row, without holding the later admin row that the match still needs.
    await match.query('SELECT id FROM troika_accounts WHERE id=$1 FOR UPDATE',[target]);
    correcting=R.correctRating(correction,owner,target,1100,'Review earlier match result');
    // Attach a handler immediately so a database timeout cannot become unhandled.
    const outcome=correcting.then(value=>({value}),error=>({error}));
    let blocked=false;
    for(let attempt=0;attempt<100;attempt++){
      const row=(await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[correction.processID])).rows[0];
      if(row?.wait_event_type==='Lock'){blocked=true;break;}
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(blocked,true,'correction waits on the already locked account');
    await R.finalizeRankedRound(match,g);await match.query('COMMIT');
    const settled=await outcome;if(settled.error)throw settled.error;await correction.query('COMMIT');
    assert.ok((await accounts(g)).every(p=>p.rated_games===1));assert.equal((await accounts(g)).find(p=>p.id===target).elo,1100);
  }finally{
    await match.query('ROLLBACK').catch(()=>{});await correction.query('ROLLBACK').catch(()=>{});
    if(correcting)await correcting.catch(()=>{});match.release();correction.release();
  }
});
