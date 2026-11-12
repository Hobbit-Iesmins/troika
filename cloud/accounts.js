'use strict';
const crypto=require('node:crypto');
const {promisify}=require('node:util');
const fs=require('node:fs');const path=require('node:path');
const {GameError,tk_avatar}=require('./engine.js');const {storageError}=require('./database.js');
const C=require('./conduct.js');
const derive=promisify(crypto.scrypt),initialized=new WeakMap();
const COOKIE='troika_session',SESSION_DAYS=30;
const SQL=`CREATE TABLE IF NOT EXISTS troika_accounts (
 id TEXT PRIMARY KEY,email TEXT NOT NULL,email_key TEXT NOT NULL UNIQUE,nickname TEXT NOT NULL,nickname_key TEXT NOT NULL UNIQUE,
 first_name TEXT NOT NULL DEFAULT '',last_name TEXT NOT NULL DEFAULT '',password_hash TEXT NOT NULL,
 role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),suspended BOOLEAN NOT NULL DEFAULT false,
 elo INTEGER NOT NULL DEFAULT 500,rated_games INTEGER NOT NULL DEFAULT 0,wins INTEGER NOT NULL DEFAULT 0,last_places INTEGER NOT NULL DEFAULT 0,
 placement_sum INTEGER NOT NULL DEFAULT 0,peak_elo INTEGER NOT NULL DEFAULT 500,created TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
ALTER TABLE troika_accounts ADD COLUMN IF NOT EXISTS avatar JSONB;
CREATE TABLE IF NOT EXISTS troika_sessions (token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES troika_accounts(id) ON DELETE CASCADE,expires TIMESTAMPTZ NOT NULL);
CREATE INDEX IF NOT EXISTS troika_sessions_user_idx ON troika_sessions(user_id);
CREATE TABLE IF NOT EXISTS troika_password_resets (token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES troika_accounts(id) ON DELETE CASCADE,expires TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS troika_owner_claim (singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton),user_id TEXT NOT NULL REFERENCES troika_accounts(id));
CREATE TABLE IF NOT EXISTS troika_account_limits (key TEXT PRIMARY KEY,hits INTEGER NOT NULL,expires TIMESTAMPTZ NOT NULL);
ALTER TABLE troika_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE troika_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE troika_password_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE troika_owner_claim ENABLE ROW LEVEL SECURITY;
ALTER TABLE troika_account_limits ENABLE ROW LEVEL SECURITY;
${C.SQL}`;
const fail=(condition,message,status=400)=>{if(!condition)throw new GameError(message,status);};
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const normalize=value=>value.normalize('NFC').toLowerCase();
function text(value,label,max=60,optional=false){
 if(optional&&(value===undefined||value===null))return '';
 fail(typeof value==='string',`Enter ${label}.`);const v=value.trim();
 fail(v.isWellFormed()&&!/[\u0000-\u001f\u007f]/u.test(v)&&Array.from(v).length<=max&&(optional||v.length>0),`Use a valid ${label}${max?' (up to '+max+' characters)':''}.`);return v;
}
function email(value){const v=text(value,'email address',254);fail(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),'Enter a valid email address.');return v;}
function password(value){fail(typeof value==='string'&&value.isWellFormed()&&value.length>=10&&value.length<=128,'Use a password between 10 and 128 characters.');return value;}
async function passwordHash(value){const salt=crypto.randomBytes(16).toString('hex');const key=await derive(password(value),salt,64,{N:16384,r:8,p:1,maxmem:64*1024*1024});return 'scrypt$'+salt+'$'+key.toString('hex');}
async function verify(value,stored){
 if(typeof value!=='string'||value.length>128)return false;
 const parts=String(stored).split('$');if(parts.length!==3||parts[0]!=='scrypt'||!/^[a-f0-9]{32}$/.test(parts[1])||!/^[a-f0-9]{128}$/.test(parts[2]))return false;
 const key=await derive(value,parts[1],64,{N:16384,r:8,p:1,maxmem:64*1024*1024});return crypto.timingSafeEqual(key,Buffer.from(parts[2],'hex'));
}
function privateUser(row){return {id:row.id,email:row.email,nickname:row.nickname,firstName:row.first_name,lastName:row.last_name,role:row.role,suspended:row.suspended,elo:row.elo,ratedGames:row.rated_games,wins:row.wins,lastPlaces:row.last_places,placementSum:row.placement_sum,peakElo:row.peak_elo,created:row.created,avatar:tk_avatar(row.avatar)};}
function bootstrapConfig(override){
 if(override!==undefined)return override;
 try{const v=JSON.parse(fs.readFileSync(path.join(__dirname,'owner-bootstrap.json'),'utf8'));return /^[a-f0-9]{64}$/.test(v.emailHash)&&/^[a-f0-9]{64}$/.test(v.tokenHash)?v:null;}catch{return null;}
}
function initAccounts(pool){
 if(!initialized.has(pool)){
  const pending=(async()=>{let c;try{c=await pool.connect();}catch(e){throw storageError(e);}try{await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5000ms'");await c.query('SELECT pg_advisory_xact_lock(1901176102)');await c.query(SQL);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK').catch(()=>{});throw storageError(e);}finally{c.release();}})().catch(e=>{initialized.delete(pool);throw e;});initialized.set(pool,pending);
 }return initialized.get(pool);
}
function checkOrigin(req){
 const headers=req.headers||{};
 if(headers.origin){
  let origin;try{origin=new URL(headers.origin);}catch{throw new GameError('This request origin is not allowed.',403);}
  if(origin.host!==headers.host||!['http:','https:'].includes(origin.protocol))throw new GameError('This request origin is not allowed.',403);
 }
 if(headers['sec-fetch-site']==='cross-site')throw new GameError('This request origin is not allowed.',403);
}
function sessionToken(cookieHeader){if(typeof cookieHeader!=='string')return null;const cookie=cookieHeader.split(';').map(v=>v.trim()).find(v=>v.startsWith(COOKIE+'='));const token=cookie?.slice(COOKIE.length+1);return /^[a-f0-9]{64}$/.test(token||'')?token:null;}
async function authenticate(client,cookieHeader,{required=false}={}){
 const token=sessionToken(cookieHeader);let row;
 if(token)row=(await client.query('SELECT a.* FROM troika_accounts a JOIN troika_sessions s ON s.user_id=a.id WHERE s.token_hash=$1 AND s.expires>CURRENT_TIMESTAMP AND NOT a.suspended',[hash(token)])).rows[0];
 if(!row){if(required)throw new GameError('Sign in to your account to continue.',401);return null;}return privateUser(row);
}
function cookie(token,secure=true,clear=false){return COOKIE+'='+(token||'')+'; Path=/; HttpOnly; SameSite=Lax; Max-Age='+(clear?0:SESSION_DAYS*86400)+(secure?'; Secure':'');}
async function createSession(c,id,secure){const token=crypto.randomBytes(32).toString('hex');await c.query("INSERT INTO troika_sessions(token_hash,user_id,expires) VALUES($1,$2,CURRENT_TIMESTAMP+INTERVAL '30 days')",[hash(token),id]);return cookie(token,secure);}
async function limit(pool,key,max,seconds){
 const row=(await pool.query(`INSERT INTO troika_account_limits(key,hits,expires) VALUES($1,1,CURRENT_TIMESTAMP+$2*INTERVAL '1 second') ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN troika_account_limits.expires<CURRENT_TIMESTAMP THEN 1 ELSE troika_account_limits.hits+1 END,expires=CASE WHEN troika_account_limits.expires<CURRENT_TIMESTAMP THEN EXCLUDED.expires ELSE troika_account_limits.expires END RETURNING hits`,[hash(key),seconds])).rows[0];fail(row.hits<=max,'Too many attempts. Please try again later.',429);
}
async function dispatchAccount(pool,request,context={}){
 fail(request&&typeof request==='object'&&!Array.isArray(request),'Send a JSON object.');
 const action=request.action;fail(typeof action==='string','Choose an account action.');await initAccounts(pool);
 const ip=String(context.ip||'unknown').slice(0,128),secure=context.secure!==false,bootstrap=bootstrapConfig(context.bootstrap);
 if(['register','login','reset','forgot'].includes(action)){
  await limit(pool,action+':ip:'+ip,action==='register'?40:30,900);
  if(action==='login'&&typeof request.email==='string')await limit(pool,'login:email:'+normalize(request.email.trim()),12,900);
 }
 if(action==='password'||action==='profile'||action.startsWith('admin_'))await limit(pool,'sensitive:ip:'+ip,150,900);
 let c;try{c=await pool.connect();}catch(e){throw storageError(e);}let transaction=false;
 try{
  await c.query('BEGIN');transaction=true;await c.query("SET LOCAL lock_timeout='5000ms'");
  let user=await authenticate(c,context.cookie),body,cookieValue;
  if(action==='me'){
   const claimed=Boolean((await c.query('SELECT 1 FROM troika_owner_claim LIMIT 1')).rows.length);body={user,ownerSetupAvailable:Boolean(bootstrap&&!claimed)};
  }else if(action==='register'){
   const address=email(request.email),name=text(request.nickname,'nickname',20),first=text(request.firstName,'first name',60,true),last=text(request.lastName,'last name',60,true),key=normalize(address);
   const isOwner=Boolean(bootstrap&&hash(key)===bootstrap.emailHash);let role='user';
   if(isOwner){
    fail(typeof request.claimToken==='string'&&request.claimToken.length<=256&&hash(request.claimToken)===bootstrap.tokenHash,'Use your private owner setup link to register this account.',403);
    await c.query('SELECT pg_advisory_xact_lock(1901176103)');fail(!(await c.query('SELECT 1 FROM troika_owner_claim LIMIT 1')).rows.length,'The owner account has already been created.',409);role='admin';
   }else fail(!request.claimToken,'The owner setup link is reserved for the owner email address.',403);
   const encoded=await passwordHash(request.password),id=crypto.randomBytes(12).toString('hex');
   const row=(await c.query('INSERT INTO troika_accounts(id,email,email_key,nickname,nickname_key,first_name,last_name,password_hash,role) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[id,address,key,name,normalize(name),first,last,encoded,role])).rows[0];
   if(isOwner)await c.query('INSERT INTO troika_owner_claim(singleton,user_id) VALUES(true,$1)',[id]);
   cookieValue=await createSession(c,id,secure);body={user:privateUser(row)};
  }else if(action==='login'){
   const key=normalize(email(request.email));const row=(await c.query('SELECT * FROM troika_accounts WHERE email_key=$1',[key])).rows[0];
   // Dummy derivation keeps unknown-account attempts comparable to known ones.
   const valid=await verify(request.password,row?.password_hash||'scrypt$00000000000000000000000000000000$'+'00'.repeat(64));
   fail(row&&valid&&!row.suspended,'Email or password is incorrect, or the account is unavailable.',401);
   const old=sessionToken(context.cookie);if(old)await c.query('DELETE FROM troika_sessions WHERE token_hash=$1',[hash(old)]);
   cookieValue=await createSession(c,row.id,secure);body={user:privateUser(row)};
  }else if(action==='logout'){
   const token=sessionToken(context.cookie);if(token)await c.query('DELETE FROM troika_sessions WHERE token_hash=$1',[hash(token)]);cookieValue=cookie('',secure,true);body={user:null};
  }else if(action==='forgot'){
   email(request.email);body={message:'Ask the Troika administrator for a private password-reset link. No email is sent automatically.'};
  }else if(action==='reset'){
   fail(typeof request.resetToken==='string'&&/^[a-f0-9]{64}$/.test(request.resetToken),'This reset link is invalid or expired.');
   const reset=(await c.query('SELECT r.user_id,a.suspended FROM troika_password_resets r JOIN troika_accounts a ON a.id=r.user_id WHERE r.token_hash=$1 AND r.expires>CURRENT_TIMESTAMP FOR UPDATE OF r,a',[hash(request.resetToken)])).rows[0];
   fail(reset&&!reset.suspended,'This reset link is invalid or expired.');const encoded=await passwordHash(request.password);
   const row=(await c.query('UPDATE troika_accounts SET password_hash=$2 WHERE id=$1 RETURNING *',[reset.user_id,encoded])).rows[0];await c.query('DELETE FROM troika_password_resets WHERE user_id=$1',[row.id]);await c.query('DELETE FROM troika_sessions WHERE user_id=$1',[row.id]);cookieValue=await createSession(c,row.id,secure);body={user:privateUser(row)};
  }else{
   fail(user,'Sign in to your account to continue.',401);
   if(action.startsWith('admin_')){fail(user.role==='admin','Only the administrator can do that.',403);}
   if(action==='profile'){
    const name=text(request.nickname,'nickname',20),first=text(request.firstName,'first name',60,true),last=text(request.lastName,'last name',60,true);
    const hasAvatar=Object.hasOwn(request,'avatar'),avatar=hasAvatar?tk_avatar(request.avatar):null;
    fail(!hasAvatar||request.avatar===null||avatar,'Choose a valid initial badge or a PNG, JPEG, or WebP avatar up to 256 pixels and 24 KB.');
    const row=(await c.query('UPDATE troika_accounts SET nickname=$2,nickname_key=$3,first_name=$4,last_name=$5,avatar=CASE WHEN $6::boolean THEN $7::jsonb ELSE avatar END WHERE id=$1 RETURNING *',[user.id,name,normalize(name),first,last,hasAvatar,avatar===null?null:JSON.stringify(avatar)])).rows[0];body={user:privateUser(row)};
   }else if(action==='password'){
    const row=(await c.query('SELECT * FROM troika_accounts WHERE id=$1 FOR UPDATE',[user.id])).rows[0];fail(await verify(request.currentPassword,row.password_hash),'Your current password is incorrect.',403);
    const encoded=await passwordHash(request.password);await c.query('UPDATE troika_accounts SET password_hash=$2 WHERE id=$1',[user.id,encoded]);await c.query('DELETE FROM troika_sessions WHERE user_id=$1',[user.id]);await c.query('DELETE FROM troika_password_resets WHERE user_id=$1',[user.id]);cookieValue=await createSession(c,user.id,secure);body={user};
   }else if(action==='admin_forgive'){
    await C.forgive(c,user,request.userId,request.reason);body={success:true};
   }else if(action==='admin_users'){
    const rows=(await c.query('SELECT * FROM troika_accounts ORDER BY created DESC LIMIT 250')).rows;body={users:rows.map(privateUser)};
   }else if(action==='admin_reset'){
    fail(typeof request.userId==='string','Choose a user.');const row=(await c.query('SELECT id,role,suspended FROM troika_accounts WHERE id=$1 FOR UPDATE',[request.userId])).rows[0];fail(row,'That user was not found.',404);fail(!row.suspended,'Unsuspend this user before resetting their password.');
    const token=crypto.randomBytes(32).toString('hex');await c.query('DELETE FROM troika_password_resets WHERE user_id=$1',[row.id]);const reset=(await c.query("INSERT INTO troika_password_resets(token_hash,user_id,expires) VALUES($1,$2,CURRENT_TIMESTAMP+INTERVAL '15 minutes') RETURNING expires",[hash(token),row.id])).rows[0];body={resetToken:token,expiresAt:reset.expires};
   }else if(action==='admin_suspend'){
    fail(typeof request.userId==='string'&&typeof request.suspended==='boolean','Choose a user and suspension status.');const row=(await c.query('SELECT id,role FROM troika_accounts WHERE id=$1 FOR UPDATE',[request.userId])).rows[0];fail(row,'That user was not found.',404);fail(row.role!=='admin','The administrator account cannot be suspended.');
    await c.query('UPDATE troika_accounts SET suspended=$2 WHERE id=$1',[row.id,request.suspended]);if(request.suspended){await c.query('DELETE FROM troika_sessions WHERE user_id=$1',[row.id]);await c.query('DELETE FROM troika_password_resets WHERE user_id=$1',[row.id]);}body={success:true};
   }else throw new GameError('Unknown account action.');
  }
  if(body.user)body.user.rankedStatus=await C.getStatus(c,body.user.id);
  if(body.users){const statuses=await C.getStatuses(c,body.users.map(u=>u.id));for(const u of body.users)u.rankedStatus=statuses[u.id];}
  await c.query('COMMIT');transaction=false;return {body,...(cookieValue?{cookie:cookieValue}:{})};
 }catch(error){if(transaction)await c.query('ROLLBACK').catch(()=>{});if(error instanceof GameError)throw error;if(error.code==='23505')throw new GameError('That email address or nickname is already registered.',409);throw storageError(error);}finally{c.release();}
}
module.exports={initAccounts,authenticate,dispatchAccount,privateUser,COOKIE,SQL,hash,normalize,checkOrigin};
