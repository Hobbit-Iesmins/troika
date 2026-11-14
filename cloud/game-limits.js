'use strict';
const {isIP}=require('node:net');
const {limit}=require('./accounts.js');
// Shared-IP budgets allow a full lab to join without throttling normal play.
const GAME_LIMITS=Object.freeze({
 create:Object.freeze({max:30,seconds:900}),
 join:Object.freeze({max:120,seconds:900}),
 lobby:Object.freeze({max:180,seconds:60})
});
function normalizeIp(value){
 if(typeof value!=='string'||value.length>128)return 'unknown';
 let ip=value.trim();
 if(!isIP(ip))return 'unknown';
 if(ip.toLowerCase().startsWith('::ffff:')&&isIP(ip.slice(7))===4)return ip.slice(7);
 if(isIP(ip)===6){try{ip=new URL('http://['+ip+']/').hostname.slice(1,-1);}catch{return 'unknown';}}
 return ip;
}
function clientIp(req,{vercel=Boolean(process.env.VERCEL)}={}){
 // Vercel overwrites these at its edge. Other hosts must use the connection
 // address: trusting caller-supplied forwarding headers would bypass the limit.
 const raw=vercel?(req.headers?.['x-vercel-forwarded-for']??req.headers?.['x-forwarded-for']):req.socket?.remoteAddress;
 return normalizeIp(typeof raw==='string'?raw.split(',')[0]:raw);
}
async function limitGame(pool,action,ip){
 const policy=Object.hasOwn(GAME_LIMITS,action)?GAME_LIMITS[action]:null;if(!policy)return;
 // Called after schema initialization and before the gameplay transaction.
 // Rejected joins/creates must not roll back the attempt counter.
 await limit(pool,'game:'+action+':ip:'+normalizeIp(ip),policy.max,policy.seconds);
}
module.exports={limitGame,clientIp,normalizeIp,GAME_LIMITS};
