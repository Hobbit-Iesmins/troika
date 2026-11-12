'use strict';
const {getPool}=require('../cloud/database.js'),{initAccounts}=require('../cloud/accounts.js'),{tk_avatar}=require('../cloud/engine.js'),{createHash}=require('node:crypto');
function createHandler(options={}){
 return async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');
  if(req.method!=='GET'&&req.method!=='HEAD'){res.setHeader('Allow','GET, HEAD');res.statusCode=405;res.end();return;}
  const url=new URL(req.url||'/api/avatar','http://troika.internal'),id=req.query?.user||url.searchParams.get('user'),version=req.query?.v||url.searchParams.get('v');
  if(typeof id!=='string'||!/^[a-f0-9]{24}$/.test(id)){res.statusCode=404;res.end();return;}
  try{
   const pool=options.pool||getPool();await initAccounts(pool);
   const row=(await pool.query('SELECT avatar FROM troika_accounts WHERE id=$1',[id])).rows[0],avatar=tk_avatar(row?.avatar);
   if(avatar?.kind!=='image'){res.statusCode=404;res.end();return;}
   const key=createHash('sha256').update(avatar.dataUrl).digest('hex').slice(0,16),etag='"'+key+'"';
   if(version===key)res.setHeader('Cache-Control','public, max-age=86400, s-maxage=86400, immutable');
   res.setHeader('ETag',etag);
   if(req.headers?.['if-none-match']===etag){res.statusCode=304;res.end();return;}
   const [header,data]=avatar.dataUrl.split(','),bytes=Buffer.from(data,'base64');
   res.setHeader('Content-Type',header.slice(5).split(';')[0]);res.setHeader('Content-Length',String(bytes.length));res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");
   res.statusCode=200;res.end(req.method==='HEAD'?undefined:bytes);
  }catch{res.statusCode=503;res.end();}
 };
}
module.exports=createHandler();module.exports.createHandler=createHandler;
