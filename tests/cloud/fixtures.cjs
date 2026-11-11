'use strict';
const e = require('../../cloud/engine.js');
const card = (rank, suit = 'S') => ({id:e.tk_id(), rank, suit});
function fixture(settings = {}, count = 3) {
  const g = e.tk_new_game('TESTX', e.tk_new_player('Ada', 0, true), settings);
  for(let i=1;i<count;i++) g.players.push(e.tk_new_player('Player '+i, i, true));
  e.tk_start(g);
  g.deck=[];g.pile=[];g.hole=[];g.openingRank=null;g.results=[];g.turnId=g.players[0].id;g.botAt=e.tk_now()+3600;g.paused=false;
  for(const p of g.players){p.hand=[card(3),card(14)];p.up=[card(7)];p.down=[card(2)];p.finish=null;p.stats={burns:0,pickups:0};}
  return g;
}
function allCards(g){return [...g.deck,...g.pile,...g.hole,...g.players.flatMap(p=>[...p.hand,...p.up,...p.down])];}
const ids = g => allCards(g).map(c=>c.id).sort();
const faces = cards => cards.map(({rank,suit})=>({rank,suit}));
const play = (g,player=0,source='hand',index=0) => e.tk_play(g,g.players[player].id,source,[g.players[player][source][index].id]);
module.exports={e,card,fixture,allCards,ids,faces,play};
