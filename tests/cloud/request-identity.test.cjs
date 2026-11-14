'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createHandler}=require('../../api/account.js'),{GameError}=require('../../cloud/engine.js');
async function request(dispatch,extra={}){
 const req={method:'POST',headers:{'content-type':'application/json',host:'troika.test',...extra.headers},body:{action:'login',ip:'198.51.100.99'},socket:extra.socket};
 const headers={};let body;const res={statusCode:200,setHeader(k,v){headers[k.toLowerCase()]=v;},end(value){body=JSON.parse(value);}};
 await createHandler({pool:{},dispatch})(req,res);return {status:res.statusCode,headers,body};
}
test('account quotas use the same trusted address as game quotas and expose a safe retry delay',async()=>{
 const previous=process.env.VERCEL;
 try{
  delete process.env.VERCEL;
  const dispatch=async(_pool,_body,context)=>({body:{ip:context.ip}});
  const headers={'x-real-ip':'198.51.100.1','x-forwarded-for':'198.51.100.2','x-vercel-forwarded-for':'198.51.100.3'};
  const direct=await request(dispatch,{headers,socket:{remoteAddress:'::ffff:192.0.2.4'}});assert.equal(direct.body.ip,'192.0.2.4');
  process.env.VERCEL='1';assert.equal((await request(dispatch,{headers})).body.ip,'198.51.100.3');
  const error=new GameError('Too many attempts. Please try again later.',429);error.retryAfter=12;
  const limited=await request(async()=>{throw error;});assert.equal(limited.status,429);assert.equal(limited.headers['retry-after'],'12');
  error.retryAfter='12\r\nInjected: yes';assert.equal((await request(async()=>{throw error;})).headers['retry-after'],undefined);
 }finally{if(previous===undefined)delete process.env.VERCEL;else process.env.VERCEL=previous;}
});
