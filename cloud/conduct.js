'use strict';
// Ranked conduct records are committed with the room that caused them. A unique
// match/account key and account-row locks make retries and concurrent rooms safe.
const E=require('./engine.js');
const WEEK=7*24*60*60,GRACE=5*60;
const SQL=`CREATE TABLE IF NOT EXISTS troika_ranked_abandonments (
 match_id TEXT NOT NULL,account_id TEXT NOT NULL REFERENCES troika_accounts(id),room TEXT NOT NULL,
 reason TEXT NOT NULL CHECK(reason IN ('left','disconnect')),level INTEGER NOT NULL,
 occurred_at TIMESTAMPTZ NOT NULL,cooldown_until TIMESTAMPTZ,forgiven_at TIMESTAMPTZ,
 PRIMARY KEY(match_id,account_id));
CREATE INDEX IF NOT EXISTS troika_ranked_abandonments_account ON troika_ranked_abandonments(account_id,occurred_at);
CREATE TABLE IF NOT EXISTS troika_conduct_audit (
 id BIGSERIAL PRIMARY KEY,admin_id TEXT NOT NULL REFERENCES troika_accounts(id),account_id TEXT NOT NULL REFERENCES troika_accounts(id),
 reason TEXT NOT NULL,forgiven_count INTEGER NOT NULL,kind TEXT NOT NULL DEFAULT 'forgive',room TEXT,match_id TEXT,
 created TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
ALTER TABLE troika_conduct_audit ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'forgive';
ALTER TABLE troika_conduct_audit ADD COLUMN IF NOT EXISTS room TEXT;
ALTER TABLE troika_conduct_audit ADD COLUMN IF NOT EXISTS match_id TEXT;
ALTER TABLE troika_ranked_abandonments ENABLE ROW LEVEL SECURITY;
ALTER TABLE troika_conduct_audit ENABLE ROW LEVEL SECURITY;`;
const requireValue=(condition,message,status=400)=>{if(!condition)throw new E.GameError(message,status);};
const clock=now=>{requireValue(Number.isFinite(now),'Invalid conduct timestamp.');return now;};
const iso=value=>value===null||value===undefined?null:new Date(value).toISOString();
const duration=level=>level<=1?0:level===2?1800:level===3?3600:WEEK;
const nextPenalty=strikes=>strikes===0?'warning':strikes===1?'30 minutes':strikes===2?'60 minutes':'7 days';
async function getStatuses(client,accountIds,nowSeconds=Date.now()/1000){
 clock(nowSeconds);requireValue(Array.isArray(accountIds)&&accountIds.every(id=>typeof id==='string'),'Choose valid accounts.');
 const ids=[...new Set(accountIds)],out={};
 for(const id of ids)out[id]={strikes:0,cooldownUntil:null,rankedAllowed:true,nextPenalty:'warning'};
 if(!ids.length)return out;
 const {rows}=await client.query(`SELECT account_id,
   count(*) FILTER (WHERE occurred_at>=to_timestamp($2)-INTERVAL '7 days' AND occurred_at<=to_timestamp($2))::integer AS strikes,
   max(cooldown_until) FILTER (WHERE occurred_at<=to_timestamp($2) AND cooldown_until>to_timestamp($2)) AS cooldown_until
   FROM troika_ranked_abandonments WHERE account_id=ANY($1::text[]) AND forgiven_at IS NULL GROUP BY account_id`,[ids,nowSeconds]);
 for(const row of rows)out[row.account_id]={strikes:row.strikes,cooldownUntil:iso(row.cooldown_until),rankedAllowed:!row.cooldown_until,nextPenalty:nextPenalty(row.strikes)};
 return out;
}
async function getStatus(client,accountId,nowSeconds=Date.now()/1000){
 requireValue(typeof accountId==='string','Choose an account.');return (await getStatuses(client,[accountId],nowSeconds))[accountId];
}
async function assertEligible(client,accountId,nowSeconds=Date.now()/1000){
 const status=await getStatus(client,accountId,nowSeconds);
 requireValue(status.rankedAllowed,'Ranked play is on cooldown until '+status.cooldownUntil+'. Casual games are still available.',403);
 return status;
}
function entry(row,recorded){return {recorded,level:row.level,cooldownUntil:iso(row.cooldown_until),warning:row.level===1,reason:row.reason,occurredAt:new Date(row.occurred_at).getTime()/1000};}
async function recordAbandonment(client,{matchId,accountId,room,reason,occurredAt}){
 requireValue(typeof matchId==='string'&&/^[a-f0-9]{32}$/.test(matchId),'This ranked round has no valid identity.');
 requireValue(typeof accountId==='string'&&typeof room==='string'&&['left','disconnect'].includes(reason),'Invalid ranked departure.');clock(occurredAt);
 const account=await client.query('SELECT id FROM troika_accounts WHERE id=$1 FOR UPDATE',[accountId]);requireValue(account.rows.length,'Account not found.',404);
 const existing=await client.query('SELECT level,cooldown_until,reason,occurred_at FROM troika_ranked_abandonments WHERE match_id=$1 AND account_id=$2',[matchId,accountId]);
 if(existing.rows.length)return entry(existing.rows[0],false);
 await client.query(`INSERT INTO troika_ranked_abandonments(match_id,account_id,room,reason,level,occurred_at,cooldown_until)
   VALUES($1,$2,$3,$4,1,to_timestamp($5),NULL)`,[matchId,accountId,room,reason,occurredAt]);
 // A dormant room can be discovered after a newer departure. Recompute this
 // event and the following seven days chronologically rather than letting late
 // delivery grant multiple first warnings. Equal timestamps use stable match IDs.
 const surrounding=await client.query(`SELECT match_id,occurred_at,level,cooldown_until FROM troika_ranked_abandonments
   WHERE account_id=$1 AND forgiven_at IS NULL AND occurred_at>=to_timestamp($2)-INTERVAL '7 days'
   AND occurred_at<=to_timestamp($2)+INTERVAL '7 days' ORDER BY occurred_at,match_id`,[accountId,occurredAt]);
 let left=0;
 for(let i=0;i<surrounding.rows.length;i++){
  const row=surrounding.rows[i],at=new Date(row.occurred_at).getTime()/1000;
  while(new Date(surrounding.rows[left].occurred_at).getTime()/1000<at-WEEK)left++;
  if(at<occurredAt)continue;
  const level=i-left+1,seconds=duration(level),until=seconds?new Date((at+seconds)*1000).toISOString():null;
  if(row.level!==level||iso(row.cooldown_until)!==until)await client.query('UPDATE troika_ranked_abandonments SET level=$3,cooldown_until=$4 WHERE match_id=$1 AND account_id=$2',[row.match_id,accountId,level,until]);
 }
 const inserted=await client.query('SELECT level,cooldown_until,reason,occurred_at FROM troika_ranked_abandonments WHERE match_id=$1 AND account_id=$2',[matchId,accountId]);
 return entry(inserted.rows[0],true);
}
async function forgive(client,admin,userId,reason,nowSeconds=Date.now()/1000){
 clock(nowSeconds);requireValue(admin&&typeof admin.id==='string','Sign in as an administrator.',403);requireValue(typeof userId==='string','Choose an account.');
 requireValue(typeof reason==='string'&&reason.trim().length>=5&&reason.trim().length<=500,'Explain the forgiveness in 5–500 characters.');
 const {rows}=await client.query('SELECT id,role,suspended FROM troika_accounts WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE',[[admin.id,userId]]);
 const owner=rows.find(p=>p.id===admin.id);requireValue(owner&&owner.role==='admin'&&!owner.suspended,'Only an administrator can clear ranked penalties.',403);requireValue(rows.some(p=>p.id===userId),'Account not found.',404);
 const forgiven=await client.query(`UPDATE troika_ranked_abandonments SET forgiven_at=to_timestamp($2)
   WHERE account_id=$1 AND forgiven_at IS NULL AND (occurred_at>=to_timestamp($2)-INTERVAL '7 days' OR cooldown_until>to_timestamp($2)) RETURNING match_id`,[userId,nowSeconds]);
 await client.query('INSERT INTO troika_conduct_audit(admin_id,account_id,reason,forgiven_count) VALUES($1,$2,$3,$4)',[admin.id,userId,reason.trim(),forgiven.rows.length]);
 return {userId,forgiven:forgiven.rows.length,rankedStatus:await getStatus(client,userId,nowSeconds)};
}
async function processRoom(client,g,nowSeconds=Date.now()/1000){
 clock(nowSeconds);const result={changed:false,penalties:[]};
 if(g.ranked!==true||g.status!=='playing'||g.paused||g.ranking?.status!=='pending')return result;
 const started=Date.parse(g.ranking.startedAt)/1000;
 if(!Number.isFinite(started)||!/^[a-f0-9]{32}$/.test(g.ranking.id||''))return result;
 const enforced=Number.isFinite(g.ranking.conductSince)?g.ranking.conductSince:started;
 const expired=g.players.filter(p=>!p.bot&&p.finish===null&&typeof p.accountId==='string'&&Number.isFinite(p.lastSeen)).map(p=>({p,deadline:Math.max(p.lastSeen,started,enforced)+GRACE+(Number.isFinite(p.rankedPauseCredit)?Math.max(0,p.rankedPauseCredit):0)})).filter(x=>x.deadline<=nowSeconds).sort((a,b)=>a.deadline-b.deadline||a.p.accountId.localeCompare(b.p.accountId));
 if(!expired.length)return result;
 // Lock the entire batch before individual records, matching rating/correction order.
 const participants=[...new Set([...g.players.map(p=>p.accountId),...(g.ranking.participants||[]).map(p=>p.accountId)].filter(id=>typeof id==='string'))];
 await client.query('SELECT id FROM troika_accounts WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE',[participants]);
 let expiredHost=false;
 for(const {p,deadline} of expired){
  const penalty=await recordAbandonment(client,{matchId:g.ranking.id,accountId:p.accountId,room:g.room,reason:'disconnect',occurredAt:deadline});
  result.penalties.push({...penalty,accountId:p.accountId,playerId:p.id});
  p.bot=true;p.tokenHash='';p.ready=true;p.departureReason='abandonment';
  if(g.hostId===p.id)expiredHost=true;
  E.tk_touch(g,p.name+' did not reconnect within five minutes; a bot takes over.','lobby',p.id);
 }
 if(expiredHost){const successor=g.players.find(p=>!p.bot);g.hostId=successor?.id??null;if(successor)successor.ready=true;}
 g.botAt=nowSeconds+0.85;result.changed=true;return result;
}
async function auditKick(client,admin,userId,room,matchId){
 requireValue(admin&&typeof admin.id==='string','Sign in as an administrator.',403);
 requireValue(typeof userId==='string'&&typeof room==='string'&&/^[a-f0-9]{32}$/.test(matchId||''),'Invalid ranked moderation record.');
 const {rows}=await client.query('SELECT id,role,suspended FROM troika_accounts WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE',[[admin.id,userId]]);
 const owner=rows.find(p=>p.id===admin.id);requireValue(owner&&owner.role==='admin'&&!owner.suspended,'Only an administrator can moderate an active ranked round.',403);requireValue(rows.some(p=>p.id===userId),'Account not found.',404);
 await client.query(`INSERT INTO troika_conduct_audit(admin_id,account_id,reason,forgiven_count,kind,room,match_id)
   VALUES($1,$2,'Ranked host kick; bot takeover retains the rated result.',0,'kick',$3,$4)`,[admin.id,userId,room,matchId]);
 return {userId,room,matchId};
}
module.exports={SQL,WEEK,GRACE,getStatuses,getStatus,assertEligible,recordAbandonment,forgive,auditKick,processRoom};
