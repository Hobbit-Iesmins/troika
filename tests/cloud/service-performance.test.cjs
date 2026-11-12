'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomBytes}=require('node:crypto'),{Pool}=require('pg');
const S=require('../../cloud/service.js'),A=require('../../cloud/accounts.js');
const connectionString=process.env.TEST_DATABASE_URL;
async function database(fn){
  const schema='troika_poll_'+randomBytes(8).toString('hex'),admin=new Pool({connectionString,max:1});let pool;
  try{
    await admin.query('CREATE SCHEMA '+schema);pool=new Pool({connectionString,max:1,options:'-c search_path='+schema});
    const observed=[],setupSettings=[];let failSetup=false;
    const wrapped={query:(...args)=>pool.query(...args),connect:async()=>{
      const client=await pool.connect();
      return {release:()=>client.release(),query:async(...args)=>{
        const sql=args[0];observed.push(sql);
        if(failSetup&&sql.startsWith('BEGIN;')){failSetup=false;return client.query(sql.replace("statement_timeout = '10000ms'","statement_timeout = 'invalid'"));}
        const result=await client.query(...args);
        if(sql.startsWith('BEGIN;'))setupSettings.push((await client.query("SELECT current_setting('lock_timeout') AS lock_timeout,current_setting('statement_timeout') AS statement_timeout")).rows[0]);
        return result;
      }};
    }};
    await S.initDatabase(wrapped);observed.length=0;
    await fn({pool,wrapped,observed,setupSettings,failNextSetup:()=>{failSetup=true;}});
  }finally{await pool?.end();await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();}
}
test('warm polling batches transaction timeouts while keeping guest and account authentication',{skip:!connectionString},()=>database(async({pool,wrapped,observed,setupSettings})=>{
  const guest=await S.tk_dispatch(wrapped,{action:'create',nickname:'Guest'});
  const registered=await A.dispatchAccount(pool,{action:'register',nickname:'Member',email:'member@example.test',password:'test-password-only'},{secure:false,ip:'poll-test'});
  const cookie=registered.cookie.split(';')[0],member=await S.tk_dispatch(wrapped,{action:'create'},{cookie});
  for(const [made,context,expected] of [[guest,{},4],[member,{cookie},5]]){
    observed.length=0;setupSettings.length=0;
    const result=await S.tk_dispatch(wrapped,{action:'state',room:made.room,token:made.token},context);
    assert.equal(result.state.youId,made.state.youId);
    assert.equal(observed.length,expected,'one setup query, optional session lookup, room lock, write, and commit');
    assert.match(observed[0],/^BEGIN; SET LOCAL lock_timeout = '5000ms'; SET LOCAL statement_timeout = '10000ms'$/);
    assert.deepEqual(setupSettings,[{lock_timeout:'5s',statement_timeout:'10s'}]);
    assert.ok(observed.some(sql=>sql==='SELECT state FROM troika_rooms WHERE code=$1 FOR UPDATE'));
    assert.ok(observed.some(sql=>sql.startsWith('UPDATE troika_rooms SET state=')));
    assert.equal(observed.at(-1),'COMMIT');
    assert.equal(observed.some(sql=>sql.startsWith('SELECT a.* FROM troika_accounts')),Boolean(context.cookie));
    assert.deepEqual((await pool.query("SELECT current_setting('lock_timeout') AS lock_timeout,current_setting('statement_timeout') AS statement_timeout")).rows[0],{lock_timeout:'0',statement_timeout:'0'});
  }
}));
test('a failed timeout command after batched BEGIN rolls back before reusing the connection',{skip:!connectionString},()=>database(async({pool,wrapped,observed,failNextSetup})=>{
  const made=await S.tk_dispatch(wrapped,{action:'create',nickname:'Rollback'}),before=(await pool.query('SELECT state FROM troika_rooms WHERE code=$1',[made.room])).rows[0].state;
  observed.length=0;failNextSetup();
  await assert.rejects(()=>S.tk_dispatch(wrapped,{action:'state',room:made.room,token:made.token}));
  assert.equal(observed.length,2);assert.match(observed[0],/^BEGIN;/);assert.equal(observed[1],'ROLLBACK');
  assert.deepEqual((await pool.query('SELECT state FROM troika_rooms WHERE code=$1',[made.room])).rows[0].state,before);
  assert.deepEqual((await pool.query("SELECT current_setting('lock_timeout') AS lock_timeout,current_setting('statement_timeout') AS statement_timeout")).rows[0],{lock_timeout:'0',statement_timeout:'0'});
  assert.equal((await S.tk_dispatch(wrapped,{action:'state',room:made.room,token:made.token})).state.youId,made.state.youId);
}));
