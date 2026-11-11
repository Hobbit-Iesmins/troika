'use strict';

/** Durable shared storage. A pool caches connections, never room state. */
class StorageError extends Error {
  constructor(message = 'Game storage is unavailable. Check the PostgreSQL connection and retry.', code = 'DB_UNAVAILABLE') {
    super(message);
    this.name = 'StorageError';
    this.status = 503;
    this.code = code;
  }
}
// Return only fixed diagnostics: never database URLs, usernames, passwords or SQL.
function storageError(error) {
  if(error instanceof StorageError)return error;
  const code=String(error?.code||'');
  const text=String(error?.message||'');
  if(['SELF_SIGNED_CERT_IN_CHAIN','DEPTH_ZERO_SELF_SIGNED_CERT','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','ERR_TLS_CERT_ALTNAME_INVALID','CERT_HAS_EXPIRED'].includes(code))
    return new StorageError('Database TLS certificate verification failed. The host needs to configure the Supabase CA certificate.','DB_TLS_CERTIFICATE');
  if(code==='28P01'||/password authentication failed/i.test(text))
    return new StorageError('Database login failed. Check the database password in DATABASE_URL, then redeploy.','DB_AUTH_FAILED');
  if(/tenant or user not found/i.test(text))
    return new StorageError('Supabase could not find this database user. Copy the complete Transaction pooler URI again, including its postgres.project-reference username.','DB_POOLER_USER');
  if(['ENOTFOUND','EAI_AGAIN'].includes(code))return new StorageError('Database hostname could not be resolved. Check the host in DATABASE_URL.','DB_DNS');
  if(['ENETUNREACH','EHOSTUNREACH','ECONNREFUSED'].includes(code))return new StorageError('Database connection is unreachable. Check the Supabase pooler address and project status.','DB_NETWORK');
  if(['ETIMEDOUT','ECONNRESET','57P03','53300'].includes(code)||/timeout|timed out/i.test(text))return new StorageError('Database connection timed out. Check the Supabase project status and connection limits.','DB_TIMEOUT');
  if(code==='42501')return new StorageError('Database user lacks permission to create or update the game table.','DB_PERMISSION');
  if(code==='3D000')return new StorageError('The database name in DATABASE_URL was not found.','DB_NAME');
  return new StorageError();
}
let sharedPool;
function poolConfig(env = process.env) {
  const connectionString = env.DATABASE_URL || env.POSTGRES_URL;
  if (!connectionString) throw new StorageError('Connect a PostgreSQL database and set DATABASE_URL in Vercel, then redeploy.');
  let url;
  try { url = new URL(connectionString); } catch { throw new StorageError('DATABASE_URL must be a valid PostgreSQL connection URL.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new StorageError('DATABASE_URL must use PostgreSQL.');
  const host = (url.searchParams.get('host') || url.hostname).toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
  const sslmode = url.searchParams.get('sslmode');
  const ssl = url.searchParams.get('ssl');
  if (sslmode === 'no-verify' || (!loopback && (sslmode === 'disable' || ['0', 'false', 'no'].includes(ssl)))) {
    throw new StorageError('Hosted PostgreSQL requires verified TLS. Use sslmode=verify-full in DATABASE_URL.');
  }
  // Pin require/prefer/verify-ca to full verification so future libpq semantics cannot weaken TLS.
  // Preserve provider CA/client-certificate parameters rather than silently discarding them.
  if (!loopback || (sslmode && sslmode !== 'disable') || ['1', 'true'].includes(ssl)) url.searchParams.set('sslmode', 'verify-full');
  url.searchParams.delete('uselibpqcompat');
  let tls;
  const fs=require('node:fs'), path=require('node:path');
  const certificateFile=path.join(__dirname,'certs','supabase.crt');
  const ca=env.DATABASE_CA_CERT || (fs.existsSync(certificateFile)?fs.readFileSync(certificateFile,'utf8'):null);
  if(ca){
    const certificate=ca.replace(/\\n/g,'\n');
    if(!certificate.includes('-----BEGIN CERTIFICATE-----')||!certificate.includes('-----END CERTIFICATE-----'))throw new StorageError('DATABASE_CA_CERT must contain the public PEM CA certificate.','DB_CA_FORMAT');
    tls={ca:certificate,rejectUnauthorized:true};
    // pg URL SSL fields override the ssl object, so move certificate options out of the URL.
    for(const [param,key] of [['sslcert','cert'],['sslkey','key']])if(url.searchParams.has(param)){
      try{tls[key]=fs.readFileSync(url.searchParams.get(param),'utf8');}catch{throw new StorageError('Database client certificate configuration could not be loaded.','DB_CA_FORMAT');}
    }
    for(const key of ['sslmode','ssl','sslrootcert','sslcert','sslkey','sslnegotiation'])url.searchParams.delete(key);
  }
  return {
    ...(tls?{ssl:tls}:{}),
    connectionString: url.toString(),
    max: 3,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 8000,
    allowExitOnIdle: true
  };
}
function getPool(env = process.env) {
  if (sharedPool) return sharedPool;
  const config = poolConfig(env);
  const { Pool } = require('pg');
  sharedPool = new Pool(config);
  sharedPool.on('error', () => { console.error('Troika: idle database connection closed.'); });
  return sharedPool;
}
async function closePool() {
  const pool = sharedPool;
  sharedPool = undefined;
  if (pool) await pool.end();
}
module.exports = { getPool, closePool, poolConfig, StorageError, storageError };
