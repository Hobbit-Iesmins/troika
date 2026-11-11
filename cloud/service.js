'use strict';
const { randomBytes, randomInt, createHash, timingSafeEqual } = require('node:crypto');
const E = require('./engine.js');
const { StorageError, storageError } = require('./database.js');
const initialized = new WeakMap();
const SQL_SCHEMA = `CREATE TABLE IF NOT EXISTS troika_rooms (
  code TEXT PRIMARY KEY,
  state JSONB NOT NULL,
  updated TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
)`;
async function query(client, sql, values) {
  try { return await client.query(sql, values); }
  catch (error) { throw storageError(error); }
}
function initDatabase(pool) {
  if (!initialized.has(pool)) {
    const pending = (async () => {
      let client;
      try { client = await pool.connect(); } catch (error) { throw storageError(error); }
      let transaction = false;
      try {
        await query(client, 'BEGIN'); transaction = true;
        await query(client, "SET LOCAL lock_timeout = '5000ms'");
        // Coordinate first-use DDL across separate serverless processes as well as this pool.
        await query(client, 'SELECT pg_advisory_xact_lock(1901176101)');
        await query(client, SQL_SCHEMA);
        await query(client, 'COMMIT'); transaction = false;
      } catch (error) {
        if (transaction) { try { await client.query('ROLLBACK'); } catch {} }
        throw error;
      } finally { client.release(); }
    })().catch(error => { initialized.delete(pool); throw error; });
    initialized.set(pool, pending);
  }
  return initialized.get(pool);
}
function tk_nickname(value) {
  E.tk_require(typeof value === 'string', 'Enter a nickname.');
  const name = value.trim();
  E.tk_require(name.isWellFormed(), 'Use a valid UTF-8 nickname.');
  E.tk_require(!/[\u0000-\u001f\u007f]/u.test(name), 'Remove control characters from your nickname.');
  E.tk_require(Array.from(name).length >= 1 && Array.from(name).length <= 20, 'Use a nickname between 1 and 20 characters.');
  return name;
}
function tk_seat(value, capacity = 5) {
  E.tk_require(Number.isInteger(value) && value >= 0 && value < capacity, `Choose a table seat from 1 to ${capacity}.`);
  return value;
}
function tk_same_name(a, b) { return a.normalize('NFC').toLocaleLowerCase() === b.normalize('NFC').toLocaleLowerCase(); }
function tk_bot_name(game, seat) {
  const names = ['Māra', 'Rihards', 'Laima', 'Jānis', 'Dace', 'Artūrs', 'Elīna', 'Roberts', 'Līga', 'Edgars', 'Zane', 'Mārtiņš'];
  const base = names[seat];
  let name = base, suffix = 1;
  while (game.players.some(player => tk_same_name(player.name, name))) {
    name = base + ' Bot' + (suffix === 1 ? '' : ' ' + suffix);
    suffix++;
  }
  return name;
}
function tk_free_seat(game, seat, ignoreId = null) {
  E.tk_require(!game.players.some(player => player.seat === seat && player.id !== ignoreId), 'Someone has already taken that seat.');
}
function tk_auth(game, token) {
  E.tk_require(typeof token === 'string' && /^[a-f0-9]{48}$/.test(token), 'Your seat key is missing. Rejoin the table.', 401);
  const hash = createHash('sha256').update(token).digest();
  for (const player of game.players) {
    if (!player.bot && typeof player.tokenHash === 'string' && /^[a-f0-9]{64}$/.test(player.tokenHash) && timingSafeEqual(Buffer.from(player.tokenHash, 'hex'), hash)) return player.id;
  }
  throw new E.GameError('Your seat key is no longer valid. Rejoin the table.', 401);
}
function tk_host(game, id) { E.tk_require(game.hostId === id, 'Only the host can do that.', 403); }
function tk_lobby(game) { E.tk_require(game.status === 'lobby', 'Seats can only change before a round starts.'); }
function newToken() { return randomBytes(24).toString('hex'); }
function tokenHash(token) { return createHash('sha256').update(token).digest('hex'); }
function roomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 5 }, () => alphabet[randomInt(alphabet.length)]).join('');
}
async function save(client, game) {
  E.tk_session_init(game);
  await query(client, 'UPDATE troika_rooms SET state=$2::jsonb, updated=CURRENT_TIMESTAMP WHERE code=$1', [game.room, JSON.stringify(game)]);
}
/** Each existing room is locked until its validated action is saved and committed. */
async function tk_dispatch(pool, request) {
  E.tk_require(request && typeof request === 'object' && !Array.isArray(request), 'Send a JSON object.');
  const action = request.action ?? '';
  E.tk_require(typeof action === 'string', 'Choose a valid action.');
  await initDatabase(pool);
  let client;
  try { client = await pool.connect(); } catch (error) { throw storageError(error); }
  let transaction = false;
  try {
    await query(client, 'BEGIN'); transaction = true;
    await query(client, "SET LOCAL lock_timeout = '5000ms'");
    await query(client, "SET LOCAL statement_timeout = '10000ms'");
    if (action === 'create') {
      const settingsInput = {};
      for (const key of ['mode', 'maxPlayers', 'decks', 'burnRule', 'jumpIn']) if (Object.hasOwn(request, key)) settingsInput[key] = request[key];
      const settings = E.tk_settings(settingsInput);
      const name = tk_nickname(request.nickname), seat = tk_seat(request.seat ?? 0, settings.maxPlayers);
      const token = newToken(), player = E.tk_new_player(name, seat, false, tokenHash(token));
      let game;
      for (let attempt = 0; attempt < 20; attempt++) {
        game = E.tk_new_game(roomCode(), player, settings);
        E.tk_touch(game, name + ' opened the table.', 'lobby', player.id);
        E.tk_session_init(game);
        const inserted = await query(client, 'INSERT INTO troika_rooms(code,state,updated) VALUES($1,$2::jsonb,CURRENT_TIMESTAMP) ON CONFLICT(code) DO NOTHING RETURNING code', [game.room, JSON.stringify(game)]);
        if (inserted.rows.length) break;
        game = null;
      }
      if (!game) throw new StorageError('Could not reserve a table code. Please retry.');
      await query(client, "DELETE FROM troika_rooms WHERE updated < CURRENT_TIMESTAMP - INTERVAL '7 days'");
      await query(client, 'COMMIT'); transaction = false;
      return { room: game.room, token, state: E.tk_view(game, player.id) };
    }
    E.tk_require(typeof request.room === 'string', 'Enter a table code.');
    const room = request.room.trim().toUpperCase();
    E.tk_require(/^[A-Z2-9]{5}$/.test(room), 'Enter the five-character table code.');
    const result = await query(client, 'SELECT state FROM troika_rooms WHERE code=$1 FOR UPDATE', [room]);
    E.tk_require(result.rows.length > 0, 'Table not found. Check the code or create a new table.', 404);
    const game = typeof result.rows[0].state === 'string' ? JSON.parse(result.rows[0].state) : result.rows[0].state;
    E.tk_session_init(game);
    game.settings = E.tk_game_settings(game);
    const capacity = game.settings.maxPlayers;
    if (action === 'join') {
      tk_lobby(game); E.tk_require(game.players.length < capacity, 'This table is full.');
      const name = tk_nickname(request.nickname), seat = tk_seat(request.seat, capacity);
      tk_free_seat(game, seat);
      E.tk_require(!game.players.some(player => tk_same_name(player.name, name)), 'That nickname is already seated here.');
      const token = newToken(), player = E.tk_new_player(name, seat, false, tokenHash(token));
      if (game.hostId === null) { game.hostId = player.id; player.ready = true; }
      game.players.push(player);
      E.tk_touch(game, name + ' took seat ' + (seat + 1) + '.', 'lobby', player.id);
      await save(client, game); await query(client, 'COMMIT'); transaction = false;
      return { room, token, state: E.tk_view(game, player.id) };
    }
    if (action === 'lobby') {
      const lobby = { room: game.room, status: game.status, settings: structuredClone(game.settings), players: game.players.map(({ name, seat, bot }) => ({ name, seat, bot })) };
      await query(client, 'COMMIT'); transaction = false;
      return { lobby };
    }
    const id = tk_auth(game, request.token), index = E.tk_index(game, id);
    game.players[index].lastSeen = E.tk_now();
    switch (action) {
      case 'state': break;
      case 'pause':
        tk_host(game, id); E.tk_require(game.status === 'playing', 'Pause is available during a round.');
        E.tk_require(typeof request.paused === 'boolean', 'Choose pause or resume.');
        if (game.paused !== request.paused) {
          game.paused = request.paused; game.botAt = E.tk_now() + 0.85;
          E.tk_touch(game, game.players[index].name + (game.paused ? ' paused the round.' : ' resumed the round.'), 'pause', id);
        }
        break;
      case 'jump':
        E.tk_require(typeof request.source === 'string' && typeof request.card === 'string' && Number.isInteger(request.version), 'Choose a valid jump-in card and table version.');
        E.tk_jump_in(game, id, request.source, request.card, request.version); break;
      case 'seat': {
        tk_lobby(game); const seat = tk_seat(request.seat, capacity); tk_free_seat(game, seat, id);
        game.players[index].seat = seat; game.players[index].ready = id === game.hostId;
        E.tk_touch(game, game.players[index].name + ' moved to seat ' + (seat + 1) + '.', 'lobby', id); break;
      }
      case 'ready':
        tk_lobby(game); E.tk_require(typeof request.ready === 'boolean', 'Choose ready or not ready.');
        game.players[index].ready = request.ready;
        E.tk_touch(game, game.players[index].name + (request.ready ? ' is ready.' : ' is not ready.'), 'lobby', id); break;
      case 'bot': {
        tk_host(game, id); tk_lobby(game); E.tk_require(game.players.length < capacity, 'This table is full.');
        const seat = tk_seat(request.seat, capacity); tk_free_seat(game, seat);
        const name = tk_bot_name(game, seat), bot = E.tk_new_player(name, seat, true);
        game.players.push(bot); E.tk_touch(game, name + ' (bot) joined seat ' + (seat + 1) + '.', 'lobby', bot.id); break;
      }
      case 'remove_bot': {
        tk_host(game, id); tk_lobby(game); const seat = tk_seat(request.seat, capacity);
        const found = game.players.findIndex(player => player.seat === seat);
        E.tk_require(found >= 0, 'That seat is already empty.');
        E.tk_require(game.players[found].bot, 'Only bot seats can be removed.');
        const [removed] = game.players.splice(found, 1); E.tk_touch(game, removed.name + ' left the table.', 'lobby', removed.id); break;
      }
      case 'start': tk_host(game, id); E.tk_start(game); break;
      case 'play':
        E.tk_require(Array.isArray(request.cards) && request.cards.every(card => typeof card === 'string'), 'Choose a card to play.');
        E.tk_require(typeof request.source === 'string', 'Choose a card source.');
        E.tk_play(game, id, request.source, request.cards); break;
      case 'pickup': E.tk_pickup(game, id); break;
      case 'replace_bot': {
        tk_host(game, id); E.tk_require(game.status === 'playing', 'Bot takeover is available during a round.');
        const seat = tk_seat(request.seat, capacity), player = game.players.find(player => player.seat === seat);
        E.tk_require(player, 'Choose an occupied seat.');
        E.tk_require(!player.bot && player.id !== id, 'Choose a disconnected human player.');
        E.tk_require(E.tk_now() - player.lastSeen >= 30, 'Wait 30 seconds after the player disconnects before using a bot.');
        player.bot = true; player.tokenHash = ''; player.ready = true;
        E.tk_touch(game, 'A bot takes over for ' + player.name + '.', 'lobby', player.id); break;
      }
      case 'rematch':
        tk_host(game, id); E.tk_require(game.status === 'finished', 'Finish this round before starting a rematch.');
        game.paused = false; game.lastMove = null; game.recentCards = [];
        game.status = 'lobby'; game.turnId = null; game.deck = []; game.pile = []; game.hole = []; game.openingRank = null; game.results = [];
        for (const player of game.players) { player.hand = []; player.up = []; player.down = []; player.finish = null; player.ready = player.bot || player.id === id; }
        E.tk_touch(game, 'Rematch! Seats stay the same. Get ready for a new deal.', 'lobby', id); break;
      case 'leave': {
        const name = game.players[index].name;
        if (game.status === 'lobby') game.players.splice(index, 1);
        else { game.players[index].bot = true; game.players[index].tokenHash = ''; game.players[index].ready = true; }
        if (game.hostId === id) {
          game.hostId = null;
          const successor = game.players.find(player => !player.bot);
          if (successor) { game.hostId = successor.id; successor.ready = true; }
        }
        E.tk_touch(game, name + ' left' + (game.status === 'lobby' ? '.' : '; a bot takes over.'), 'lobby', id);
        await save(client, game); await query(client, 'COMMIT'); transaction = false;
        return { left: true };
      }
      default: throw new E.GameError('Unknown game action.');
    }
    if (game.status === 'playing' && !game.paused && E.tk_now() >= game.botAt) E.tk_bot_step(game);
    await save(client, game); await query(client, 'COMMIT'); transaction = false;
    return { state: E.tk_view(game, id) };
  } catch (error) {
    if (transaction) { try { await client.query('ROLLBACK'); } catch { /* Keep the original error. */ } }
    throw error;
  } finally { client.release(); }
}
module.exports = { tk_dispatch, initDatabase, SQL_SCHEMA, tk_nickname, tk_seat, tk_same_name, tk_bot_name, tk_free_seat, tk_auth };
