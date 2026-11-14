'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomBytes}=require('node:crypto'),{Pool}=require('pg');
const S=require('../../cloud/service.js'),E=require('../../cloud/engine.js');
const connectionString=process.env.TEST_DATABASE_URL;
test('conduct discovery indexes active participant IDs without overlooking a player with no cooldown',{skip:!connectionString},async()=>{
 const schema='troika_lookup_'+randomBytes(8).toString('hex'),admin=new Pool({connectionString,max:1});let pool;
 try{
  await admin.query('CREATE SCHEMA '+schema);pool=new Pool({connectionString,max:2,options:'-c search_path='+schema});await S.initDatabase(pool);
  const account='a'.repeat(24),other='b'.repeat(24),now=E.tk_now();
  const host=E.tk_new_player('Current member',0,false),peer=E.tk_new_player('Peer',1,false);
  host.accountId=account;peer.accountId=other;peer.ready=true;
  const g=E.tk_new_game('MATCH',host);g.players.push(peer);E.tk_start(g);
  g.ranked=true;g.ranking={id:'c'.repeat(32),status:'pending',startedAt:new Date(now*1000).toISOString(),conductSince:now,participants:[]};
  await pool.query('INSERT INTO troika_rooms(code,state) VALUES($1,$2::jsonb)',[g.room,JSON.stringify(g)]);
  // Distractors include casual/finished rooms and an account ID occurring only
  // in a name, token or longer ID. None is an active membership match.
  const states=[
   {...g,ranked:false}, {...g,status:'finished'},
   {...g,players:[{...host,accountId:account+'0'}]},
   {...g,players:[{...host,accountId:other,name:account,tokenHash:account}]},
   {...g,players:[]}
  ];
  await pool.query(`INSERT INTO troika_rooms(code,state)
   SELECT 'DECOY'||n,($1::jsonb)->((n%5)::integer) FROM generate_series(1,1500) n`,[JSON.stringify(states)]);
  await pool.query('ANALYZE troika_rooms');
  let lookup;
  const observed={connect:()=>pool.connect(),query:async(sql,values)=>{const result=await pool.query(sql,values);if(sql.startsWith('SELECT code FROM troika_rooms'))lookup={sql,values,rows:result.rows};return result;}};
  await S.refreshAccountConduct(observed,account);
  assert.deepEqual(lookup.rows,[{code:'MATCH'}]);
  const plan=(await pool.query('EXPLAIN (FORMAT JSON) '+lookup.sql,lookup.values)).rows[0]['QUERY PLAN'];
  assert.ok(JSON.stringify(plan).includes('troika_active_ranked_accounts_idx'),'representative multi-room lookup uses the membership index');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM troika_ranked_abandonments')).rows[0].n,0);
  const saved=(await pool.query('SELECT state FROM troika_rooms WHERE code=$1',['MATCH'])).rows[0].state;
  assert.deepEqual(saved,g,'fresh membership checks do not mutate the room');
 }finally{await pool?.end();await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();}
});
