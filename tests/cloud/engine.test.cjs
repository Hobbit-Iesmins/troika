'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const crypto=require('node:crypto');
const {e,card,fixture,ids,faces,play}=require('./fixtures.cjs');

const engineSource=fs.readFileSync(require.resolve('../../cloud/engine.js'),'utf8');
function seededEngine(seed) {
  let state=seed>>>0;
  const nextUint32=()=>{
    let n=state=(state+0x6d2b79f5)>>>0;
    n=Math.imul(n^(n>>>15),n|1);n^=n+Math.imul(n^(n>>>7),n|61);
    return (n^(n>>>14))>>>0;
  };
  const randomInt=(min,max)=>{
    if(max===undefined){max=min;min=0;}
    const range=max-min;
    assert.ok(Number.isSafeInteger(min)&&Number.isSafeInteger(max)&&range>0&&range<=0x100000000);
    const limit=Math.floor(0x100000000/range)*range;
    let n;do{n=nextUint32();}while(n>=limit);
    return min+n%range;
  };
  // Isolate deterministic deals/blind picks without mutating crypto or seeding IDs.
  // Same-realm evaluation preserves object prototypes for strict assertions.
  const engineModule={exports:{}};
  const localRequire=name=>name==='node:crypto'?{...crypto,randomInt}:require(name);
  new Function('require','module','exports',engineSource)(localRequire,engineModule,engineModule.exports);
  return engineModule.exports;
}

test('settings preserve Standard defaults and reject impossible or malformed tables',()=>{
  assert.deepEqual(e.tk_settings(),{mode:'standard',maxPlayers:5,decks:1});
  assert.deepEqual(e.tk_settings({mode:'expanded',maxPlayers:12,decks:4,burnRule:'all_suits',jumpIn:true}),{mode:'expanded',maxPlayers:12,decks:4,burnRule:'all_suits',jumpIn:true});
  for(const settings of [{mode:'x'},{mode:'standard',decks:2},{mode:'expanded',maxPlayers:12,decks:2},{mode:'expanded',maxPlayers:8,decks:2},{jumpIn:'yes'},{maxPlayers:'5'},{burnRule:'x'}])assert.throws(()=>e.tk_settings(settings));
  const g=fixture();delete g.settings;assert.deepEqual(e.tk_game_settings(g),{mode:'standard',maxPlayers:5,decks:1});
});

test('rank comparisons ignore suits, while 6 and 10 keep their special powers',()=>{
  for(let rank=2;rank<=14;rank++)assert.equal(e.tk_can_play(card(rank,'D'),[card(rank,'S')]),true);
  assert.equal(e.tk_can_play(card(12),[card(13)]),false);
  assert.equal(e.tk_can_play(card(14),[card(13)]),true);
  for(const rank of [6,10])assert.equal(e.tk_can_play(card(rank),[card(14)]),true);
  assert.equal(e.tk_can_play(card(2),[card(14),card(6)]),true);
  assert.equal(e.tk_can_play(card(2),[]),true);
});

test('lowest hand card must open, ties use seat order and all players get nine cards',()=>{
  const g=e.tk_new_game('DEALX',e.tk_new_player('Highest seat',4,true));
  g.players.push(e.tk_new_player('Lowest seat',0,true));e.tk_start(g);
  assert.equal(g.deck.length,34);assert.deepEqual(g.players.map(p=>p.seat),[0,4]);
  let min=15,starter;
  for(const p of g.players){assert.equal(p.hand.length,3);assert.equal(p.up.length,3);assert.equal(p.down.length,3);for(const c of p.hand)if(c.rank<min){min=c.rank;starter=p.id;}}
  assert.equal(g.openingRank,min);assert.equal(g.turnId,starter);
  const i=e.tk_index(g,starter),wrong=g.players[i].hand.find(c=>c.rank!==min);
  if(wrong)assert.throws(()=>e.tk_play(g,starter,'hand',[wrong.id]));
  e.tk_play(g,starter,'hand',[g.players[i].hand.find(c=>c.rank===min).id]);assert.equal(g.openingRank,null);
});

test('playing a hand refills to three and locked table cards cannot be used',()=>{
  const g=fixture();g.players[0].hand=[card(5)];g.deck=[card(8),card(9),card(11),card(12)];
  assert.throws(()=>play(g,0,'up'));play(g);
  assert.equal(g.players[0].hand.length,3);assert.equal(g.deck.length,1);assert.equal(g.turnId,g.players[1].id);
});

test('six resets without keeping the turn; ten burns the whole pile and keeps it',()=>{
  let g=fixture();g.pile=[card(14)];g.players[0].hand[0]=card(6);play(g);
  assert.equal(g.pile.at(-1).rank,6);assert.equal(g.turnId,g.players[1].id);assert.equal(g.lastMove.burnReason,null);
  g=fixture();g.pile=[card(14)];g.players[0].hand[0]=card(10,'H');play(g);
  assert.equal(g.pile.length,0);assert.equal(g.hole.length,2);assert.equal(g.turnId,g.players[0].id);assert.equal(g.lastMove.burnReason,'ten');
  assert.deepEqual(g.lastMove.cards,[{rank:10,suit:'H'}]);assert.equal(g.lastMove.extraTurn,true);
});

test('any-four and all-suits burns handle repeated physical copies correctly',()=>{
  const pile=['S','S','S','S'].map(s=>card(13,s));
  assert.equal(e.tk_four_burn(pile,e.tk_settings()),true);
  const strict=e.tk_settings({burnRule:'all_suits'});
  assert.equal(e.tk_four_burn(pile,strict),false);
  assert.equal(e.tk_four_burn(['S','S','H','D','C'].map(s=>card(13,s)),strict),true);
  assert.equal(e.tk_four_burn([card(13,'C'),card(12),card(13,'S'),card(13,'H'),card(13,'D')],strict),false);
  for(const burnRule of ['any','all_suits']){
    const g=fixture({burnRule});g.pile=[card(13,'S'),card(13,'H'),card(13,'D')];g.players[0].hand[0]=card(13,'C');play(g);
    assert.equal(g.pile.length,0);assert.equal(g.hole.length,4);assert.equal(g.players[0].stats.burns,1);
    assert.equal(g.lastMove.burnReason,burnRule==='any'?'four':'all_suits');
  }
});

test('face-up failure takes only attempted cards plus pile; hand must clear before table',()=>{
  const g=fixture();g.players[0].hand=[];g.players[0].up=[card(2,'H'),card(7),card(12)];g.pile=[card(13)];
  const left=g.players[0].up.slice(1);play(g,0,'up');
  assert.deepEqual(g.players[0].up,left);assert.equal(g.players[0].hand.length,2);assert.equal(g.pile.length,0);assert.equal(g.turnId,g.players[1].id);
  assert.deepEqual(g.lastMove.cards,[{rank:2,suit:'H'}]);g.turnId=g.players[0].id;assert.throws(()=>play(g,0,'up'));
});

test('failed blind attempts stay private in events, replay and played-card history',()=>{
  const g=fixture();g.players[0].hand=[];g.players[0].up=[];g.players[0].down=[card(2,'D'),card(14,'H')];g.pile=[card(13)];
  assert.throws(()=>e.tk_play(g,g.players[0].id,'down',g.players[0].down.map(c=>c.id)));
  play(g,0,'down');assert.equal(g.players[0].down.length,1);assert.equal(g.players[0].hand.length,2);
  const view=e.tk_view(g,g.players[1].id),event=view.events.at(-1);
  assert.equal(event.text,`${g.players[0].name} picks up the pile (2 cards).`);
  assert.deepEqual(event.cards,[]);assert.deepEqual(view.lastMove.cards,[]);assert.deepEqual(view.recentCards,[]);
  assert.deepEqual(view.lastMove.beforePile,[{rank:13,suit:'S'}]);assert.deepEqual(view.lastMove.afterPile,[]);
  assert.equal(view.players[0].hand,null);assert.equal(g.players[0].hand.some(c=>c.rank===2&&c.suit==='D'),true);
});

test('successful blind plays publish the card now on the pile',()=>{
  const g=fixture();g.players[0].hand=[];g.players[0].up=[];g.players[0].down=[card(14,'D'),card(2,'H')];g.pile=[card(13)];
  play(g,0,'down');const view=e.tk_view(g,g.players[1].id);
  assert.deepEqual(view.events.at(-1).cards,[{rank:14,suit:'D'}]);
  assert.deepEqual(view.lastMove.cards,[{rank:14,suit:'D'}]);assert.deepEqual(faces(view.recentCards),[{rank:14,suit:'D'}]);
  assert.equal(view.pile.at(-1).rank,14);assert.equal(view.players[0].downCount,1);
});

test('illegal moves and duplicate/unowned IDs are rejected before consuming cards',()=>{
  const g=fixture();g.pile=[card(13)];const before=structuredClone(g);
  assert.throws(()=>play(g));assert.deepEqual(g,before);
  assert.throws(()=>play(g,1));assert.deepEqual(g,before);
  assert.throws(()=>e.tk_play(g,g.players[0].id,'hand',['fake']));assert.deepEqual(g,before);
  assert.throws(()=>e.tk_play(g,g.players[0].id,'hand',[g.players[0].hand[1].id,g.players[0].hand[1].id]));assert.deepEqual(g,before);
});

test('jump-ins require one legal completing visible card, current version, and enabled rule',()=>{
  for(const settings of [{jumpIn:true},{mode:'expanded',maxPlayers:9,decks:2,burnRule:'all_suits',jumpIn:true}]){
    const g=fixture(settings);g.pile=[card(13,'S'),card(13,'H'),card(13,'D')];g.players[1].hand[0]=card(13,'C');
    const id=g.players[1].hand[0].id,original=ids(g),version=g.version;
    assert.deepEqual(e.tk_jump_cards(g,g.players[1].id),[{id,source:'hand'}]);
    assert.throws(()=>e.tk_jump_in(g,g.players[1].id,'hand',id,version-1));
    e.tk_jump_in(g,g.players[1].id,'hand',id,version);
    assert.equal(g.pile.length,0);assert.equal(g.turnId,g.players[1].id);assert.deepEqual(ids(g),original);assert.equal(g.lastMove.type,'jump');
    assert.throws(()=>e.tk_jump_in(g,g.players[2].id,'hand',g.players[2].hand[0].id,version));
  }
  const g=fixture({jumpIn:true,burnRule:'all_suits'});g.pile=[card(13,'S'),card(13,'S'),card(13,'H'),card(13,'D')];g.players[1].hand[0]=card(13,'S');
  assert.deepEqual(e.tk_jump_cards(g,g.players[1].id),[]);g.players[1].hand[0]=card(10);assert.deepEqual(e.tk_jump_cards(g,g.players[1].id),[]);
  g.players[1].hand=[];g.players[1].up=[];g.players[1].down=[card(13,'C')];assert.deepEqual(e.tk_jump_cards(g,g.players[1].id),[]);
});

test('pause freezes regular plays, pickups, jump-ins and bots without state mutation',()=>{
  const g=fixture({jumpIn:true});g.pile=[card(13,'S'),card(13,'H'),card(13,'D')];g.players[1].hand[0]=card(13,'C');g.paused=true;const before=structuredClone(g);
  assert.throws(()=>play(g));assert.throws(()=>e.tk_pickup(g,g.turnId));assert.deepEqual(e.tk_jump_cards(g,g.players[1].id),[]);
  assert.equal(e.tk_bot_step(g),false);assert.deepEqual(g,before);
});

test('public views hide private cards, tokens and deck and are independent deep copies',()=>{
  const g=fixture();const own=g.players[0],other=g.players[1],view=e.tk_view(g,own.id);
  assert.deepEqual(view.players[0].hand,own.hand);assert.equal(view.players[1].hand,null);assert.ok(!('deck' in view));assert.ok(!('hole' in view));
  for(const p of view.players){assert.ok(!('down' in p));assert.ok(!('tokenHash' in p));assert.deepEqual(p.downSlots,g.players.find(q=>q.id===p.id).down.map(c=>c.id));}
  view.players[0].hand[0].rank=99;view.players[1].up[0].rank=99;view.settings.maxPlayers=99;
  assert.equal(own.hand[0].rank,3);assert.equal(other.up[0].rank,7);assert.equal(g.settings.maxPlayers,5);
});

test('public projection detaches every nested public field without mutating a frozen game',()=>{
  const g=fixture(),own=g.players[0],other=g.players[1];
  own.avatar={kind:'initial',text:'AB',color:'mint'};own.accountId='private-account-id';own.tokenHash='private-token-hash';
  g.pile=[card(11,'H')];g.results=[own.id];
  g.events=[{id:1,text:'Ada played',type:'play',playerId:own.id,cards:[{rank:11,suit:'H'}]}];
  g.lastMove={cards:[{rank:11,suit:'H'}],beforePile:[],afterPile:[{rank:11,suit:'H'}]};
  g.recentCards=[{rank:11,suit:'H',playerName:own.name,moveId:1}];
  g.scoreboard[own.id].name='Old cached name';
  const before=structuredClone(g),freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}};freeze(g);
  const view=e.tk_view(g,own.id);
  assert.equal(view.scoreboard.find(row=>row.id===own.id).name,own.name,'scoreboard display names stay current');
  const encoded=JSON.stringify(view);assert.ok(!encoded.includes('private-account-id'));assert.ok(!encoded.includes('private-token-hash'));
  assert.equal(view.players.find(p=>p.id===other.id).hand,null);
  view.players[0].hand[0].rank=99;view.players[1].up[0].rank=99;view.players[1].downSlots.push('changed');
  view.players[0].stats.burns=99;view.players[0].avatar.text='ZZ';view.settings.maxPlayers=99;
  view.pile[0].rank=99;view.results.push('changed');view.events[0].cards[0].rank=99;
  view.lastMove.cards[0].rank=99;view.lastMove.afterPile[0].rank=99;view.recentCards[0].rank=99;
  view.scoreboard.find(row=>row.id===own.id).wins=99;
  assert.deepEqual(g,before,'neither initializing defaults nor mutating the response changes authoritative state');
});

test('legacy view defaults are initialized on a detached shell, including PHP empty scoreboards',()=>{
  for(const legacyScoreboard of ['missing','php-array'])for(const status of ['playing','finished']){
    const g=fixture();g.status=status;
    if(legacyScoreboard==='missing')delete g.scoreboard;else g.scoreboard=[];
    for(const key of ['scoredRounds','paused','lastMove','recentCards'])delete g[key];
    const before=structuredClone(g),view=e.tk_view(g,g.players[0].id);
    assert.equal(view.paused,false);assert.equal(view.lastMove,null);assert.deepEqual(view.recentCards,[]);
    assert.equal(view.scoreboard.length,g.players.length);assert.ok(view.scoreboard.every(row=>row.rounds===0&&row.wins===0));
    assert.deepEqual(g,before,'reading an old saved game must not initialize or score its original state');
  }
});

test('blind deal snapshots stay private until the entire round finishes, then each player sees only their own',()=>{
  const g=fixture(),snapshots=g.players.map(p=>structuredClone(p.dealtDown));
  assert.ok(snapshots.every(cards=>cards.length===3));
  for(const p of g.players){
    assert.deepEqual(e.tk_view(g,p.id).ownBlindCards,[]);
    for(const visible of e.tk_view(g,p.id).players){assert.ok(!('dealtDown' in visible));assert.ok(!('down' in visible));}
  }
  g.players[0].finish=1;g.players[0].down=[];
  assert.deepEqual(e.tk_view(g,g.players[0].id).ownBlindCards,[],'finishing personally does not unlock a peek while others play');
  g.status='finished';g.turnId=null;
  for(let i=0;i<g.players.length;i++)assert.deepEqual(e.tk_view(g,g.players[i].id).ownBlindCards,snapshots[i]);
  const view=e.tk_view(g,g.players[0].id);view.ownBlindCards[0].rank=99;
  assert.deepEqual(g.players[0].dealtDown,snapshots[0],'response mutation cannot change the stored snapshot');
  assert.deepEqual(e.tk_view(g,'unknown-player').ownBlindCards,[]);
});

test('blind archives are independent deal snapshots and are replaced for a new round',()=>{
  const g=e.tk_new_game('DEALX',e.tk_new_player('Ada',0,true));g.players.push(e.tk_new_player('Boris',1,true));e.tk_start(g);
  const p=g.players[0],snapshot=structuredClone(p.down),oldIds=p.dealtDown.map(c=>c.id);
  assert.deepEqual(p.dealtDown,p.down);assert.notEqual(p.dealtDown,p.down);assert.notEqual(p.dealtDown[0],p.down[0]);
  assert.equal(ids(g).length,52,'archive copies do not become live cards');
  p.down[0].rank=99;p.down.pop();assert.deepEqual(p.dealtDown,snapshot);
  g.status='lobby';assert.deepEqual(e.tk_view(g,p.id).ownBlindCards,[]);e.tk_start(g);
  assert.deepEqual(p.dealtDown,p.down);assert.ok(p.dealtDown.every(c=>!oldIds.includes(c.id)));
  assert.deepEqual(e.tk_view(g,p.id).ownBlindCards,[]);
});

test('legacy finished rounds reveal only the requesting player remaining blind cards',()=>{
  const g=fixture();g.status='finished';g.turnId=null;
  for(const p of g.players)delete p.dealtDown;
  for(const p of g.players)assert.deepEqual(e.tk_view(g,p.id).ownBlindCards,p.down);
  g.status='playing';assert.deepEqual(e.tk_view(g,g.players[0].id).ownBlindCards,[]);
});

test('scoreboard records each finished round once and replay clears when a new round starts',()=>{
  const g=fixture();for(const p of g.players){p.hand=[card(2)];p.up=[];p.down=[];p.stats={burns:2,pickups:3};}
  const winner=g.players[0].id;play(g);play(g,1);
  assert.equal(g.status,'finished');const scored=e.tk_view(g,winner).scoreboard;
  assert.equal(scored.reduce((n,r)=>n+r.wins,0),1);assert.equal(scored.reduce((n,r)=>n+r.lastPlaces,0),1);
  for(const row of scored){assert.equal(row.rounds,1);assert.equal(row.burns,2);assert.equal(row.pickups,3);}
  e.tk_record_scores(g);assert.deepEqual(e.tk_view(g,winner).scoreboard,scored);
  g.status='lobby';e.tk_start(g);assert.equal(g.round,2);assert.equal(g.lastMove,null);assert.deepEqual(g.recentCards,[]);assert.deepEqual(e.tk_view(g,winner).scoreboard,scored);
});

test('recent ten and replay retain public card faces after burns and regular pickups',()=>{
  const g=fixture();for(const p of g.players){p.hand=Array.from({length:16},(_,i)=>card(7,['S','H','D','C'][i%4]));p.hand.push(card(14));p.up=[];p.down=[];}
  const played=[];for(let i=0;i<12;i++){const p=g.players[e.tk_index(g,g.turnId)];const c=p.hand[0];played.push(c);e.tk_play(g,p.id,'hand',[c.id]);}
  assert.equal(g.pile.length,0);assert.deepEqual(faces(g.recentCards),faces(played.slice(-10)));assert.equal(g.lastMove.holeAdded,4);assert.equal(g.lastMove.beforePile.length,3);assert.deepEqual(g.lastMove.afterPile,[]);
  for(const c of [...g.recentCards,...g.lastMove.cards,...g.lastMove.beforePile])assert.ok(!('id' in c));
  const p=g.players[e.tk_index(g,g.turnId)];e.tk_play(g,p.id,'hand',[p.hand[0].id]);const history=structuredClone(g.recentCards);e.tk_pickup(g,g.turnId);
  assert.deepEqual(g.recentCards,history);assert.deepEqual(g.lastMove.cards,[]);assert.equal(g.lastMove.type,'pickup');
});

for(const [count,decks] of [[5,1],[9,2],[11,2],[12,3],[12,4]])for(const burnRule of ['any','all_suits'])for(const jumpIn of [false,true]){
  // Seed 42 is a terminating fixture for each of these 20 rule/table combinations.
  const seed=42;
  test(`complete ${count}-player ${decks}-deck bot match (${burnRule}, jump=${jumpIn}, seed=${seed}) conserves cards`,()=>{
    const matchEngine=seededEngine(seed);
    const settings=count===5?{burnRule,jumpIn}:{mode:'expanded',maxPlayers:count,decks,burnRule,jumpIn};
    const g=matchEngine.tk_new_game('MATCH',matchEngine.tk_new_player('Bot 0',0,true),settings);
    for(let i=1;i<count;i++)g.players.push(matchEngine.tk_new_player('Bot '+i,i,true));matchEngine.tk_start(g);
    const original=ids(g);assert.equal(original.length,52*decks);assert.equal(new Set(original).size,52*decks);
    let step=0;while(g.status==='playing'&&step<10000){assert.equal(matchEngine.tk_bot_step(g),true);assert.deepEqual(ids(g),original);step++;}
    assert.equal(g.status,'finished');assert.equal(g.results.length,count);assert.equal(new Set(g.results).size,count);
    const score=matchEngine.tk_view(g,g.players[0].id).scoreboard;assert.equal(score.reduce((sum,r)=>sum+r.wins,0),1);assert.equal(score.reduce((sum,r)=>sum+r.lastPlaces,0),1);
  });
}

test('fresh-random bot simulation preserves cards and valid turns for up to 500 moves',()=>{
  // Greedy bots can revisit game states; termination is covered by seeded fixtures.
  const g=e.tk_new_game('RANDOM',e.tk_new_player('Bot 0',0,true),{mode:'expanded',maxPlayers:12,decks:4,burnRule:'all_suits',jumpIn:true});
  for(let i=1;i<12;i++)g.players.push(e.tk_new_player('Bot '+i,i,true));e.tk_start(g);
  const original=ids(g);assert.equal(original.length,208);assert.equal(new Set(original).size,208);
  for(let step=0;step<500&&g.status==='playing';step++){
    assert.equal(e.tk_bot_step(g),true);assert.deepEqual(ids(g),original);
    assert.ok(['playing','finished'].includes(g.status));
    assert.equal(new Set(g.results).size,g.results.length);
    assert.ok(g.results.every(id=>g.players.some(p=>p.id===id)));
    for(const p of g.players){
      assert.ok(p.up.length<=3&&p.down.length<=3);
      if(p.finish!==null){
        assert.equal(p.finish,g.results.indexOf(p.id)+1);
        // The final player receives last place while still holding cards.
        if(p.finish<g.players.length)assert.equal(p.hand.length+p.up.length+p.down.length,0);
        else assert.equal(g.status,'finished');
      }else assert.ok(!g.results.includes(p.id));
    }
    if(g.status==='playing'){
      const active=g.players.find(p=>p.id===g.turnId);assert.ok(active);assert.equal(active.finish,null);
      assert.notEqual(e.tk_phase(active),'out');
    }else{
      assert.equal(g.results.length,g.players.length);assert.equal(g.turnId,null);
      const score=e.tk_view(g,g.players[0].id).scoreboard;
      assert.equal(score.reduce((sum,r)=>sum+r.wins,0),1);assert.equal(score.reduce((sum,r)=>sum+r.lastPlaces,0),1);
    }
  }
});
