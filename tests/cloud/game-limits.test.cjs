'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomBytes}=require('node:crypto'),{Pool}=require('pg');
const A=require('../../cloud/accounts.js'),S=require('../../cloud/service.js'),{GameError}=require('../../cloud/engine.js');
const {createHandler}=require('../../api/game.js'),{limitGame,clientIp,normalizeIp,GAME_LIMITS}=require('../../cloud/game-limits.js');
const connectionString=process.env.TEST_DATABASE_URL;
async function database(fn){
 const schema='troika_game_limit_'+randomBytes(8).toString('hex'),admin=new Pool({connectionString,max:1});let pool;
 try{await admin.query('CREATE SCHEMA '+schema);pool=new Pool({connectionString,max:8,options:'-c search_path='+schema});await S.initDatabase(pool);await fn(pool);}
 finally{await pool?.end();await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();}
}
function dbTest(name,fn){test(name,{skip:!connectionString},()=>database(fn));}
async function http(options={},request={}){
 const req={method:'POST',headers:{'content-type':'application/json',host:'troika.test',...request.headers},body:request.body||{action:'create'},socket:request.socket};
 const headers={};let body;
 const res={statusCode:200,setHeader(k,v){headers[k.toLowerCase()]=v;},end(value){body=JSON.parse(value);}};
 await createHandler({pool:{},dispatch:async(_pool,_request,context)=>({context}),...options})(req,res);
 return {status:res.statusCode,headers,body};
}
test('game IP identities trust only the deployment proxy or the direct connection',async()=>{
 const req={headers:{'x-vercel-forwarded-for':'198.51.100.9','x-forwarded-for':'198.51.100.8','x-real-ip':'198.51.100.7'},socket:{remoteAddress:'::ffff:192.0.2.5'}};
 assert.equal(clientIp(req,{vercel:false}),'192.0.2.5');
 assert.equal(clientIp(req,{vercel:true}),'198.51.100.9');
 assert.equal(clientIp({headers:{'x-forwarded-for':'2001:0DB8:0000::1, 192.0.2.1'}},{vercel:true}),'2001:db8::1');
 for(const raw of [undefined,null,{},['198.51.100.9'],'garbage','192.0.2.1\r\nInjected: yes','x'.repeat(1000)])assert.equal(clientIp({headers:{'x-vercel-forwarded-for':raw}},{vercel:true}),'unknown');
 assert.equal(clientIp({headers:{'x-real-ip':'198.51.100.7'}},{vercel:false}),'unknown');
 assert.equal(normalizeIp('2001:db8:0:0:0:0:0:1'),normalizeIp('2001:db8::1'));
 const prior=process.env.VERCEL;delete process.env.VERCEL;
 try{
  const result=await http({}, {body:{action:'create',ip:'198.51.100.99'},headers:req.headers,socket:req.socket});
  assert.equal(result.status,200);assert.equal(result.body.context.ip,'192.0.2.5','request body and caller proxy headers cannot choose the bucket');
  assert.equal((await http()).body.context.ip,'unknown');
  process.env.VERCEL='1';assert.equal((await http({},req)).body.context.ip,'198.51.100.9');
 }finally{if(prior===undefined)delete process.env.VERCEL;else process.env.VERCEL=prior;}
});
test('game throttling returns 429 with a safe Retry-After without leaking counter identities',async()=>{
 const error=new GameError('Too many attempts. Please try again later.',429);error.retryAfter=14;
 const result=await http({dispatch:async()=>{throw error;}});assert.equal(result.status,429);assert.equal(result.headers['retry-after'],'14');assert.deepEqual(result.body,{error:error.message});
 error.retryAfter='14\r\nInjected: yes';assert.equal((await http({dispatch:async()=>{throw error;}})).headers['retry-after'],undefined);
});
test('normal state polling and gameplay do not touch any rate-limit counter',async()=>{
 const pool={query(){throw new Error('Normal gameplay must not query the limiter');}};
 for(const action of ['state','play','pickup','jump','pause','ready','start','leave','__proto__','toString'])await limitGame(pool,action,'192.0.2.1');
});
test('rate-limit storage failures keep safe service-unavailable diagnostics',async()=>{
 const error=Object.assign(new Error('private storage details'),{code:'ECONNREFUSED'});
 const pool={query:async()=>{throw error;}};
 const result=await http({dispatch:()=>limitGame(pool,'create','192.0.2.1')});
 assert.equal(result.status,503);assert.equal(result.body.code,'DB_NETWORK');assert.ok(!JSON.stringify(result.body).includes('private storage details'));
});
dbTest('persistent game quotas isolate actions and IPs, survive cold pools, and reset after expiry',async pool=>{
 const ip='192.0.2.10',policy=GAME_LIMITS.create,key=A.hash('game:create:ip:'+ip);
 for(let i=0;i<policy.max;i++)await limitGame(pool,'create',ip);
 let rejected;try{await limitGame(pool,'create',ip);}catch(error){rejected=error;}
 assert.equal(rejected?.status,429);assert.ok(rejected.retryAfter>0&&rejected.retryAfter<=policy.seconds);
 const row=(await pool.query('SELECT key,hits FROM troika_account_limits WHERE key=$1',[key])).rows[0];assert.equal(row.hits,policy.max+1);assert.ok(!row.key.includes(ip));
 const second=new Pool({...pool.options,max:1});try{await assert.rejects(()=>limitGame(second,'create',ip),error=>error.status===429);}finally{await second.end();}
 await limitGame(pool,'create','192.0.2.11');await limitGame(pool,'join',ip);await limitGame(pool,'lobby',ip);
 await pool.query("UPDATE troika_account_limits SET expires=CURRENT_TIMESTAMP+INTERVAL '7 seconds' WHERE key=$1",[key]);
 await assert.rejects(()=>limitGame(pool,'create',ip),error=>error.status===429&&error.retryAfter>0&&error.retryAfter<=7);
 await pool.query("UPDATE troika_account_limits SET expires=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE key=$1",[key]);await limitGame(pool,'create',ip);
 assert.equal((await pool.query('SELECT hits FROM troika_account_limits WHERE key=$1',[key])).rows[0].hits,1);
});
dbTest('concurrent requests atomically enforce the shared counter and unknown identities cannot bypass it',async pool=>{
 const ip='198.51.100.10',policy=GAME_LIMITS.create;
 const outcomes=await Promise.allSettled(Array.from({length:policy.max+10},()=>limitGame(pool,'create',ip)));
 assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,policy.max);assert.ok(outcomes.filter(r=>r.status==='rejected').every(r=>r.reason.status===429));
 for(let i=0;i<policy.max;i++)await limitGame(pool,'create',i%2?'not-an-address':undefined);
 await assert.rejects(()=>limitGame(pool,'create',''),error=>error.status===429);
});
dbTest('failed create/join/lobby attempts consume game quota outside the rolled-back table transaction',async pool=>{
 for(const action of ['create','join','lobby']){
  const policy=GAME_LIMITS[action],ip='203.0.113.'+({create:1,join:2,lobby:3}[action]),key=A.hash('game:'+action+':ip:'+ip);
  await pool.query("INSERT INTO troika_account_limits(key,hits,expires) VALUES($1,$2,CURRENT_TIMESTAMP+INTERVAL '15 minutes')",[key,policy.max-1]);
  const body=action==='create'?{action,nickname:''}:{action,room:'MISSX',nickname:'Guest',seat:1};
  await assert.rejects(()=>S.tk_dispatch(pool,body,{ip}),error=>error.status===400||error.status===404);
  assert.equal((await pool.query('SELECT hits FROM troika_account_limits WHERE key=$1',[key])).rows[0].hits,policy.max);
  await assert.rejects(()=>S.tk_dispatch(pool,body,{ip}),error=>error.status===429);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM troika_rooms')).rows[0].n,0);
 }
});
