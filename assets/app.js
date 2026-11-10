'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const store = {get(k){try{return localStorage.getItem('troika.'+k);}catch{return null;}},set(k,v){try{localStorage.setItem('troika.'+k,v);}catch{}},remove(k){try{localStorage.removeItem('troika.'+k);}catch{}}};
  const STANDARD_SETUP = {mode:'standard',maxPlayers:5,decks:1,burnRule:'any'};
  let draftSettings = {...STANDARD_SETUP}, expandedSetup = {mode:'expanded',maxPlayers:9,decks:2,burnRule:'any'};
  const THEMES = [['baltic','Baltic Tavern','#315545'],['midnight','Midnight Club','#323d5b'],['neon','Neon Riga','#754788'],['classic','Sunday Classic','#e5e3d5']];
  let game = null, credentials = null, selected = [], chosenSeat = 0, joinMode = false, lobbyPreview = null;
  let pendingQuickPlay = null;
  let busy = false, polling = false, lastEvent = 0, toastTimer, audio = null, sound = false, pollTimer, previousVersion = -1;
  let draftName = store.get('nickname') || '', draftRoom = (new URLSearchParams(location.search).get('room') || '').toUpperCase().replace(/[^A-Z2-9]/g,'').slice(0,5);
  const rankName = (r) => ({11:'J',12:'Q',13:'K',14:'A'}[r] || String(r));
  const suits = {S:'♠',H:'♥',D:'♦',C:'♣'};
  const arrow = '<svg aria-hidden="true"><use href="#i-arrow"/></svg>';
  const tableSettings = () => game?.settings || (joinMode ? lobbyPreview?.settings || STANDARD_SETUP : draftSettings);
  const capacity = () => tableSettings().maxPlayers;
  const seats = () => Array.from({length:capacity()},(_,i)=>i);
  const allSuits = () => tableSettings().burnRule==='all_suits';
  const setupLabel = () => `${tableSettings().mode==='expanded'?'Expanded':'Standard'} · ${capacity()} seats · ${tableSettings().decks} ${tableSettings().decks===1?'deck':'decks'} · ${allSuits()?'All four suits':'Any four burn'}`;
  const me = () => game?.players.find(p => p.id === game.youId);
  const host = () => game && game.hostId === game.youId;
  const myTurn = () => game?.status === 'playing' && game.turnId === game.youId;
  const currentSource = () => me()?.phase || 'hand';
  const localhost = () => ['localhost','127.0.0.1','[::1]'].includes(location.hostname);
  const initial = name => Array.from(name || '?')[0].toUpperCase();
  const ordinal = n => n + ({1:'st',2:'nd',3:'rd'}[n] || 'th');
  function toast(message, error = false) {
    clearTimeout(toastTimer); const el = $('#toast'); el.textContent = message; el.classList.toggle('error', error); el.hidden = false;
    toastTimer = setTimeout(() => {el.hidden=true;}, error ? 6000 : 3500);
  }
  function setConnection(ok, label) {
    $('#connection').classList.toggle('offline',!ok); $('#connection').innerHTML = '<i></i> ' + esc(label || (ok?'TABLE CONNECTED':'RECONNECTING'));
  }
  function tone(type) {
    if (!sound) return;
    try {
      if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
      audio.resume(); const now = audio.currentTime;
      const notes = type === 'burn' ? [440,660,880] : type === 'turn' ? [523,660] : [290];
      notes.forEach((freq,i) => {const osc=audio.createOscillator(), gain=audio.createGain();osc.type='sine';osc.frequency.value=freq;gain.gain.setValueAtTime(.035,now+i*.08);gain.gain.exponentialRampToValueAtTime(.001,now+i*.08+.17);osc.connect(gain);gain.connect(audio.destination);osc.start(now+i*.08);osc.stop(now+i*.08+.18);});
    } catch { /* Audio is optional. */ }
  }
  async function request(action, data = {}, auth = true) {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch('api.php', {method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',signal:controller.signal,body:JSON.stringify({action,...(auth && credentials ? credentials : {}),...data})});
      let result;
      try {result=await response.json();} catch {throw new Error('PHP is not responding. Open Troika through MAMP (not by double-clicking index.html).');}
      if (!response.ok || result.error) throw new Error(result.error || 'The table could not complete that action.');
      return result;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('The host took too long to respond. Keep this page open to reconnect.');
      if (e instanceof TypeError) throw new Error('Cannot reach the host. Check the local network and MAMP, then retry.');
      throw e;
    } finally {clearTimeout(timeout);}
  }
  function saveCredentials(result) {
    credentials = {room:result.room,token:result.token};
    store.set('seat.'+result.room,JSON.stringify(credentials));store.set('lastRoom',result.room);
    const url=new URL(location.href);url.searchParams.set('room',result.room);history.replaceState(null,'',url);
  }
  function clearCredentials() {
    dismissMatching();
    if(credentials){store.remove('seat.'+credentials.room);if(store.get('lastRoom')===credentials.room)store.remove('lastRoom');}
    credentials=null;game=null;selected=[];lastEvent=0;previousVersion=-1;lobbyPreview=null;draftRoom='';joinMode=false;
    const url=new URL(location.href);url.searchParams.delete('room');history.replaceState(null,'',url);
  }
  function applyState(state) {
    if(!state || (game && game.room===state.room && state.version<game.version)) return;
    const wasTurn=myTurn(), oldStatus=game?.status, oldPhase=currentSource(), wasOffline=$('#connection').classList.contains('offline');
    game=state; setConnection(true);
    if(pendingQuickPlay && (game.room!==pendingQuickPlay.room || game.version!==pendingQuickPlay.version || !myTurn() || currentSource()!=='hand'))dismissMatching();
    if (!myTurn() || oldPhase !== currentSource()) selected=[];
    else {const p=me();const ids=currentSource()==='down'?p.downSlots:(p[currentSource()]||[]).map(c=>c.id);selected=selected.filter(id=>ids.includes(id));}
    const events=game.events || [], newest=events.at(-1)?.id || 0;
    const newEvents=lastEvent?events.filter(e=>e.id>lastEvent):[];
    if(newEvents.some(e=>e.type==='burn')) {
      $('.board-wrap').classList.remove('burn-flash');void $('.board-wrap').offsetWidth;$('.board-wrap').classList.add('burn-flash');tone('burn');
    } else if(!wasTurn && myTurn()) tone('turn');
    else if(newEvents.length) tone('play');
    lastEvent=newest;
    if(previousVersion !== game.version || oldStatus !== game.status){renderGame();previousVersion=game.version;}
    else {renderSeats();renderPlayers();if(wasOffline)renderCenter();}
  }
  async function act(action,data={}) {
    if(busy) return;
    dismissMatching();
    busy=true; document.body.classList.add('busy');
    try {const result=await request(action,data);if(result.state)applyState(result.state);return result;}
    catch(e){toast(e.message,true);}
    finally {busy=false;document.body.classList.remove('busy');}
  }
  async function poll() {
    if(credentials && !busy && !polling) {
      polling=true;
      try {const result=await request('state');if(!busy)applyState(result.state);}
      catch(e){setConnection(false);if(game)$('#turn-banner').textContent='Connection lost. Reconnecting to the host…';if(/seat key|Table not found/.test(e.message)){clearCredentials();renderHome();toast(e.message,true);}}
      finally{polling=false;}
    }
    pollTimer=setTimeout(poll,1000);
  }
  function cardHTML(card,{button=false,small=false,disabled=false,source='',selectedCard=false,canPlay=null}={}) {
    const special=card.rank===6?'special-six':card.rank===10?'special-ten':'';
    const tag=button?'button':'div';
    const classes=['card', ['H','D'].includes(card.suit)?'red':'',special,selectedCard?'selected':'',canPlay===true?'playable':canPlay===false?'unplayable':''].filter(Boolean).join(' ');
    const suit=suits[card.suit],r=rankName(card.rank),name=r+' '+({S:'spades',H:'hearts',D:'diamonds',C:'clubs'}[card.suit]);
    const attrs=button?` type="button" ${source==='hand'?'title="Click to select. Double-click to play this card."':''} data-card="${esc(card.id)}" data-source="${source}" aria-label="${name}${canPlay===false?' — too low':''}" aria-pressed="${selectedCard}" ${disabled?'disabled':''}`:` role="img" aria-label="${name}"`;
    return `<${tag} class="${classes}"${attrs}><span class="corner">${r}<small>${suit}</small></span><span class="pip ${special?'special-pip':''}">${card.rank===6?'↺':card.rank===10?'✧':suit}</span>${special?`<span class="card-detail">${card.rank===6?'RESET':'BURN'}</span>`:''}<span class="corner bottom">${r}<small>${suit}</small></span></${tag}>`;
  }
  function backHTML(id=null,selectable=false,isSelected=false) {
    const tag=selectable?'button':'div';return `<${tag} class="card-back ${isSelected?'selected':''}" ${selectable?`type="button" data-card="${esc(id)}" data-source="down" aria-label="Attempt this face-down card" aria-pressed="${isSelected}"`:'aria-label="Face-down card" role="img"'}><svg aria-hidden="true"><use href="#mark"/></svg></${tag}>`;
  }
  function legal(card) {
    if(game.openingRank !== null) return card.rank===game.openingRank;
    const top=game.pile.at(-1);
    return !top || [6,10].includes(card.rank) || top.rank===6 || card.rank>=top.rank;
  }
  function renderHome() {
    document.body.dataset.gameStatus='home';
    $('#page-label').textContent='The card room';$('#headline').textContent='Your table. Your rules.';
    $('#subtitle').textContent='A little strategy. A little luck. Just don’t be the last one holding cards.';
    $('#table-badge').innerHTML='<span class="live-dot"></span> '+capacity()+' SEATS · '+tableSettings().decks+' '+(tableSettings().decks===1?'DECK':'DECKS');
    $('#room-panel').innerHTML='<div class="room-tag"><small>COME AS YOU ARE</small><div style="font:17px Georgia,serif;line-height:1.5">Good cards.<br>Better company.</div></div>';
    $('#players-panel').innerHTML='';$('#activity').innerHTML='<p class="empty-feed">A fresh deck. A clean table.<br>The rest is up to you.</p>';
    $('#talk-feed').innerHTML='<p class="empty-feed">Join a table to see the cards played.</p>';
    $('#talk-controls').innerHTML='';
    $('#table-center').innerHTML=`<div class="welcome-cards">${cardHTML({id:'a',rank:14,suit:'S'})}${cardHTML({id:'b',rank:10,suit:'D'})}${cardHTML({id:'c',rank:6,suit:'C'})}</div><div class="center-word">There’s a seat for you.</div><div class="center-note">BRING YOUR FRIENDS. LEAVE YOUR CARDS.</div>`;
    $('#turn-banner').textContent='Pick your spot. Make yourself at home.';
    $('#hand-panel').innerHTML='<div class="hand-heading"><strong>THE DEAL</strong><span>3 + 3 + 3</span></div><div class="welcome-hand"><div class="outline-cards"><span></span><span></span><span></span></div><p><strong>Three in your hand. Six on the table.</strong><br>Get rid of every card. Stay out of last place.</p></div>';
    renderEntry();renderSeats();setConnection(true,'LOCAL PLAY');
  }
  function seatButtons() {
    return seats().map(i=>`<button type="button" data-choose-seat="${i}" class="${chosenSeat===i?'chosen':''}" aria-label="Seat ${i+1}" aria-pressed="${chosenSeat===i}" ${lobbyPreview?.players.some(p=>p.seat===i)?'disabled':''}>${i+1}</button>`).join('');
  }
  function renderEntry() {
    const setup=tableSettings();
    const choices=!joinMode?`<label class="field-label">TABLE STYLE</label><div class="mode-picker" role="group" aria-label="Table style"><button type="button" id="mode-standard" data-mode-choice="standard" class="${draftSettings.mode==='standard'?'chosen':''}" aria-pressed="${draftSettings.mode==='standard'}"><strong>Standard</strong><small>5 seats · 1 deck</small></button><button type="button" id="mode-expanded" data-mode-choice="expanded" class="${draftSettings.mode==='expanded'?'chosen':''}" aria-pressed="${draftSettings.mode==='expanded'}"><strong>Expanded</strong><small>9–12 seats · 2–4 decks</small></button></div>${draftSettings.mode==='expanded'?`<div class="expanded-options"><label class="field-label" for="seat-count">TABLE SEATS<select id="seat-count">${[9,10,11,12].map(n=>`<option value="${n}" ${setup.maxPlayers===n?'selected':''}>${n} seats</option>`).join('')}</select></label><label class="field-label" for="deck-count">CARD DECKS<select id="deck-count">${[2,3,4].map(n=>`<option value="${n}" ${setup.decks===n?'selected':''} ${n===2&&setup.maxPlayers===12?'disabled':''}>${n} decks</option>`).join('')}</select></label></div><p class="setup-note" role="status">${setup.maxPlayers===12?'12 seats need at least 3 decks: the deal uses 108 cards.':'Each player gets 9 cards. Choose below whether four-card burns require all suits.'}</p>`:''}`:'<div id="join-settings" class="settings-summary">'+(lobbyPreview?esc(setupLabel()):'Enter a table code to see its settings.')+'</div>';
    $('#control-panel').innerHTML=`<div class="control-card"><div class="eyebrow">${joinMode?'GOOD TO HAVE YOU':'THE NIGHT STARTS HERE'}</div><h2>${joinMode?'Join the table.':'Pull up a chair.'}</h2><p>${joinMode?'Enter your table code, choose a free seat, and settle in.':'Choose your table style, then invite friends or practice with bots.'}</p><form id="entry-form"><label class="field-label" for="nickname">YOUR NICKNAME</label><input id="nickname" name="nickname" placeholder="What should we call you?" maxlength="20" required autocomplete="nickname" value="${esc(draftName)}">${joinMode?`<label class="field-label" for="room-input">TABLE CODE</label><input id="room-input" name="room" placeholder="e.g. A7K9M" value="${esc(draftRoom)}" maxlength="5" minlength="5" required autocapitalize="characters" autocomplete="off" spellcheck="false">`:''}${choices}${!joinMode?`<label class="field-label" for="burn-rule">FOUR-CARD BURN RULE</label><select id="burn-rule" class="secondary"><option value="any" ${draftSettings.burnRule!=='all_suits'?'selected':''}>Suits don’t matter — any four</option><option value="all_suits" ${draftSettings.burnRule==='all_suits'?'selected':''}>Suits matter — need ♠ ♥ ♦ ♣</option></select>`:''}<label class="field-label">CHOOSE YOUR SEAT</label><div id="entry-seat-picker" class="seat-picker" role="group" aria-label="Choose a table seat">${seatButtons()}</div><div id="form-error" class="form-error" role="alert" hidden></div><button class="primary" type="submit">${joinMode?'Join table':'Create a table'} ${arrow}</button>${!joinMode?'<div class="or-line">OR GO SOLO</div><button class="secondary" type="button" id="practice-button">♧ &nbsp; Practice with bots</button>':''}<div class="join-switch">${joinMode?'Starting something new? <button type="button" id="mode-switch">Host a table</button>':'Already have a code? <button type="button" id="mode-switch">Join a table</button>'}</div></form></div>`;
  }
  function seatAttributes(seat) {
    const slot=capacity()>5 && game ? (seat-me().seat+capacity())%capacity() : seat;
    if(capacity()===5)return `data-seat="${seat}" data-slot="${slot}"`;
    const angle=2*Math.PI*slot/capacity();
    return `data-seat="${seat}" data-slot="${slot}" style="--seat-x:${(50-43*Math.sin(angle)).toFixed(3)}%;--seat-y:${(50+40*Math.cos(angle)).toFixed(3)}%"`;
  }
  function renderSeats() {
    $('.four-rule').innerHTML=allSuits()?'<span>4×</span> Same rank, all four suits?<br><strong>♠ ♥ ♦ ♣ · Burn and go again.</strong>':'<span>4×</span> Four of a kind in a row?<br><strong>Any suits · Burn and go again.</strong>';
    document.body.dataset.tableSize=String(capacity());
    $('.board-wrap').classList.toggle('expanded-table',capacity()>5);
    if(!game)$('#table-badge').innerHTML='<span class="live-dot"></span> '+capacity()+' SEATS · '+tableSettings().decks+' '+(tableSettings().decks===1?'DECK':'DECKS');
    const players=game?.players || lobbyPreview?.players || [];
    $('#seats').innerHTML=seats().map(seat=>{
      const p=players.find(p=>p.seat===seat);
      if(!p) return `<div class="seat" ${seatAttributes(seat)}><button class="empty-seat ${!game&&chosenSeat===seat?'chosen':''}" data-seat-click="${seat}" aria-label="${game && host()?'Add bot at':'Choose'} seat ${seat+1}" ${game && (game.status!=='lobby'||!host()&&me()?.seat===seat)?'disabled':''}>+</button><span class="seat-caption">${!game&&chosenSeat===seat?'YOUR SPOT':game&&host()&&game.status==='lobby'?'ADD BOT':'SEAT '+(seat+1)}</span></div>`;
      const self=Boolean(game && p.id===game.youId),active=Boolean(game && p.id===game.turnId);
      let reserves='';
      if(game && game.status!=='lobby') {
        if(p.up.length) reserves=p.up.map(c=>`<span class="reserve-stack">${p.downCount?backHTML():''}${cardHTML(c,{small:true,button:self&&p.phase==='up'&&myTurn(),source:'up',selectedCard:selected.includes(c.id)})}</span>`).join('');
        else reserves=(p.downSlots || []).map(id=>backHTML(id,self&&p.phase==='down'&&myTurn(),selected.includes(id))).join('');
      }
      return `<div class="seat ${active?'active':''} ${self?'is-self':'other'}" ${seatAttributes(seat)}><div class="seat-avatar">${esc(initial(p.name))}</div><div class="seat-name" title="Seat ${seat+1} · ${esc(p.name)}">${esc(p.name)}${self?'<span class="you-label">YOU</span>':''}</div><div class="seat-count">${!game?(p.bot?'BOT':'SEAT '+(seat+1)):game.status==='lobby'?(p.bot?'BOT · READY':p.ready?'READY':'GETTING READY'):p.finish?ordinal(p.finish)+' PLACE':p.handCount+(capacity()>5?' cards':' IN HAND')}</div>${reserves?`<div class="seat-cards">${reserves}</div>`:''}${game?.status==='lobby' && p.bot && host()?`<button class="remove-bot" data-remove-bot="${seat}" aria-label="Remove ${esc(p.name)} bot">×</button>`:''}${game?.status==='playing'&&host()&&!p.bot&&!self&&!p.connected&&p.disconnectedFor>=30?`<button class="replace-bot" data-replace-bot="${seat}">Let a bot take over</button>`:''}</div>`;
    }).join('');
  }
  function renderPlayers() {
    $('#players-panel').innerHTML=`<div class="side-label">AT THE TABLE <span style="float:right">${game.players.length}/${capacity()}</span></div>`+game.players.map(p=>`<div class="player-list-item"><div class="small-avatar">${esc(initial(p.name))}</div><div><strong>${esc(p.name)}${p.id===game.youId?' · You':''}</strong><small>${p.bot?'Practice bot':p.id===game.hostId?'Table host':p.connected?'Connected':'Reconnecting'} · Seat ${p.seat+1}</small></div><span class="ready-check">${p.finish?ordinal(p.finish):game.status==='lobby'&&p.ready?'✓':p.id===game.turnId?'●':''}</span></div>`).join('');
  }
  function renderGame() {
    document.body.dataset.gameStatus=game.status;
    $('#page-label').textContent='Table '+game.room;$('#headline').textContent=game.status==='lobby'?'Good company starts here.':game.status==='finished'?'That’s a wrap.':'A little luck. A little nerve.';
    $('#subtitle').textContent=game.status==='lobby'?'Choose your seats. Invite your friends. Let the cards do the rest.':game.status==='finished'?'The cards have spoken. There’s always another round.':'Play it smart. Burn the pile. Get out before everyone else.';
    $('#table-badge').innerHTML=`<span class="live-dot"></span> ${game.status==='lobby'?capacity()+' SEATS':'ROUND '+game.round} · ${tableSettings().decks} ${tableSettings().decks===1?'DECK':'DECKS'}`;
    $('#room-panel').innerHTML=`<div class="room-tag"><small>YOUR PRIVATE TABLE</small><div><span class="room-code">${esc(game.room)}</span><button class="icon-button" data-copy aria-label="Copy invitation link"><svg><use href="#i-copy"/></svg></button></div><button class="text-button" data-leave>Leave table ↗</button></div>`;
    renderPlayers();renderSeats();renderCenter();renderHand();renderControls();
    const feed=[...game.events].reverse().slice(0,14).map(eventHTML).join('');
    $('#activity').innerHTML=feed;
    $('#talk-feed').innerHTML=feed;
    $('#talk-controls').innerHTML=`<span class="muted">TABLE ${esc(game.room)} · ${esc(setupLabel())}</span><button class="secondary" data-copy>Copy invite link</button><button class="secondary" data-leave>Leave table</button>`;
  }
  function eventHTML(event) {
    // Old saved rounds may have text-only events. Never infer a hidden suit.
    const cards=(Array.isArray(event.cards)?event.cards:[]).filter(card =>
      card && typeof card==='object' && Number.isInteger(card.rank) && card.rank>=2 && card.rank<=14 && typeof card.suit==='string' && Object.hasOwn(suits,card.suit));
    const badges=cards.map(card => {
      const name=rankName(card.rank)+' of '+({S:'spades',H:'hearts',D:'diamonds',C:'clubs'}[card.suit]);
      return `<span class="event-card ${['H','D'].includes(card.suit)?'red':''}" role="listitem" aria-label="${name}"><span class="event-rank">${rankName(card.rank)}</span><span class="event-suit" aria-hidden="true">${suits[card.suit]}</span></span>`;
    }).join('');
    return `<div class="event ${esc(event.type)}"><div class="event-text">${esc(event.text)}</div>${badges?`<div class="event-cards" role="list" aria-label="Cards played or revealed">${badges}</div>`:''}</div>`;
  }
  function renderCenter() {
    if(game.status==='lobby') {
      $('#table-center').innerHTML=`<div class="welcome-cards">${backHTML()}${cardHTML({id:'x',rank:14,suit:'S'})}${cardHTML({id:'y',rank:10,suit:'D'})}</div><div class="center-word">The gang’s getting together.</div><div class="center-note">${game.players.length} OF ${capacity()} SEATS TAKEN · ${game.players.filter(p=>p.ready).length} READY</div>`;
      $('#turn-banner').textContent=host()?'Add a bot at any empty seat, or invite a friend.':'Click an empty seat to change your spot before the deal.';return;
    }
    if(game.status==='finished') {
      const winner=game.players.find(p=>p.id===game.results[0]),last=game.players.find(p=>p.id===game.results.at(-1));
      $('#table-center').innerHTML=`<div class="table-results"><div class="table-status">ROUND COMPLETE</div><div class="center-word">${esc(winner?.name)} takes it.</div><div class="center-note">${esc(last?.name)} IS THE TROIKA THIS TIME.</div><div class="burn-label">✧</div></div>`;
      $('#turn-banner').textContent=host()?'Same seats, fresh cards? Start a rematch.':'Waiting for the host to set up a rematch.';return;
    }
    const top=game.pile.at(-1), active=game.players.find(p=>p.id===game.turnId);
    $('#table-center').innerHTML=`<div class="table-status">${game.openingRank!==null?'LOWEST CARD OPENS · '+rankName(game.openingRank):!top?'OPEN TABLE · ANY RANK':top.rank===6?'RESET · ANY RANK':rankName(top.rank)+' OR HIGHER · 6 OR 10'}</div><div class="game-piles"><div class="pile-group"><div>${game.deckCount?`<div class="deck-stack">${backHTML()}</div>`:'<div class="pile-empty">∅</div>'}</div><span>DECK · ${game.deckCount}</span></div><div class="pile-group"><div>${game.pile.length?game.pile.slice(-3).map(c=>`<div class="pile-card">${cardHTML(c)}</div>`).join(''):'<div class="pile-empty">♧</div>'}</div><span>PILE · ${game.pile.length}</span></div><div class="pile-group hole-group"><div class="hole">✧</div><span>HOLE · ${game.holeCount}</span></div></div>`;
    $('#turn-banner').innerHTML=game.openingRank!==null?`<span style="color:var(--gold)">${esc(active?.name)} opens with ${rankName(game.openingRank)}, the lowest hand card.</span>`:myTurn()?'<span style="color:var(--gold)">Your move. Make it a good one.</span>':`Waiting for ${esc(active?.name)}${active?.bot?' <span class="loading-dots">···</span>':''}`;
  }
  function renderHand() {
    const p=me();if(!p)return;
    if(game.status==='lobby'){$('#hand-panel').innerHTML='<div class="hand-heading"><strong>YOUR HAND</strong><span>WAITING FOR THE DEAL</span></div><div class="locked-hint">No swaps. You play the cards you’re dealt.<br>Get ready when you’re happy with your seat.</div>';return;}
    if(p.finish){$('#hand-panel').innerHTML=`<div class="hand-heading"><strong>${ordinal(p.finish).toUpperCase()} PLACE</strong><span>${game.status==='finished'?'ROUND COMPLETE':'YOU’RE OUT'}</span></div><div class="locked-hint">${p.finish===game.players.length?'The Troika this round. Time for a comeback.':'All clear. Sit back and watch the rest of the table.'}</div>`;return;}
    const phase=p.phase, turn=myTurn(), source=phase==='out'?'hand':phase;
    let cards=source==='down'?p.downSlots.map(id=>backHTML(id,turn,selected.includes(id))).join(''):(p[source]||[]).map(c=>cardHTML(c,{button:true,disabled:!turn,source,selectedCard:selected.includes(c.id),canPlay:turn?legal(c):null})).join('');
    const chosen=source==='down'?null:(p[source]||[]).find(c=>selected.includes(c.id));
    const fails=chosen&&!legal(chosen), label=source==='down'?'Try blind card':source==='up'&&fails?'Attempt & pick up':'Play '+(selected.length>1?selected.length+' cards':'card');
    let hint=!turn?'Waiting for your turn':source==='down'?'Choose one. Trust your luck.':source==='up'?'Play from the table. Too low? Take only the attempted card + pile.':game.openingRank!==null?'You must open with '+rankName(game.openingRank):'Click to select matching cards · Double-click to play a card';
    $('#hand-panel').innerHTML=`<div class="hand-heading"><strong>${source==='hand'?'YOUR HAND':source==='up'?'YOUR FACE-UP CARDS':'YOUR BLIND CARDS'} <span style="color:var(--muted)">· ${source==='hand'?p.handCount:source==='up'?p.up.length:p.downCount}</span></strong><span>${turn?'YOUR TURN':'HOLD TIGHT'}</span></div><div class="hand-area"><div class="hand-cards">${cards}</div><div class="hand-actions"><button class="primary" id="play-button" ${!turn||!selected.length?'disabled':''}>${label} ${arrow}</button>${source==='hand'?`<button class="secondary" id="pickup-button" ${!turn||!game.pile.length||game.openingRank!==null?'disabled':''}>Pick up pile (${game.pile.length})</button>`:''}</div></div><div class="small-note muted" id="hand-hint" aria-live="polite">${hint}</div>`;
  }
  function renderControls() {
    const p=me();if(!p)return;
    if(game.status==='lobby') {
      const allReady=game.players.every(p=>p.ready),count=game.players.length;
      $('#control-panel').innerHTML=`<div class="control-card"><div class="eyebrow">TABLE ${esc(game.room)}</div><h2>${host()?'You’re the host.':'Make yourself at home.'}</h2><p>${host()?'Invite your lab mates, or fill the empty seats with bots.':'Take your seat and get ready. The host will deal when everyone is set.'}</p><div class="status-line"><span>Seats taken</span><strong>${count} / ${capacity()}</strong></div><div class="status-line"><span>Players ready</span><strong>${game.players.filter(p=>p.ready).length} / ${count}</strong></div><div class="settings-summary">${esc(setupLabel())}</div><label class="field-label">YOUR SEAT</label><div class="seat-picker" role="group" aria-label="Change your seat">${seats().map(i=>`<button type="button" data-move-seat="${i}" class="${p.seat===i?'chosen':''}" aria-label="Move to seat ${i+1}" aria-pressed="${p.seat===i}" ${game.players.some(x=>x.seat===i&&x.id!==p.id)?'disabled':''}>${i+1}</button>`).join('')}</div><div class="lobby-actions"><button class="${p.ready?'secondary':'primary'}" id="ready-button">${p.ready?'✓ You’re ready · undo':'I’m ready'} </button>${host()?`<button class="primary" id="start-button" ${count<2||!allReady?'disabled':''}>Deal the cards ${arrow}</button><button class="secondary" id="add-bot-button" ${count>=capacity()?'disabled':''}>+ Add a practice bot</button>`:''}</div><div class="share-box"><button data-copy>Copy invite link ↗</button><span>${localhost()?'Share your private IP instead of localhost.':'Friends join on your local network.'}</span></div><p class="small-note">${count<2?'At least two players needed. Bots count.':!allReady?'Waiting for everyone to be ready.':'Everyone’s ready. Let’s play.'}</p><button class="text-button" data-leave>Leave this table</button></div>`;return;
    }
    if(game.status==='finished') {
      $('#control-panel').innerHTML=`<div class="control-card"><div class="eyebrow">THE FINAL WORD</div><h2>The pecking order.</h2>${game.results.map((id,i)=>{const player=game.players.find(x=>x.id===id);return `<div class="result-row"><span class="result-rank">${i+1}</span><div><strong>${esc(player?.name)}${id===game.youId?' · You':''}</strong><small>${i===game.results.length-1?'THE TROIKA':i===0?'FIRST OUT · NICELY PLAYED':'OUT IN '+ordinal(i+1).toUpperCase()+' PLACE'} · ${player?.stats.burns||0} burns · ${player?.stats.pickups||0} pickups</small></div></div>`;}).join('')}<div class="lobby-actions">${host()?'<button class="primary" id="rematch-button">Same seats. Fresh cards. ↻</button>':'<p>Waiting for the host to start a rematch.</p>'}<button class="secondary" data-leave>Leave table</button></div></div>`;return;
    }
    const phase=p.phase, phases=[['hand','In your hand',p.handCount],['up','Face up',p.up.length],['down','Face down',p.downCount]], current=phases.findIndex(x=>x[0]===phase);
    const turnPlayer=game.players.find(x=>x.id===game.turnId);
    $('#control-panel').innerHTML=`<div class="control-card"><div class="eyebrow">${p.finish?'NICE WORK':myTurn()?'THE TABLE IS YOURS':'KEEP YOUR CARDS CLOSE'}</div><h2>${p.finish?'You’re all clear.':myTurn()?'Make your move.':esc(turnPlayer?.name)+'’s turn.'}</h2><p>${p.finish?'Enjoy the show. You’ve played your last card.':myTurn()?phase==='down'?'One blind card at a time. Fortune favours the brave.':phase==='up'?'Your hand is empty. Time to play the face-up cards.':'Match the pile or go higher. A 6 resets. A 10 burns.':'Watch the pile. Plan your next play.'}</p><div class="stage-list">${phases.map(([id,label,count],i)=>`<div class="stage-item ${id===phase?'current':i<current||p.finish?'done':''}"><span class="stage-number">${i<current||p.finish?'✓':i+1}</span><span>${label}</span><strong style="margin-left:auto;font-size:10px;font-weight:normal">${count}</strong></div>`).join('')}</div><div class="stat-row"><span>Your burns</span><strong>${p.stats.burns}</strong></div><div class="stat-row"><span>Your pickups</span><strong>${p.stats.pickups}</strong></div><p class="small-note">${game.deckCount?'Draw back to three after playing. '+game.deckCount+' cards left in the deck.':'The deck is empty. Every card counts now.'}</p><button class="text-button" data-leave>Leave · a bot takes your seat</button></div>`;
  }
  function selectCard(id,source) {
    if(!myTurn()||busy||source!==currentSource())return;
    if(source==='down'){selected=selected.includes(id)?[]:[id];}
    else {
      const cards=me()[source], card=cards.find(c=>c.id===id);if(!card)return;
      if(source==='hand'&&!legal(card)){toast(game.openingRank!==null?'Open with '+rankName(game.openingRank)+', the lowest hand card.':'Too low. Play an equal or higher card, use a 6 or 10, or pick up the pile.');return;}
      const first=cards.find(c=>selected.includes(c.id));
      if(selected.includes(id))selected=selected.filter(x=>x!==id);
      else if(first&&first.rank===card.rank){if(selected.length===4){toast('Play up to four matching cards per move. A qualifying burn earns another turn.');return;}selected.push(id);}
      else selected=[id];
    }
    if(source==='hand')paintHandSelection();else renderHand();
    renderSeats();
  }
  function paintHandSelection() {
    // Keep card nodes and focus intact between the two native clicks.
    $('#hand-panel').querySelectorAll('[data-card][data-source="hand"]').forEach(button=>{
      const isSelected=selected.includes(button.dataset.card);
      button.classList.toggle('selected',isSelected);
      button.setAttribute('aria-pressed',String(isSelected));
    });
    const button=$('#play-button');
    button.disabled=!myTurn()||!selected.length;
    button.innerHTML='Play '+(selected.length>1?selected.length+' cards':'card')+' '+arrow;
  }
  function dismissMatching() {
    pendingQuickPlay=null;
    if($('#matching-dialog').open)$('#matching-dialog').close();
  }
  async function playCards(source,ids) {
    if(busy || !myTurn() || currentSource()!==source || !ids.length)return;
    const result=await act('play',{source,cards:ids});
    if(result){selected=[];renderHand();renderSeats();}
  }
  async function quickPlayCard(id) {
    if(busy || !myTurn() || currentSource()!=='hand' || $('#matching-dialog').open)return;
    const card=me().hand.find(c=>c.id===id);
    if(!card)return;
    if(!legal(card)){selectCard(id,'hand');return;}
    const matches=me().hand.filter(c=>c.rank===card.rank);
    if(matches.length===1){await playCards('hand',[id]);return;}
    // Four complete a burn; extra copies in Expanded mode stay for another play.
    const group=[card,...matches.filter(c=>c.id!==id)].slice(0,4);
    pendingQuickPlay={room:game.room,version:game.version,cardId:id,rank:card.rank,ids:group.map(c=>c.id)};
    $('#matching-count').textContent='You have '+matches.length+' cards of rank '+rankName(card.rank)+' in your hand. '+(matches.length>4?'Play up to four now. A burn needs the table’s chosen suit rule.':'Play only this card, or play the matching cards together.');
    $('#matching-cards').innerHTML=group.map(c=>cardHTML(c)).join('');
    $('#quick-play-one').textContent='Play only '+rankName(card.rank)+suits[card.suit];
    $('#quick-play-group').textContent=matches.length===2?'Play both':matches.length<=4?'Play all '+matches.length:'Play 4 matching cards';
    $('#matching-dialog').showModal();
  }
  async function confirmQuickPlay(group) {
    const pending=pendingQuickPlay;
    if(!pending)return;
    const ids=group?pending.ids:[pending.cardId];
    const valid=!busy && myTurn() && currentSource()==='hand' && game.room===pending.room && game.version===pending.version && ids.every(id=>me().hand.some(c=>c.id===id && c.rank===pending.rank && legal(c)));
    dismissMatching();
    if(valid)await playCards('hand',ids);
  }
  async function previewLobby() {
    if(!joinMode||draftRoom.length!==5||game)return;
    try {
      const result=await request('lobby',{room:draftRoom},false);
      if(result.lobby.room!==draftRoom || game)return;
      lobbyPreview=result.lobby;
      if(chosenSeat>=capacity())chosenSeat=0;
      if(lobbyPreview.players.some(p=>p.seat===chosenSeat)){const open=seats().find(i=>!lobbyPreview.players.some(p=>p.seat===i));if(open!==undefined)chosenSeat=open;}
      $('#entry-seat-picker').innerHTML=seatButtons();
      $('#join-settings').textContent=setupLabel();
      renderSeats();
      $$('.seat-picker button').forEach(b=>{b.disabled=lobbyPreview.players.some(p=>p.seat===Number(b.dataset.chooseSeat));b.classList.toggle('chosen',chosenSeat===Number(b.dataset.chooseSeat));b.setAttribute('aria-pressed',String(chosenSeat===Number(b.dataset.chooseSeat)));});
    } catch {lobbyPreview=null;renderSeats();}
  }
  const $$ = s => [...document.querySelectorAll(s)];
  async function enter(practice=false) {
    if(busy)return;
    const form=$('#entry-form');if(!form.reportValidity())return;
    draftName=$('#nickname').value.trim();draftRoom=$('#room-input')?.value.trim().toUpperCase()||'';
    if(!draftName){$('#nickname').focus();return;}
    busy=true;document.body.classList.add('busy');
    try {
      const result=await request(joinMode?'join':'create',{nickname:draftName,seat:chosenSeat,...(joinMode?{room:draftRoom}:draftSettings)},false);
      saveCredentials(result);store.set('nickname',draftName);applyState(result.state);
      if(practice) {
        const free=seats().filter(i=>i!==chosenSeat);
        const botSeats=tableSettings().mode==='expanded'?free:[free[0],free[2]||free[1]];
        for(const seat of botSeats) {const result=await request('bot',{seat});applyState(result.state);}
        const result=await request('start');applyState(result.state);toast('You’re playing against '+botSeats.length+' bots. Good luck.');
      } else toast(joinMode?'You’re at the table. Get ready!':'Table’s open. Invite friends or add bots.');
    } catch(e) {
      if(!game){const el=$('#form-error');el.textContent=e.message;el.hidden=false;}else toast(e.message,true);
    } finally {busy=false;document.body.classList.remove('busy');}
  }
  async function copyInvite() {
    if(!game)return; const url=new URL(location.href);url.search='';url.searchParams.set('room',game.room);
    try {if(!navigator.clipboard)throw new Error();await navigator.clipboard.writeText(url.href);toast(localhost()?'Link copied. Replace localhost with your computer’s private IP before sharing.':'Invite link copied. Friends need the same local network.');}
    catch {const dialog=document.createElement('dialog');dialog.className='invite-dialog';dialog.innerHTML=`<div class="dialog-heading"><h2>Your table invite</h2><button class="icon-button" data-close-invite aria-label="Close invite">×</button></div><p class="muted">Copy this link. Replace localhost with your host computer’s private IP when sharing.</p><input readonly aria-label="Invitation link" value="${esc(url.href)}"><p class="muted">Table code: ${esc(game.room)}</p>`;document.body.append(dialog);dialog.addEventListener('close',()=>dialog.remove());dialog.querySelector('[data-close-invite]').onclick=()=>dialog.close();dialog.showModal();dialog.querySelector('input').select();}
  }
  document.addEventListener('submit',e=>{if(e.target.id==='entry-form'){e.preventDefault();enter();}});
  document.addEventListener('input',e=>{
    if(e.target.id==='nickname')draftName=e.target.value;
    if(e.target.id==='room-input'){draftRoom=e.target.value.toUpperCase().replace(/[^A-Z2-9]/g,'').slice(0,5);e.target.value=draftRoom;lobbyPreview=null;if(draftRoom.length===5)previewLobby();}
  });
  document.addEventListener('change',e=>{
    if(e.target.id==='burn-rule' && !game && !joinMode){draftSettings.burnRule=e.target.value;expandedSetup.burnRule=e.target.value;renderEntry();renderSeats();return;}
    if(e.target.id!=='seat-count' && e.target.id!=='deck-count')return;
    if(game || joinMode || draftSettings.mode!=='expanded')return;
    if(e.target.id==='seat-count')draftSettings.maxPlayers=Number(e.target.value);
    else draftSettings.decks=Number(e.target.value);
    if(draftSettings.maxPlayers===12 && draftSettings.decks===2)draftSettings.decks=3;
    expandedSetup={...draftSettings};
    if(chosenSeat>=capacity())chosenSeat=0;
    renderEntry();renderSeats();
  });
  document.addEventListener('click',async e=>{
    const target=e.target.closest('button');if(!target)return;
    if(target.id==='quick-play-one'){await confirmQuickPlay(false);return;}
    if(target.id==='quick-play-group'){await confirmQuickPlay(true);return;}
    if(target.id==='quick-play-cancel'||target.classList.contains('close-matching-dialog')){dismissMatching();return;}
    if(target.id==='talk-toggle'){$('#talk-dialog').showModal();return;}
    if(target.classList.contains('close-talk-dialog')){$('#talk-dialog').close();return;}
    if(target.hasAttribute('data-rules')){$('#rules-dialog').showModal();return;}
    if(target.classList.contains('close-dialog')){$('#rules-dialog').close();return;}
    if(target.id==='theme-toggle'){const menu=$('#theme-menu');menu.hidden=!menu.hidden;target.setAttribute('aria-expanded',String(!menu.hidden));return;}
    if(target.dataset.themeChoice){setTheme(target.dataset.themeChoice);$('#theme-menu').hidden=true;$('#theme-toggle').setAttribute('aria-expanded','false');return;}
    if(target.id==='sound-toggle'){sound=!sound;target.setAttribute('aria-label',sound?'Mute sound':'Enable sound');target.title=sound?'Mute sound':'Enable sound';$('.sound-off').hidden=sound;if(sound)tone('turn');return;}
    if(target.hasAttribute('data-copy')){copyInvite();return;}
    if(target.dataset.modeChoice){
      draftSettings=target.dataset.modeChoice==='expanded'?{...expandedSetup,burnRule:draftSettings.burnRule||'any'}:{...STANDARD_SETUP,burnRule:draftSettings.burnRule||'any'};
      if(chosenSeat>=capacity())chosenSeat=0;
      renderEntry();renderSeats();return;
    }
    if(target.id==='mode-switch'){joinMode=!joinMode;lobbyPreview=null;renderEntry();renderSeats();if(joinMode){$('#room-input').focus();previewLobby();}return;}
    if(target.id==='practice-button'){enter(true);return;}
    if(busy)return;
    if(target.dataset.chooseSeat!==undefined){chosenSeat=Number(target.dataset.chooseSeat);renderEntry();renderSeats();return;}
    if(target.dataset.seatClick!==undefined){const seat=Number(target.dataset.seatClick);if(!game){chosenSeat=seat;renderEntry();renderSeats();}else if(game.status==='lobby'){if(host())await act('bot',{seat});else await act('seat',{seat});}return;}
    if(target.dataset.moveSeat!==undefined){await act('seat',{seat:Number(target.dataset.moveSeat)});return;}
    if(target.dataset.removeBot!==undefined){await act('remove_bot',{seat:Number(target.dataset.removeBot)});return;}
    if(target.dataset.replaceBot!==undefined){await act('replace_bot',{seat:Number(target.dataset.replaceBot)});return;}
    if(target.dataset.card){
      if(target.dataset.source==='hand' && e.detail>1)return;
      selectCard(target.dataset.card,target.dataset.source);return;
    }
    if(target.id==='play-button'){await playCards(currentSource(),[...selected]);return;}
    if(target.id==='pickup-button'){await act('pickup');selected=[];return;}
    if(target.id==='ready-button'){await act('ready',{ready:!me().ready});return;}
    if(target.id==='start-button'){await act('start');return;}
    if(target.id==='add-bot-button'){const seat=seats().find(i=>!game.players.some(p=>p.seat===i));if(seat!==undefined)await act('bot',{seat});return;}
    if(target.id==='rematch-button'){await act('rematch');return;}
    if(target.hasAttribute('data-leave')){const result=await act('leave');if(result?.left){$('#talk-dialog').close();clearCredentials();renderHome();toast('You left the table.');}return;}
  });
  document.addEventListener('dblclick',e=>{
    const card=e.target.closest('#hand-panel button[data-card][data-source="hand"]');
    if(!card || card.disabled)return;
    e.preventDefault();
    quickPlayCard(card.dataset.card);
  });
  $('#matching-dialog').addEventListener('close',()=>{pendingQuickPlay=null;});
  document.addEventListener('click',e=>{if(!e.target.closest('.theme-wrap')){$('#theme-menu').hidden=true;$('#theme-toggle').setAttribute('aria-expanded','false');}});
  $('#rules-dialog').addEventListener('click',e=>{if(e.target===$('#rules-dialog')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();}});
  function setTheme(name) {
    if(!THEMES.some(t=>t[0]===name))name='baltic';
    document.documentElement.dataset.theme=name;store.set('theme',name);
    $('#theme-menu').innerHTML=THEMES.map(([id,label,color])=>`<button data-theme-choice="${id}" class="${id===name?'selected-theme':''}" aria-pressed="${id===name}"><span class="theme-dot" style="background:${color}"></span>${label}${id===name?' ✓':''}</button>`).join('');
  }
  async function init() {
    setTheme(store.get('theme')||'baltic');joinMode=Boolean(draftRoom);renderHome();
    const room=draftRoom||store.get('lastRoom');
    if(room){
      try{const saved=JSON.parse(store.get('seat.'+room)||'null');if(saved?.room===room&&saved.token){credentials=saved;setConnection(true,'REJOINING TABLE');const result=await request('state');applyState(result.state);}}
      catch(e){clearCredentials();renderHome();toast(e.message||'Your previous seat could not be restored.',true);}
    }
    if(!game&&joinMode)previewLobby();
    poll();
  }
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&credentials){clearTimeout(pollTimer);poll();}});
  init();
})();
