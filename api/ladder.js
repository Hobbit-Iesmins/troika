'use strict';
const {getPool:defaultGetPool,StorageError}=require('../cloud/database.js');
const {GameError}=require('../cloud/engine.js');
const {initDatabase}=require('../cloud/service.js');
const A=require('../cloud/accounts.js'),R=require('../cloud/rankings.js');
const {readBody}=require('./game.js');
function createHandler(options={}){
 const getPool=options.getPool||(options.pool?()=>options.pool:defaultGetPool);
 return async(req,res)=>{
  res.setHeader('Cache-Control','no-store, private');res.setHeader('X-Content-Type-Options','nosniff');
  const reply=(status,body)=>{res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(body));};
  if(req.method!=='POST'){res.setHeader('Allow','POST');return reply(405,{error:'Use a JSON POST request.'});}
  if(!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type']||''))return reply(415,{error:'Send this request as JSON.'});
  let client,transaction=false;
  try{
   A.checkOrigin(req);const body=await readBody(req),pool=await getPool();await initDatabase(pool);client=await pool.connect();
   await client.query('BEGIN');transaction=true;await client.query("SET LOCAL lock_timeout='5000ms'");await client.query("SET LOCAL statement_timeout='10000ms'");
   let result;
   if(body.action==='leaderboard')result=await R.leaderboard(client);
   else{
    const user=await A.authenticate(client,req.headers.cookie,{required:true});
    if(body.action==='history')result={matches:await R.history(client,user.id)};
    else if(body.action==='admin_correct')result={result:await R.correctRating(client,user,body.userId,body.newRating,body.reason)};
    else throw new GameError('Unknown ladder action.');
   }
   await client.query('COMMIT');transaction=false;reply(200,result);
  }catch(error){
   if(transaction)await client.query('ROLLBACK').catch(()=>{});
   if(error instanceof GameError)reply(error.status||400,{error:error.message});
   else if(error instanceof StorageError)reply(503,{error:error.message,code:error.code});
   else{console.error('Troika: ladder request failed.');reply(500,{error:'The ladder could not complete that request. Please retry.'});}
  }finally{client?.release();}
 };
}
module.exports=createHandler();module.exports.createHandler=createHandler;
