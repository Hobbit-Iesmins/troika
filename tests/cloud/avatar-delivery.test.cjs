'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomBytes}=require('node:crypto'),{Pool}=require('pg');
const A=require('../../cloud/accounts.js'),S=require('../../cloud/service.js'),{createHandler:accountHandler}=require('../../api/account.js'),{createHandler:avatarHandler}=require('../../api/avatar.js');
const connectionString=process.env.TEST_DATABASE_URL;
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6u9kAAAAASUVORK5CYII=';
async function call(handler,{method='GET',url='/api/avatar',body,headers={}}={}){let output;const sent={};const req={method,url,headers:{'content-type':'application/json',host:'troika.test',origin:'https://troika.test',...headers},body},res={statusCode:200,setHeader(k,v){sent[k.toLowerCase()]=v;},end(v){output=v;}};await handler(req,res);return {status:res.statusCode,headers:sent,body:output};}
test('avatar upload uses a bounded account body while game polling sends only cached image URLs',{skip:!connectionString},async()=>{
 const schema='avatar_delivery_'+randomBytes(8).toString('hex'),admin=new Pool({connectionString,max:1});let pool;
 try{await admin.query('CREATE SCHEMA '+schema);pool=new Pool({connectionString,max:4,options:'-c search_path='+schema});await S.initDatabase(pool);
  const member=await A.dispatchAccount(pool,{action:'register',nickname:'Picture',email:'private@example.test',password:'test-password-only'},{secure:false,ip:'avatar'}),cookie=member.cookie.split(';')[0];
  const bytes=Buffer.concat([Buffer.from(png,'base64'),Buffer.alloc(16000)]),image={kind:'image',dataUrl:'data:image/png;base64,'+bytes.toString('base64')};assert.ok(JSON.stringify(image).length>16384);
  const saved=await call(accountHandler({pool}),{method:'POST',url:'/api/account',headers:{cookie},body:{action:'profile',nickname:'Picture',avatar:image}});assert.equal(saved.status,200);assert.equal(JSON.parse(saved.body).user.avatar.dataUrl,image.dataUrl);
  const game=await S.tk_dispatch(pool,{action:'create',seat:0},{cookie}),delivered=game.state.players[0].avatar;assert.equal(delivered.kind,'image');assert.ok(!('dataUrl' in delivered));assert.ok(delivered.url.startsWith('/api/avatar?user='));assert.ok(!JSON.stringify(game.state).includes(image.dataUrl));assert.ok(!JSON.stringify(game.state).includes('private@example.test'));
  const stored=(await pool.query('SELECT state FROM troika_rooms WHERE code=$1',[game.room])).rows[0].state;
  assert.match(stored.players[0].avatar.version,/^[a-f0-9]{16}$/);assert.deepEqual(Object.keys(stored.players[0].avatar).sort(),['kind','version']);assert.ok(!JSON.stringify(stored).includes('dataUrl'),'room rows never copy photo bytes');assert.equal(new URL(delivered.url,'https://troika.test').searchParams.get('v'),stored.players[0].avatar.version);
  const imageHandler=avatarHandler({pool}),loaded=await call(imageHandler,{url:delivered.url});assert.equal(loaded.status,200);assert.deepEqual(loaded.body,bytes);assert.equal(loaded.headers['content-type'],'image/png');assert.equal(loaded.headers['x-content-type-options'],'nosniff');assert.ok(loaded.headers['cache-control'].includes('immutable'));
  const cached=await call(imageHandler,{url:delivered.url,headers:{'if-none-match':loaded.headers.etag}});assert.equal(cached.status,304);assert.equal(cached.body,undefined);
  const head=await call(imageHandler,{method:'HEAD',url:delivered.url});assert.equal(head.status,200);assert.equal(head.body,undefined);assert.equal(head.headers['content-length'],String(bytes.length));
  const missing=await call(imageHandler,{url:'/api/avatar?user=not-valid'});assert.equal(missing.status,404);assert.equal((await call(imageHandler,{method:'POST',url:delivered.url})).status,405);
  const oversize=await call(accountHandler({pool}),{method:'POST',url:'/api/account',headers:{cookie},body:{action:'profile',nickname:'Picture',value:'x'.repeat(65536)}});assert.equal(oversize.status,413);
 }finally{await pool?.end();await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();}
});
