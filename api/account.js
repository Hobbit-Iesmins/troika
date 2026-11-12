'use strict';
const {getPool:defaultGetPool,StorageError}=require('../cloud/database.js');
const {GameError}=require('../cloud/engine.js');const {readBody}=require('./game.js');
const {dispatchAccount,initAccounts,checkOrigin}=require('../cloud/accounts.js');
function createHandler(options={}){
 const getPool=options.getPool||(options.pool?()=>options.pool:defaultGetPool),dispatch=options.dispatch||dispatchAccount;
 return async function handler(req,res){
  res.setHeader('Cache-Control','no-store, private');res.setHeader('X-Content-Type-Options','nosniff');
  const respond=(status,body)=>{res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(body));};
  if(req.method!=='POST'){res.setHeader('Allow','POST');return respond(405,{error:'Use a JSON POST request.'});}
  if(!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type']||''))return respond(415,{error:'Send this request as JSON.'});
  try{
   checkOrigin(req);
   const body=await readBody(req),pool=await getPool();if(!options.dispatch)await initAccounts(pool);
   const result=await dispatch(pool,body,{cookie:req.headers.cookie,ip:req.headers['x-real-ip']||req.socket?.remoteAddress||'unknown',secure:Boolean(process.env.VERCEL||req.headers['x-forwarded-proto']==='https'||req.socket?.encrypted),...(options.bootstrap?{bootstrap:options.bootstrap}:{})});
   if(result.cookie)res.setHeader('Set-Cookie',result.cookie);respond(200,result.body);
  }catch(error){if(error instanceof GameError)respond(error.status||400,{error:error.message});else if(error instanceof StorageError){console.error('Troika: account storage unavailable.',error.code);respond(503,{error:error.message,code:error.code});}else{console.error('Troika: account request failed.');respond(500,{error:'The account action could not be completed. Please try again.'});}}
 };
}
module.exports=createHandler();module.exports.createHandler=createHandler;
