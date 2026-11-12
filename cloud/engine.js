'use strict';

// Authoritative Troika rules for the Node.js/Vercel runtime. Storage is separate.
const {randomBytes, randomInt} = require('node:crypto');
class GameError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'GameError'; this.status = status; }
}
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const clone = value => structuredClone(value);
const compare = (a, b) => Buffer.compare(Buffer.from(String(a)), Buffer.from(String(b)));
function tk_id() { return randomBytes(12).toString('hex'); }
function tk_now() { return Date.now() / 1000; }
function tk_require(condition, message, status = 400) { if (!condition) throw new GameError(message, status); }
// Public avatars are inert, bounded raster images or short initial badges.
function tk_avatar(value) {
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  if(value.kind==='initial'){
    if(Object.keys(value).some(k=>!['kind','text','color'].includes(k)))return null;
    const text=value.text??'',color=value.color??'gold';
    if(typeof text!=='string'||!text.isWellFormed()||Array.from(text.normalize('NFC')).length>2||/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069<>&]/u.test(text)||!['gold','coral','mint','sky','violet'].includes(color))return null;
    return {kind:'initial',text:text.normalize('NFC'),color};
  }
  if(value.kind!=='image'||Object.keys(value).some(k=>!['kind','dataUrl'].includes(k))||typeof value.dataUrl!=='string'||value.dataUrl.length>24000)return null;
  const match=/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value.dataUrl);if(!match||match[2].length%4)return null;
  const bytes=Buffer.from(match[2],'base64');if(bytes.toString('base64')!==match[2])return null;
  let width=0,height=0;
  if(match[1]==='png'&&bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.toString('ascii',12,16)==='IHDR'){
    width=bytes.readUInt32BE(16);height=bytes.readUInt32BE(20);
  }else if(match[1]==='webp'&&bytes.length>=25&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'){
    const format=bytes.toString('ascii',12,16);
    if(format==='VP8X'&&bytes.length>=30){width=bytes.readUIntLE(24,3)+1;height=bytes.readUIntLE(27,3)+1;}
    else if(format==='VP8L'&&bytes[20]===47){const packed=bytes.readUInt32LE(21);width=(packed&16383)+1;height=((packed>>>14)&16383)+1;}
    else if(format==='VP8 '&&bytes.length>=30&&bytes.subarray(23,26).equals(Buffer.from([157,1,42]))){width=bytes.readUInt16LE(26)&16383;height=bytes.readUInt16LE(28)&16383;}
  }else if(match[1]==='jpeg'&&bytes.length>=4&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255){
    for(let at=2;at+4<=bytes.length;){
      if(bytes[at]!==255)break;while(bytes[at]===255)at++;const marker=bytes[at++];
      if(marker===217||marker===218)break;if(marker===1||(marker>=208&&marker<=215))continue;
      if(at+2>bytes.length)break;const size=bytes.readUInt16BE(at);if(size<2||at+size>bytes.length)break;
      if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)&&size>=7){height=bytes.readUInt16BE(at+3);width=bytes.readUInt16BE(at+5);break;}at+=size;
    }
  }
  return width>0&&height>0&&width<=256&&height<=256?{kind:'image',dataUrl:value.dataUrl}:null;
}
function tk_settings(settings = {}) {
  tk_require(settings !== null && typeof settings === 'object', 'Choose valid table settings.');
  const mode = own(settings, 'mode') ? settings.mode : 'standard';
  tk_require(typeof mode === 'string' && ['standard','expanded'].includes(mode), 'Choose Standard or Expanded mode.');
  const capacity = own(settings, 'maxPlayers') ? settings.maxPlayers : mode === 'standard' ? 5 : 9;
  const decks = own(settings, 'decks') ? settings.decks : mode === 'standard' ? 1 : 2;
  tk_require(Number.isInteger(capacity) && Number.isInteger(decks), 'Choose a whole number of seats and decks.');
  if (mode === 'standard') tk_require(capacity === 5 && decks === 1, 'Standard mode uses five seats and one deck.');
  else {
    tk_require([9,10,11,12].includes(capacity), 'Expanded mode has 9, 10, 11, or 12 seats.');
    tk_require([2,3,4].includes(decks), 'Expanded mode uses two, three, or four decks.');
  }
  tk_require(capacity * 9 <= decks * 52, 'Twelve seats need 108 dealt cards. Choose three or four decks for a twelve-seat table.');
  const rule = settings.burnRule ?? 'any';
  tk_require(typeof rule === 'string' && ['any','all_suits'].includes(rule), 'Choose Any four or All four suits for burns.');
  const jump = own(settings, 'jumpIn') ? settings.jumpIn : false;
  tk_require(typeof jump === 'boolean', 'Choose whether jump-in burns are enabled.');
  return {mode, maxPlayers:capacity, decks, ...(rule === 'any' ? {} : {burnRule:rule}), ...(jump ? {jumpIn:true} : {})};
}
function tk_game_settings(g) { return tk_settings(g.settings ?? {}); }
function tk_new_player(name, seat, bot = false, tokenHash = '') {
  return {id:tk_id(), name, seat, bot, tokenHash, ready:bot, lastSeen:tk_now(), hand:[], up:[], down:[], finish:null, stats:{pickups:0,burns:0}};
}
function tk_new_game(room, host, settings = {}) {
  settings = tk_settings(settings);
  tk_require(Number.isInteger(host.seat) && host.seat >= 0 && host.seat < settings.maxPlayers, 'Choose a seat within this table.');
  host = clone(host); host.ready = true;
  return {room,status:'lobby',settings,hostId:host.id,players:[host],turnId:null,deck:[],pile:[],hole:[],openingRank:null,results:[],events:[],version:1,eventSeq:0,botAt:0,updatedAt:tk_now(),round:0,paused:false,scoreboard:{},scoredRounds:[],lastMove:null,recentCards:[]};
}
function tk_session_init(g) {
  if (!own(g, 'scoreboard')) {
    g.scoreboard = {};
    g.scoredRounds = g.status === 'finished' ? [g.round ?? 0] : [];
  }
  // A PHP empty associative array may arrive as [] in old saved fixtures.
  if (Array.isArray(g.scoreboard)) g.scoreboard = Object.fromEntries(Object.entries(g.scoreboard));
  g.scoredRounds ??= []; g.paused ??= false; g.lastMove ??= null; g.recentCards ??= [];
  for (const p of g.players) {
    const row = g.scoreboard[p.id] ?? {id:p.id,rounds:0,wins:0,lastPlaces:0,burns:0,pickups:0};
    row.name = p.name; row.bot = p.bot; g.scoreboard[p.id] = row;
  }
}
function tk_record_scores(g) {
  tk_session_init(g);
  if (g.status !== 'finished' || g.scoredRounds.includes(g.round)) return;
  for (const p of g.players) {
    const row = g.scoreboard[p.id]; row.rounds++;
    if (p.finish === 1) row.wins++;
    if (p.finish === g.players.length) row.lastPlaces++;
    row.burns += p.stats.burns; row.pickups += p.stats.pickups;
  }
  g.scoredRounds.push(g.round);
}
function tk_faces(cards) { return cards.map(c => ({rank:c.rank,suit:c.suit})); }
function tk_record_move(g, id, before, played, type, reason, extra, holeBefore) {
  tk_session_init(g);
  const event = g.events.at(-1), p = g.players[tk_index(g, id)];
  g.lastMove = {id:event.id,type,playerId:id,playerName:p.name,text:event.text,cards:tk_faces(played),beforePile:tk_faces(before.slice(-10)),afterPile:tk_faces(g.pile.slice(-10)),pileBeforeCount:before.length,pileAfterCount:g.pile.length,holeAdded:g.hole.length-holeBefore,extraTurn:extra,burnReason:reason};
  for (const c of played) g.recentCards.push({rank:c.rank,suit:c.suit,playerName:p.name,moveId:event.id});
  g.recentCards = g.recentCards.slice(-10);
}
function tk_jump_cards(g, id) {
  if (g.status !== 'playing' || g.paused || !tk_game_settings(g).jumpIn || g.turnId === id || g.openingRank !== null || !g.pile.length) return [];
  const p = g.players[tk_index(g,id)], source = tk_phase(p);
  if (!['hand','up'].includes(source) || (source === 'up' && g.deck.length)) return [];
  const top = g.pile.at(-1), settings = tk_game_settings(g);
  if (tk_four_burn(g.pile,settings)) return [];
  return p[source].filter(c => c.rank === top.rank && c.rank !== 10 && tk_four_burn([...g.pile,c],settings)).map(c => ({id:c.id,source}));
}
function tk_jump_in(g, id, source, cardId, version) {
  tk_require(version === g.version, 'The pile changed. Check the table before jumping in.');
  tk_require(tk_jump_cards(g,id).some(c => c.id === cardId && c.source === source), 'Jump in with one card that completes the selected four-card burn rule.');
  tk_play(g,id,source,[cardId],true);
}
function tk_index(g, id) {
  const i = g.players.findIndex(p => p.id === id);
  if (i < 0) throw new GameError('This seat no longer exists. Join the table again.');
  return i;
}
function tk_touch(g, text, type = 'play', playerId = null, cards = []) {
  g.version++; g.updatedAt = tk_now();
  g.events.push({id:++g.eventSeq,text,type,playerId,cards:tk_faces(cards)});
  if (g.events.length > 40) g.events = g.events.slice(-40);
}
function tk_phase(p) {
  if (p.finish !== null) return 'out';
  if (p.hand.length) return 'hand';
  if (p.up.length) return 'up';
  if (p.down.length) return 'down';
  return 'out';
}
function tk_rank_name(rank) { return ({11:'J',12:'Q',13:'K',14:'A'})[rank] ?? String(rank); }
function tk_start(g) {
  tk_require(g.status === 'lobby', 'This table has already started.');
  const settings = tk_game_settings(g);
  tk_require(g.players.length >= 2 && g.players.length <= settings.maxPlayers, `Seat between two and ${settings.maxPlayers} players before dealing.`);
  tk_require(g.players.length * 9 <= settings.decks * 52, 'There are not enough cards to deal nine cards to every player.');
  const seats = new Set();
  for (const p of g.players) {
    tk_require(Number.isInteger(p.seat) && p.seat >= 0 && p.seat < settings.maxPlayers, 'A player is outside this table’s seat range.');
    tk_require(!seats.has(p.seat), 'Each player needs a separate seat.'); seats.add(p.seat);
  }
  g.settings = settings;
  for (const p of g.players) tk_require(p.ready, `${p.name} must be ready before dealing.`);
  g.players.sort((a,b) => a.seat-b.seat);
  const deck = [];
  for (let copy=0;copy<settings.decks;copy++) for (const suit of ['S','H','D','C']) for (let rank=2;rank<=14;rank++) deck.push({id:tk_id(),rank,suit});
  for (let i=deck.length-1;i>0;i--) { const j=randomInt(i+1); [deck[i],deck[j]]=[deck[j],deck[i]]; }
  for (const p of g.players) { p.hand=[];p.up=[];p.down=[];p.finish=null;p.stats={pickups:0,burns:0}; }
  for (const zone of ['down','up','hand']) for (let n=0;n<3;n++) for (const p of g.players) p[zone].push(deck.pop());
  for (const p of g.players) p.dealtDown=clone(p.down);
  let minimum=15,starter=null;
  for (const p of g.players) {
    tk_sort_hand(p);
    for (const c of p.hand) if (c.rank<minimum) { minimum=c.rank;starter=p.id; }
  }
  tk_session_init(g);g.paused=false;g.lastMove=null;g.recentCards=[];
  g.status='playing';g.deck=deck;g.pile=[];g.hole=[];g.openingRank=minimum;g.results=[];g.turnId=starter;g.botAt=tk_now()+0.85;g.round++;
  const p=g.players[tk_index(g,starter)];
  tk_touch(g,`${p.name} opens with the lowest hand card: ${tk_rank_name(minimum)}.`,'deal',starter);
}
function tk_four_burn(pile, settings) {
  if (pile.length<4) return false;
  const rank=pile.at(-1).rank,run=[];
  for (let i=pile.length-1;i>=0;i--) { if (pile[i].rank!==rank) break; run.push(pile[i]); }
  return settings.burnRule === 'all_suits' ? new Set(run.map(c=>c.suit)).size===4 : run.length>=4;
}
function tk_bot_group(cards, rank, g) {
  let group=cards.filter(c=>c.rank===rank);
  if (tk_game_settings(g).burnRule === 'all_suits') {
    const seen=new Set();
    for (let i=g.pile.length-1;i>=0;i--) { const c=g.pile[i];if(c.rank!==rank)break;seen.add(c.suit); }
    const preferred=[],rest=[];
    for(const c of group) { if(!seen.has(c.suit)){preferred.push(c);seen.add(c.suit);}else rest.push(c); }
    group=[...preferred,...rest];
  }
  return group.slice(0,4);
}
function tk_sort_hand(p) { p.hand.sort((a,b)=>a.rank-b.rank||compare(a.suit,b.suit)); }
function tk_can_play(c, pile) {
  if (!pile.length || [6,10].includes(c.rank)) return true;
  const top=pile.at(-1).rank;return top===6||c.rank>=top;
}
function tk_assert_turn(g, id) {
  tk_require(g.status==='playing','There is no round in progress.');
  tk_require(!g.paused,'The host has paused this round.');
  tk_require(g.turnId===id,'Wait for your turn.');
  return tk_index(g,id);
}
function tk_refill(g, i) {
  const p=g.players[i];
  while(p.hand.length<3&&g.deck.length)p.hand.push(g.deck.pop());
  tk_sort_hand(p);
}
function tk_finish_and_advance(g, id, extra=false) {
  const i=tk_index(g,id),p=g.players[i];
  if(!p.hand.length&&!p.up.length&&!p.down.length&&p.finish===null) {
    p.finish=g.results.length+1;g.results.push(id);tk_touch(g,`${p.name} finishes #${p.finish}!`,'finish',id);
  }
  const active=g.players.filter(p=>p.finish===null);
  if(active.length<=1) {
    if(active.length) { const last=active[0];last.finish=g.results.length+1;g.results.push(last.id);tk_touch(g,`${last.name} is the last player holding cards.`,'result',last.id); }
    g.status='finished';g.turnId=null;tk_record_scores(g);return;
  }
  if(extra&&p.finish===null)g.turnId=id;
  else for(let n=1;n<=g.players.length;n++) { const candidate=g.players[(i+n)%g.players.length];if(candidate.finish===null){g.turnId=candidate.id;break;} }
  g.botAt=tk_now()+0.85;
}
function tk_play(g, id, source, ids, jump=false) {
  let i;
  if(jump) {
    tk_require(Array.isArray(ids)&&ids.length===1,'Jump in with one card.');
    tk_require(tk_jump_cards(g,id).some(c=>c.source===source&&c.id===ids[0]),'That card cannot jump in now.');i=tk_index(g,id);
  } else i=tk_assert_turn(g,id);
  const before=g.pile,holeBefore=g.hole.length,p=g.players[i];
  tk_require(['hand','up','down'].includes(source),'Choose cards from your current phase.');
  tk_require(tk_phase(p)===source,'Play your hand first, then face-up cards, then face-down cards.');
  tk_require(source==='hand'||!g.deck.length,'Finish drawing and playing your hand first.');
  tk_require(Array.isArray(ids)&&ids.length>0&&ids.length<=4&&new Set(ids).size===ids.length,'Choose one to four matching cards.');
  tk_require(source!=='down'||ids.length===1,'Reveal only one face-down card at a time.');
  const selected=[];
  for(const cid of ids) { const found=p[source].find(c=>c.id===cid);tk_require(Boolean(found),'That card is no longer available.');selected.push(found); }
  const rank=selected[0].rank;
  for(const c of selected)tk_require(c.rank===rank,'Cards played together must have the same rank.');
  if(g.openingRank!==null)tk_require(rank===g.openingRank,`Open with your lowest hand card: ${tk_rank_name(g.openingRank)}.`);
  const legal=tk_can_play(selected[0],g.pile);
  tk_require(source!=='hand'||legal,'That card is too low. Play an equal or higher card, a 6, or a 10.');
  p[source]=p[source].filter(c=>!ids.includes(c.id));g.openingRank=null;
  const name=p.name;
  if(!legal) {
    const taken=g.pile.length+selected.length;
    p.hand=[...p.hand,...g.pile,...selected];g.pile=[];p.stats.pickups++;tk_sort_hand(p);
    // A failed blind card goes into a private hand, so never publish its face.
    const publicCards=source==='down'?[]:selected;
    const text=source==='down'?`${name} picks up the pile (${taken} cards).`:`${name} reveals ${tk_rank_name(rank)} and picks up ${taken} cards.`;
    tk_touch(g,text,'pickup',id,publicCards);
    tk_record_move(g,id,before,publicCards,'pickup',null,false,holeBefore);tk_finish_and_advance(g,id);return;
  }
  g.pile=[...g.pile,...selected];
  if(source==='hand')tk_refill(g,i);
  const four=tk_four_burn(g.pile,tk_game_settings(g)),burn=rank===10||four;
  if(burn) {
    const burned=g.pile.length;g.hole=[...g.hole,...g.pile];g.pile=[];p.stats.burns++;
    const reason=rank===10?'Ten burns':tk_game_settings(g).burnRule==='all_suits'?'All four suits burn':'Four of a kind burns';
    tk_touch(g,`${name}${jump?' jumps in with ':' plays '}${selected.length} × ${tk_rank_name(rank)}. ${reason} ${burned} cards. Extra turn!`,'burn',id,selected);
  } else tk_touch(g,`${name} plays ${selected.length} × ${tk_rank_name(rank)}${rank===6?'. The pile is reset.':'.'}`,'play',id,selected);
  const reason=burn?(rank===10?'ten':tk_game_settings(g).burnRule==='all_suits'?'all_suits':'four'):null;
  tk_record_move(g,id,before,selected,jump?'jump':burn?'burn':'play',reason,burn,holeBefore);
  tk_finish_and_advance(g,id,burn);
  g.lastMove.extraTurn=burn&&g.status==='playing'&&g.turnId===id;
  if(burn&&!g.lastMove.extraTurn)g.lastMove.text=g.lastMove.text.replace(/ Extra turn!$/,'');
}
function tk_pickup(g, id) {
  const i=tk_assert_turn(g,id),p=g.players[i];
  tk_require(g.openingRank===null,'The first move must be the lowest card.');
  tk_require(g.pile.length>0,'The pile is empty. Play a card.');
  tk_require(tk_phase(p)==='hand','Attempt one of your table cards to pick it up with the pile.');
  const before=g.pile,holeBefore=g.hole.length,count=g.pile.length;
  p.hand=[...p.hand,...g.pile];g.pile=[];p.stats.pickups++;tk_sort_hand(p);
  tk_touch(g,`${p.name} picks up the pile (${count} cards).`,'pickup',id);
  tk_record_move(g,id,before,[],'pickup',null,false,holeBefore);tk_finish_and_advance(g,id);
}
function tk_bot_step(g) {
  if(g.status!=='playing'||g.turnId===null||g.paused)return false;
  if(tk_game_settings(g).jumpIn)for(const bot of g.players)if(bot.bot) {
    const jump=tk_jump_cards(g,bot.id);if(jump.length){tk_jump_in(g,bot.id,jump[0].source,jump[0].id,g.version);return true;}
  }
  const i=tk_index(g,g.turnId),p=g.players[i];if(!p.bot)return false;
  const source=tk_phase(p);
  if(source==='down') { const card=p.down[randomInt(p.down.length)];tk_play(g,p.id,'down',[card.id]);return true; }
  const cards=p[source];
  const legal=cards.filter(c=>(g.openingRank===null||c.rank===g.openingRank)&&tk_can_play(c,g.pile));
  if(!legal.length) {
    if(source==='hand')tk_pickup(g,p.id);
    else { const sorted=[...cards].sort((a,b)=>a.rank-b.rank);tk_play(g,p.id,source,[sorted[0].id]); }
    return true;
  }
  const score=c=> {
    const n=cards.filter(x=>x.rank===c.rank).length;
    const burn=tk_four_burn([...g.pile,...tk_bot_group(cards,c.rank,g)],tk_game_settings(g));
    return(burn?-100:0)+(c.rank===6?20:c.rank===10?25:c.rank)-n*1.5;
  };
  legal.sort((a,b)=>score(a)-score(b));const rank=legal[0].rank;
  tk_play(g,p.id,source,tk_bot_group(cards,rank,g).map(c=>c.id));return true;
}
function tk_view(game, youId) {
  // Mirror PHP array-value behavior: defaults and all public objects are detached.
  const g=clone(game);tk_session_init(g);
  const self=g.players.find(p=>p.id===youId);
  const ownBlindCards=g.status==='finished'&&self?(self.dealtDown??self.down):[];
  const scores=Object.values(g.scoreboard).sort((a,b)=>b.wins-a.wins||a.lastPlaces-b.lastPlaces||compare(a.name,b.name));
  return {room:g.room,status:g.status,settings:tk_game_settings(g),hostId:g.hostId,youId,players:g.players.map(p=>({id:p.id,name:p.name,seat:p.seat,bot:p.bot,ready:p.ready,connected:p.bot||tk_now()-p.lastSeen<25,disconnectedFor:p.bot?0:Math.max(0,Math.trunc(tk_now()-p.lastSeen)),handCount:p.hand.length,hand:p.id===youId?p.hand:null,up:p.up,downCount:p.down.length,downSlots:p.down.map(c=>c.id),finish:p.finish,stats:p.stats,phase:tk_phase(p),...(tk_avatar(p.avatar)?{avatar:tk_avatar(p.avatar)}:{})})),turnId:g.turnId,deckCount:g.deck.length,pile:g.pile,holeCount:g.hole.length,openingRank:g.openingRank,results:g.results,events:g.events,version:g.version,round:g.round,paused:g.paused,jumpCards:tk_jump_cards(g,youId),scoreboard:scores,lastMove:g.lastMove,recentCards:g.recentCards,ownBlindCards};
}

module.exports = {GameError,tk_id,tk_now,tk_require,tk_avatar,tk_settings,tk_game_settings,tk_new_player,tk_new_game,tk_session_init,tk_record_scores,tk_faces,tk_record_move,tk_jump_cards,tk_jump_in,tk_index,tk_touch,tk_phase,tk_rank_name,tk_start,tk_four_burn,tk_bot_group,tk_sort_hand,tk_can_play,tk_assert_turn,tk_refill,tk_finish_and_advance,tk_play,tk_pickup,tk_bot_step,tk_view};
