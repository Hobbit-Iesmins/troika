'use strict';
const { getPool: defaultGetPool, StorageError } = require('../cloud/database.js');
const { tk_dispatch } = require('../cloud/service.js');
const { GameError } = require('../cloud/engine.js');
const LIMIT = 16384;
function respond(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}
function decodeJSON(raw) {
  if (raw.length > LIMIT) throw new GameError('This request is too large.', 413);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
  catch { throw new GameError('Send valid JSON.'); }
}
async function readBody(req) {
  const size = req.headers['content-length'];
  if (size !== undefined && (!/^\d+$/.test(String(size)) || Number(size) > LIMIT)) throw new GameError('This request is too large.', 413);
  let body;
  if (Buffer.isBuffer(req.body)) body = decodeJSON(req.body);
  else if (typeof req.body === 'string') body = decodeJSON(Buffer.from(req.body));
  else if (req.body !== undefined) {
    try { if (Buffer.byteLength(JSON.stringify(req.body)) > LIMIT) throw new GameError('This request is too large.', 413); }
    catch (error) { if (error instanceof GameError) throw error; throw new GameError('Send valid JSON.'); }
    body = req.body;
  } else {
    let bytes = 0; const chunks = [];
    for await (const chunk of req) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.length;
      if (bytes > LIMIT) throw new GameError('This request is too large.', 413);
      chunks.push(value);
    }
    body = decodeJSON(Buffer.concat(chunks));
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new GameError('Send a JSON object.');
  return body;
}
function createHandler(options = {}) {
  const getPool = options.getPool || (options.pool ? () => options.pool : defaultGetPool);
  const dispatch = options.dispatch || tk_dispatch;
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); respond(res, 405, { error: 'Use a JSON POST request.' }); return; }
    const contentType = req.headers['content-type'] || '';
    if (!/^application\/json(?:\s*;|\s*$)/i.test(contentType)) { respond(res, 415, { error: 'Send this request as JSON.' }); return; }
    try {
      const body = await readBody(req);
      const result = await dispatch(await getPool(), body);
      respond(res, 200, result);
    } catch (error) {
      if (error instanceof GameError) respond(res, error.status || 400, { error: error.message });
      else if (error instanceof StorageError) { console.error('Troika: database request unavailable.'); respond(res, 503, { error: error.message }); }
      else { console.error('Troika: request could not be processed.'); respond(res, 500, { error: 'The game could not process that action. Try again.' }); }
    }
  };
}
module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.readBody = readBody;
