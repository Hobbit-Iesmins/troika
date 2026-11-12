'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomBytes}=require('node:crypto'),{Pool}=require('pg');
const A=require('../../cloud/accounts.js'),{createHandler}=require('../../api/account.js');
const connectionString=process.env.TEST_DATABASE_URL;
const boot={emailHash:A.hash('owner@example.test'),tokenHash:A.hash('owner-private-token')};
const cookie=result=>result.cookie?.split(';')[0];
async function setup(run){const schema='account_test_'+randomBytes(6).toString('hex'),admin=new Pool({connectionString,max:1});let pool;
 try{await admin.query('CREATE SCHEMA '+schema);pool=new Pool({connectionString,max:5,options:'-c search_path='+schema});await A.initAccounts(pool);await run(pool);}finally{if(pool)await pool.end();await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();}}
const dbTest=(name,run)=>test(name,{skip:!connectionString},()=>setup(run));
const register=(pool,email='user@example.test',extra={})=>A.dispatchAccount(pool,{action:'register',email,nickname:email.split('@')[0],password:'Strong password for tests',...extra},{ip:email,bootstrap:boot});
dbTest('registration hashes passwords, protects owner bootstrap and exposes only private profile to its session',async pool=>{
 const ordinary=await register(pool);assert.equal(ordinary.body.user.role,'user');assert.equal(ordinary.body.user.elo,500);assert.ok(!('password_hash' in ordinary.body.user));assert.match(ordinary.cookie,/HttpOnly/);assert.match(ordinary.cookie,/SameSite=Lax/);assert.match(ordinary.cookie,/Secure/);
 let saved=(await pool.query('SELECT * FROM troika_accounts WHERE id=$1',[ordinary.body.user.id])).rows[0];assert.match(saved.password_hash,/^scrypt\$/);assert.ok(!saved.password_hash.includes('Strong password'));
 await assert.rejects(()=>register(pool,'owner@example.test'),e=>e.status===403);await assert.rejects(()=>register(pool,'owner@example.test',{claimToken:'wrong'}),e=>e.status===403);await assert.rejects(()=>register(pool,'wrong@example.test',{claimToken:'owner-private-token'}),e=>e.status===403);
 const owner=await register(pool,'owner@example.test',{claimToken:'owner-private-token'});assert.equal(owner.body.user.role,'admin');await assert.rejects(()=>register(pool,'owner@example.test',{claimToken:'owner-private-token'}),e=>e.status===409);
 const me=await A.dispatchAccount(pool,{action:'me'},{cookie:cookie(ordinary),bootstrap:boot});assert.equal(me.body.user.id,ordinary.body.user.id);assert.equal(me.body.ownerSetupAvailable,false);assert.equal((await A.dispatchAccount(pool,{action:'me'},{bootstrap:boot})).body.user,null);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM troika_sessions')).rows[0].n,2);
 const token=cookie(ordinary).split('=')[1];assert.equal((await pool.query('SELECT token_hash FROM troika_sessions WHERE user_id=$1',[ordinary.body.user.id])).rows[0].token_hash,A.hash(token));
 const c=await pool.connect();try{assert.equal((await A.authenticate(c,cookie(ordinary))).id,ordinary.body.user.id);assert.equal(await A.authenticate(c,'troika_session=invalid'),null);await assert.rejects(()=>A.authenticate(c,'',{required:true}),e=>e.status===401);}finally{c.release();}
 await assert.rejects(()=>register(pool,'USER@example.test',{nickname:'other'}),e=>e.status===409);await assert.rejects(()=>register(pool,'other@example.test',{nickname:'USER'}),e=>e.status===409);
});
dbTest('login, password changes and logout rotate or revoke sessions and reject invalid credentials',async pool=>{
 const user=await register(pool),id=user.body.user.id;
 await assert.rejects(()=>A.dispatchAccount(pool,{action:'login',email:'user@example.test',password:'bad'},{ip:'login1'}),e=>e.status===401);
 const login=await A.dispatchAccount(pool,{action:'login',email:'user@example.test',password:'Strong password for tests'},{cookie:cookie(user),ip:'login2'});assert.notEqual(cookie(login),cookie(user));assert.equal((await A.dispatchAccount(pool,{action:'me'},{cookie:cookie(user)})).body.user,null);
 await assert.rejects(()=>A.dispatchAccount(pool,{action:'password',currentPassword:'bad',password:'A new strong password'},{cookie:cookie(login)}),e=>e.status===403);
 const changed=await A.dispatchAccount(pool,{action:'password',currentPassword:'Strong password for tests',password:'A new strong password'},{cookie:cookie(login)});assert.equal(changed.body.user.id,id);assert.equal((await A.dispatchAccount(pool,{action:'me'},{cookie:cookie(login)})).body.user,null);
 const profile=await A.dispatchAccount(pool,{action:'profile',nickname:'Updated',firstName:'Private',lastName:'Details'},{cookie:cookie(changed)});assert.equal(profile.body.user.firstName,'Private');assert.equal(profile.body.user.nickname,'Updated');
 const logout=await A.dispatchAccount(pool,{action:'logout'},{cookie:cookie(changed)});assert.match(logout.cookie,/Max-Age=0/);assert.equal((await A.dispatchAccount(pool,{action:'me'},{cookie:cookie(changed)})).body.user,null);
});
dbTest('only the administrator can create expiring one-use password resets and suspend users',async pool=>{
 const user=await register(pool),owner=await register(pool,'owner@example.test',{claimToken:'owner-private-token'}),id=user.body.user.id;
 for(const action of ['admin_users','admin_reset','admin_suspend'])await assert.rejects(()=>A.dispatchAccount(pool,{action,userId:id,suspended:true},{cookie:cookie(user)}),e=>e.status===403);
 const reset=await A.dispatchAccount(pool,{action:'admin_reset',userId:id},{cookie:cookie(owner)});assert.equal(reset.body.resetToken.length,64);assert.ok(reset.body.expiresAt);const raw=JSON.stringify((await pool.query('SELECT * FROM troika_password_resets')).rows);assert.ok(!raw.includes(reset.body.resetToken));
 const applied=await A.dispatchAccount(pool,{action:'reset',resetToken:reset.body.resetToken,password:'Reset password is secure'},{ip:'reset1'});assert.equal(applied.body.user.id,id);assert.equal((await A.dispatchAccount(pool,{action:'me'},{cookie:cookie(user)})).body.user,null);
 await assert.rejects(()=>A.dispatchAccount(pool,{action:'reset',resetToken:reset.body.resetToken,password:'Another reset password'},{ip:'reset2'}));
 const expired=await A.dispatchAccount(pool,{action:'admin_reset',userId:id},{cookie:cookie(owner)});await pool.query("UPDATE troika_password_resets SET expires=CURRENT_TIMESTAMP-INTERVAL '1 minute'");await assert.rejects(()=>A.dispatchAccount(pool,{action:'reset',resetToken:expired.body.resetToken,password:'Another reset password'},{ip:'reset3'}));
 await A.dispatchAccount(pool,{action:'admin_suspend',userId:id,suspended:true},{cookie:cookie(owner)});assert.equal((await A.dispatchAccount(pool,{action:'me'},{cookie:cookie(applied)})).body.user,null);await assert.rejects(()=>A.dispatchAccount(pool,{action:'login',email:'user@example.test',password:'Reset password is secure'},{ip:'suspended'}),e=>e.status===401);
 await assert.rejects(()=>A.dispatchAccount(pool,{action:'admin_suspend',userId:owner.body.user.id,suspended:true},{cookie:cookie(owner)}));
 await A.dispatchAccount(pool,{action:'admin_suspend',userId:id,suspended:false},{cookie:cookie(owner)});const list=await A.dispatchAccount(pool,{action:'admin_users'},{cookie:cookie(owner)});assert.equal(list.body.users.length,2);assert.ok(!JSON.stringify(list.body).includes('password_hash'));
 const forgot=await A.dispatchAccount(pool,{action:'forgot',email:'missing@example.test'},{ip:'forgot'});assert.ok(forgot.body.message.includes('No email is sent'));assert.ok(!('resetToken' in forgot.body));
});
dbTest('rate limits persist when login failures rollback',async pool=>{
 await register(pool);for(let i=0;i<12;i++)await assert.rejects(()=>A.dispatchAccount(pool,{action:'login',email:'user@example.test',password:'bad'},{ip:'rate-'+i}),e=>e.status===401);
 await assert.rejects(()=>A.dispatchAccount(pool,{action:'login',email:'user@example.test',password:'Strong password for tests'},{ip:'rate-final'}),e=>e.status===429);
});
test('account endpoint checks origin, content type, methods and cookie response flags',async()=>{
 const invoke=async(headers={},method='POST',body={action:'me'})=>{const h={};let data;const req={method,headers:{'content-type':'application/json',host:'troika.example.test',...headers},body},res={setHeader:(k,v)=>h[k]=v,end:v=>{data=JSON.parse(v);}};await createHandler({getPool:()=>({}),dispatch:async()=>({body:{user:null},cookie:'troika_session=test; HttpOnly; Secure; SameSite=Lax'})})(req,res);return {status:res.statusCode,headers:h,body:data};};
 assert.equal((await invoke({origin:'https://evil.example.test'})).status,403);assert.equal((await invoke({'sec-fetch-site':'cross-site'})).status,403);assert.equal((await invoke({'content-type':'text/plain'})).status,415);assert.equal((await invoke({},'GET')).status,405);
 const good=await invoke({origin:'https://troika.example.test'});assert.equal(good.status,200);assert.match(good.headers['Set-Cookie'],/HttpOnly/);assert.equal(good.headers['Cache-Control'],'no-store, private');assert.equal((await invoke({},'POST',[])).status,400);
});
