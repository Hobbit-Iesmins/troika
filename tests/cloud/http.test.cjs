'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const {Readable}=require('node:stream');
const {createHandler}=require('../../api/game.js');const {GameError}=require('../../cloud/engine.js');const {StorageError}=require('../../cloud/database.js');
async function invoke(options={},input={}){
 const req=Readable.from(input.chunks||[]);req.method=input.method||'POST';req.headers={'content-type':'application/json',...input.headers};if(Object.hasOwn(input,'body'))req.body=input.body;
 const headers={};let text;const res={statusCode:200,setHeader:(k,v)=>{headers[k.toLowerCase()]=v;},end:v=>{text=v;}};
 await createHandler({getPool:()=>({}),dispatch:async(_pool,body)=>({echo:body}),...options})(req,res);
 return {status:res.statusCode,headers,body:JSON.parse(text)};
}
test('HTTP endpoint accepts parsed and streamed JSON with no-store headers',async()=>{
 for(const input of [{body:{action:'state'}},{body:'{"action":"state"}'},{body:Buffer.from('{"action":"state"}')},{chunks:[Buffer.from('{"action":'),Buffer.from('"state"}')]}]){
  const r=await invoke({},input);assert.equal(r.status,200);assert.deepEqual(r.body.echo,{action:'state'});assert.equal(r.headers['cache-control'],'no-store, private');assert.equal(r.headers['x-content-type-options'],'nosniff');assert.match(r.headers['content-type'],/application\/json/);assert.ok(!r.headers['access-control-allow-origin']);
 }
});
test('HTTP endpoint rejects other methods, media types and malformed/non-object JSON',async()=>{
 let r=await invoke({}, {method:'GET'});assert.equal(r.status,405);assert.equal(r.headers.allow,'POST');
 r=await invoke({}, {headers:{'content-type':'text/plain'},body:'{}'});assert.equal(r.status,415);
 for(const body of ['{','[]','null','"hello"',Buffer.from([0xff])]){r=await invoke({}, {body});assert.equal(r.status,400);}
});
test('HTTP body limit applies to header, parsed, string and chunked bodies',async()=>{
 for(const input of [{headers:{'content-length':'16385'},body:{}},{body:'x'.repeat(16385)},{body:{value:'x'.repeat(16385)}},{chunks:[Buffer.alloc(9000),Buffer.alloc(9000)]}])assert.equal((await invoke({},input)).status,413);
});
test('HTTP maps user errors and safe configuration failures without leaking internals',async()=>{
 let r=await invoke({dispatch:async()=>{throw new GameError('Only the host can do that.',403);}},{body:{action:'start'}});assert.equal(r.status,403);assert.equal(r.body.error,'Only the host can do that.');
 r=await invoke({getPool:()=>{throw new StorageError('Connect a PostgreSQL database and set DATABASE_URL in Vercel, then redeploy.');}},{body:{action:'create'}});assert.equal(r.status,503);assert.match(r.body.error,/DATABASE_URL/);
 r=await invoke({dispatch:async()=>{throw new Error('postgres://secret:password@example.test/private');}},{body:{action:'state'}});assert.equal(r.status,500);assert.equal(JSON.stringify(r).includes('password'),false);assert.equal(JSON.stringify(r).includes('example.test'),false);
});

test('database configuration requires verified hosted TLS and preserves provider certificate settings',()=>{
 const {poolConfig}=require('../../cloud/database.js');
 for(const suffix of ['', '?sslmode=require', '?sslmode=prefer', '?sslmode=verify-ca', '?ssl=true&uselibpqcompat=true']){
  const url=new URL(poolConfig({DATABASE_URL:'postgresql://user:example@db.example.test/troika'+suffix}).connectionString);
  assert.equal(url.searchParams.get('sslmode'),'verify-full');assert.equal(url.searchParams.has('uselibpqcompat'),false);
 }
 for(const suffix of ['?sslmode=disable','?sslmode=no-verify','?ssl=false','?ssl=0'])assert.throws(()=>poolConfig({DATABASE_URL:'postgresql://db.example.test/troika'+suffix}),StorageError);
 const local=new URL(poolConfig({DATABASE_URL:'postgresql://agent@127.0.0.1:55432/troika_test?sslmode=disable'}).connectionString);assert.equal(local.searchParams.get('sslmode'),'disable');
 const provider=new URL(poolConfig({POSTGRES_URL:'postgresql://user@db.example.test/troika?sslmode=require&sslrootcert=%2Fprovider%2Froot.pem&sslcert=%2Fprovider%2Fclient.pem&sslkey=%2Fprovider%2Fclient.key'}).connectionString);
 assert.equal(provider.searchParams.get('sslmode'),'verify-full');assert.equal(provider.searchParams.get('sslrootcert'),'/provider/root.pem');assert.equal(provider.searchParams.get('sslcert'),'/provider/client.pem');assert.equal(provider.searchParams.get('sslkey'),'/provider/client.key');
 assert.throws(()=>poolConfig({}),StorageError);assert.throws(()=>poolConfig({DATABASE_URL:'https://db.example.test'}),StorageError);
});

test('database diagnostics classify causes without exposing credentials or raw messages',async()=>{
 const {storageError}=require('../../cloud/database.js');
 for(const [code,expected] of [['28P01','DB_AUTH_FAILED'],['SELF_SIGNED_CERT_IN_CHAIN','DB_TLS_CERTIFICATE'],['ENOTFOUND','DB_DNS'],['ENETUNREACH','DB_NETWORK'],['42501','DB_PERMISSION']]){
  const error=storageError({code,message:'postgres://secret:password@private.example/db'});assert.equal(error.code,expected);assert.ok(!error.message.includes('secret'));assert.ok(!error.message.includes('private.example'));
  const response=await invoke({dispatch:async()=>{throw error;}},{body:{action:'state'}});assert.equal(response.status,503);assert.equal(response.body.code,expected);
 }
 assert.equal(storageError({message:'Tenant or user not found'}).code,'DB_POOLER_USER');assert.equal(storageError(new Error('password=secret unknown failure')).code,'DB_UNAVAILABLE');
});

test('Supabase public CA is used without URL overriding verification',()=>{
 const {poolConfig}=require('../../cloud/database.js');
 const pem='-----BEGIN CERTIFICATE-----\npublic-example\n-----END CERTIFICATE-----';
 const config=poolConfig({DATABASE_URL:'postgresql://user:example@db.example.test/postgres?sslmode=require',DATABASE_CA_CERT:pem.replaceAll('\n','\\n')});
 assert.equal(config.ssl.ca,pem);assert.equal(config.ssl.rejectUnauthorized,true);assert.equal(new URL(config.connectionString).searchParams.has('sslmode'),false);
 assert.throws(()=>poolConfig({DATABASE_URL:'postgresql://db.example.test/postgres',DATABASE_CA_CERT:'not a PEM certificate'}),StorageError);
});

test('bundled public CA applies to Supabase, while other providers and local tests keep their own TLS configuration',()=>{
 const {poolConfig}=require('../../cloud/database.js');
 const c=poolConfig({DATABASE_URL:'postgresql://example@example.pooler.supabase.com:6543/postgres?sslmode=require'});
 assert.match(c.ssl.ca,/BEGIN CERTIFICATE/);assert.equal(c.ssl.rejectUnauthorized,true);assert.equal(new URL(c.connectionString).searchParams.has('sslmode'),false);
 assert.equal(poolConfig({DATABASE_URL:'postgresql://example@db.example.test/postgres'}).ssl,undefined);
 assert.equal(new URL(poolConfig({DATABASE_URL:'postgresql://agent@127.0.0.1:55432/test?sslmode=disable'}).connectionString).searchParams.get('sslmode'),'disable');
});
