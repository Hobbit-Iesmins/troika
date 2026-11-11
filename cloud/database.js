'use strict';

/** Durable shared storage. A pool caches connections, never room state. */
class StorageError extends Error {
  constructor(message = 'Game storage is unavailable. Check the PostgreSQL connection and retry.') {
    super(message);
    this.name = 'StorageError';
    this.status = 503;
  }
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
  return {
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
module.exports = { getPool, closePool, poolConfig, StorageError };
