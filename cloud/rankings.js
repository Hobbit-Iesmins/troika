'use strict';

// All mutating functions run in the caller's transaction, alongside the room save.
const {randomBytes}=require('node:crypto');
const {GameError}=require('./engine.js');
const requireValue=(condition,message,status=400)=>{if(!condition)throw new GameError(message,status);};
const TIERS=['Trash','Rookie','Bronze','Silver','Gold','Platinum','Diamond','Master','Grandmaster'];
function tier(elo){
  if(elo<600)return TIERS[0];
  return TIERS[Math.min(8,1+Math.floor((elo-600)/200))];
}
function ratingChanges(participants){
  requireValue(Array.isArray(participants)&&participants.length>=2,'A ranked result needs at least two players.');
  requireValue(new Set(participants.map(p=>p.accountId)).size===participants.length,'Each ranked player needs their own account.');
  const n=participants.length;
  for(const p of participants)requireValue(Number.isFinite(p.elo)&&Number.isInteger(p.ratedGames)&&p.ratedGames>=0&&Number.isInteger(p.place)&&p.place>=1&&p.place<=n,'Invalid ranked result.');
  requireValue(new Set(participants.map(p=>p.place)).size===n,'Each ranked player needs a distinct finishing position.');
  return participants.map(p=>{
    let difference=0;
    for(const other of participants){
      if(other.accountId===p.accountId)continue;
      const expected=1/(1+10**((other.elo-p.elo)/400));
      difference+=(p.place<other.place?1:0)-expected;
    }
    const change=Math.round((p.ratedGames<10?64:32)*difference/(n-1));
    return {...p,change:Object.is(change,-0)?0:change,before:p.elo,after:p.elo+change,tier:tier(p.elo+change)};
  });
}
async function initRankings(client){
  await client.query(`CREATE TABLE IF NOT EXISTS troika_ranked_matches (
    id TEXT PRIMARY KEY, room TEXT NOT NULL, round INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('rated','void')), reason TEXT,
    settings JSONB NOT NULL, results JSONB NOT NULL,
    started TIMESTAMPTZ NOT NULL, finished TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS troika_ranked_entries (
    match_id TEXT NOT NULL REFERENCES troika_ranked_matches(id),
    account_id TEXT NOT NULL REFERENCES troika_accounts(id), place INTEGER NOT NULL,
    rating_before INTEGER NOT NULL, rating_after INTEGER NOT NULL, change INTEGER NOT NULL,
    PRIMARY KEY(match_id,account_id)
  )`);
  await client.query('CREATE INDEX IF NOT EXISTS troika_ranked_entries_account ON troika_ranked_entries(account_id,match_id)');
  await client.query(`CREATE TABLE IF NOT EXISTS troika_rating_audit (
    id BIGSERIAL PRIMARY KEY, admin_id TEXT NOT NULL REFERENCES troika_accounts(id),
    account_id TEXT NOT NULL REFERENCES troika_accounts(id), old_rating INTEGER NOT NULL,
    new_rating INTEGER NOT NULL, reason TEXT NOT NULL, created TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  for(const table of ['troika_ranked_matches','troika_ranked_entries','troika_rating_audit'])await client.query('ALTER TABLE '+table+' ENABLE ROW LEVEL SECURITY');
}
async function startRankedRound(client,g){
  requireValue(g.ranked===true,'This table is not ranked.');
  requireValue(g.status==='playing','Deal the cards before starting the ranked round.');
  requireValue(g.players.length>=2&&g.players.every(p=>!p.bot&&typeof p.accountId==='string'),'Ranked rounds need at least two signed-in human players.');
  const ids=g.players.map(p=>p.accountId);
  requireValue(new Set(ids).size===ids.length,'Each ranked player needs their own account.');
  const {rows}=await client.query('SELECT id,nickname,suspended FROM troika_accounts WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE',[ids]);
  requireValue(rows.length===ids.length&&rows.every(p=>!p.suspended),'All ranked players need active accounts.');
  g.ranking={id:randomBytes(16).toString('hex'),status:'pending',startedAt:new Date().toISOString(),participants:g.players.map(p=>({playerId:p.id,accountId:p.accountId,nickname:rows.find(a=>a.id===p.accountId).nickname}))};
  return g.ranking;
}
function decode(value){return typeof value==='string'?JSON.parse(value):value;}
function resultState(g,row){
  g.ranking.status=row.status;g.ranking.results=decode(row.results);g.ranking.finishedAt=new Date(row.finished).toISOString();
  if(row.reason)g.ranking.reason=row.reason;
  return g.ranking;
}
async function finalizeRankedRound(client,g){
  if(g.ranked!==true||g.status!=='finished'||!g.ranking)return null;
  const ranking=g.ranking;
  // Persisted terminal state was saved atomically with the ledger; normal polls need no extra reads.
  if(['rated','void'].includes(ranking.status)&&ranking.finishedAt)return ranking;
  requireValue(typeof ranking.id==='string'&&/^[a-f0-9]{32}$/.test(ranking.id),'This ranked round has no valid result identity.');
  // Room rows already serialize normal requests; this lock also makes retries safe independently.
  await client.query('SELECT pg_advisory_xact_lock(1901176104,hashtext($1))',[ranking.id]);
  const existing=await client.query('SELECT status,reason,results,finished FROM troika_ranked_matches WHERE id=$1',[ranking.id]);
  if(existing.rows.length)return resultState(g,existing.rows[0]);
  requireValue(['pending','void'].includes(ranking.status),'This ranked round cannot be scored.');
  const people=ranking.participants;
  requireValue(Array.isArray(people)&&people.length>=2&&new Set(people.map(p=>p.accountId)).size===people.length,'Invalid ranked participants.');
  requireValue(Array.isArray(g.results)&&g.results.length===people.length&&new Set(g.results).size===people.length&&people.every(p=>g.results.includes(p.playerId)),'Finish every ranked player before recording the result.');
  const {rows}=await client.query('SELECT id,elo,rated_games FROM troika_accounts WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE',[people.map(p=>p.accountId)]);
  requireValue(rows.length===people.length,'A ranked account is missing.');
  const input=people.map(p=>{const account=rows.find(a=>a.id===p.accountId);return {...p,elo:account.elo,ratedGames:account.rated_games,place:g.results.indexOf(p.playerId)+1};});
  const rated=ranking.status==='pending';
  const changes=rated?ratingChanges(input):input.map(p=>({...p,before:p.elo,after:p.elo,change:0,tier:tier(p.elo)}));
  const results=changes.map(({accountId,playerId,nickname,place,before,after,change,tier})=>({accountId,playerId,nickname,place,before,after,change,tier}));
  const inserted=await client.query(`INSERT INTO troika_ranked_matches(id,room,round,status,reason,settings,results,started)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8) RETURNING status,reason,results,finished`,
    [ranking.id,g.room,g.round,rated?'rated':'void',rated?null:ranking.reason??'host_kick',JSON.stringify(g.settings??{}),JSON.stringify(results),ranking.startedAt]);
  for(const p of results){
    if(rated)await client.query(`UPDATE troika_accounts SET elo=$2,rated_games=rated_games+1,
      wins=wins+$3,last_places=last_places+$4,placement_sum=placement_sum+$5,peak_elo=GREATEST(peak_elo,$2) WHERE id=$1`,
      [p.accountId,p.after,p.place===1?1:0,p.place===people.length?1:0,p.place]);
    await client.query('INSERT INTO troika_ranked_entries(match_id,account_id,place,rating_before,rating_after,change) VALUES($1,$2,$3,$4,$5,$6)',[ranking.id,p.accountId,p.place,p.before,p.after,p.change]);
  }
  return resultState(g,inserted.rows[0]);
}
async function leaderboard(client){
  const {rows}=await client.query(`SELECT nickname,elo,rated_games,wins,last_places,placement_sum,peak_elo
    FROM troika_accounts WHERE suspended=FALSE ORDER BY elo DESC,wins DESC,rated_games DESC,nickname ASC LIMIT 100`);
  return {players:rows.map(p=>({nickname:p.nickname,elo:p.elo,tier:tier(p.elo),ratedGames:p.rated_games,wins:p.wins,lastPlaces:p.last_places,averagePlacement:p.rated_games?Math.round(p.placement_sum/p.rated_games*100)/100:null,peakElo:p.peak_elo,provisional:p.rated_games<10}))};
}
async function history(client,accountId){
  const {rows}=await client.query(`SELECT m.id,m.room,m.round,m.status,m.reason,m.settings,m.results,m.started,m.finished,
    e.place,e.rating_before,e.rating_after,e.change FROM troika_ranked_entries e
    JOIN troika_ranked_matches m ON m.id=e.match_id WHERE e.account_id=$1 ORDER BY m.finished DESC,m.id DESC LIMIT 50`,[accountId]);
  return rows.map(row=>({id:row.id,room:row.room,round:row.round,status:row.status,reason:row.reason,settings:decode(row.settings),place:row.place,before:row.rating_before,after:row.rating_after,change:row.change,tier:tier(row.rating_after),startedAt:new Date(row.started).toISOString(),finishedAt:new Date(row.finished).toISOString(),players:decode(row.results).map(({nickname,place,change,before,after,tier})=>({nickname,place,change,before,after,tier}))}));
}
async function correctRating(client,admin,userId,newRating,reason){
  requireValue(admin&&typeof admin.id==='string','Sign in as an administrator.',403);
  requireValue(typeof userId==='string','Choose an account to correct.');
  requireValue(Number.isInteger(newRating)&&newRating>=-10000&&newRating<=10000,'Choose a whole-number rating between -10000 and 10000.');
  requireValue(typeof reason==='string'&&reason.trim().length>=5&&reason.trim().length<=500,'Explain the rating correction in 5–500 characters.');
  // Match finalization locks accounts in the same order. Lock both here in one pass,
  // rather than holding an admin share-lock while waiting for an earlier target row.
  const {rows}=await client.query('SELECT id,role,suspended,elo FROM troika_accounts WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE',[[admin.id,userId]]);
  const owner=rows.find(row=>row.id===admin.id),target=rows.find(row=>row.id===userId);
  requireValue(owner&&owner.role==='admin'&&!owner.suspended,'Only an administrator can correct ratings.',403);
  requireValue(target,'Account not found.',404);
  await client.query('UPDATE troika_accounts SET elo=$2,peak_elo=GREATEST(peak_elo,$2) WHERE id=$1',[userId,newRating]);
  await client.query('INSERT INTO troika_rating_audit(admin_id,account_id,old_rating,new_rating,reason) VALUES($1,$2,$3,$4,$5)',[admin.id,userId,target.elo,newRating,reason.trim()]);
  return {userId,before:target.elo,after:newRating,tier:tier(newRating)};
}
module.exports={tier,ratingChanges,initRankings,startRankedRound,finalizeRankedRound,leaderboard,history,correctRating};
