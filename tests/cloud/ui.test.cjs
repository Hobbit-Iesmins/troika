'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {randomBytes}=require('node:crypto');const {JSDOM,VirtualConsole}=require('jsdom');
const {Pool}=require('pg');const {createHandler}=require('../../api/game.js');const E=require('../../cloud/engine.js');
const root=path.resolve(__dirname,'../..');const connectionString=process.env.TEST_DATABASE_URL;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(fn){for(let i=0;i<400;i++){if(fn())return;await sleep(10);}assert.fail('Timed out waiting for cloud UI');}
function browser(handler,url='https://troika.example.test/'){
 const errors=[],calls=[],responses=[],timers=new Map();let pending=0,tid=0;
 const vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e));
 const html=fs.readFileSync(path.join(root,'index.html'),'utf8').replace('content="api.php"','content="/api/game"');
 const dom=new JSDOM(html,{url,pretendToBeVisual:true,runScripts:'outside-only',virtualConsole:vc}),w=dom.window;
 w.setTimeout=(fn,ms)=>{const id=++tid;timers.set(id,{fn,ms});return id;};w.clearTimeout=id=>timers.delete(id);
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
 w.fetch=async(endpoint,options)=>{pending++;try{
  assert.equal(endpoint,'/api/game');const body=JSON.parse(options.body);calls.push({endpoint,...body});let text='';
  const req={method:options.method,headers:{'content-type':options.headers['Content-Type']},body};const res={statusCode:200,setHeader(){},end(value){text=value;}};
  await handler(req,res);const result=JSON.parse(text);responses.push(result);return {ok:res.statusCode>=200&&res.statusCode<300,json:async()=>result};
 }finally{pending--;}};
 w.eval(fs.readFileSync(path.join(root,'assets/app.js'),'utf8'));
 const settle=async()=>{await waitFor(()=>pending===0);await new Promise(r=>setImmediate(r));};
 return {w,dom,calls,responses,errors,$:s=>w.document.querySelector(s),$$:s=>[...w.document.querySelectorAll(s)],
  async click(s){const el=w.document.querySelector(s);assert.ok(el,s);el.click();await settle();},
  input(s,value){const el=w.document.querySelector(s);el.value=value;el.dispatchEvent(new w.Event('input',{bubbles:true}));},
  async choose(s,value){const el=w.document.querySelector(s);el.value=String(value);el.dispatchEvent(new w.Event('change',{bubbles:true}));await settle();},
  async submit(){w.document.querySelector('#entry-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await settle();},
  async poll(){const found=[...timers.entries()].find(([,t])=>t.ms===1000);assert.ok(found,'poll scheduled');timers.delete(found[0]);await found[1].fn();await settle();},
  async double(s){const card=w.document.querySelector(s);assert.ok(card,s);card.dispatchEvent(new w.MouseEvent('click',{bubbles:true,detail:1}));assert.equal(w.document.querySelector(s),card);card.dispatchEvent(new w.MouseEvent('click',{bubbles:true,detail:2}));card.dispatchEvent(new w.MouseEvent('dblclick',{bubbles:true,detail:2}));await settle();},
  close(){w.close();},settle};
}
test('cloud browser controls use the real Node handler and PostgreSQL for multiplayer, jumps, pause, replay and scores',{skip:!connectionString},async()=>{
 const schema='troika_ui_'+randomBytes(8).toString('hex'),admin=new Pool({connectionString,max:1});let pool,host,guest;
 try{
  await admin.query('CREATE SCHEMA '+schema);pool=new Pool({connectionString,max:4,options:'-c search_path='+schema});const handler=createHandler({pool});
  host=browser(handler);assert.ok(host.$('#connection').textContent.includes('ONLINE PLAY'));host.input('#nickname','Cloud Host');await host.click('#mode-expanded');await host.choose('#seat-count',9);await host.choose('#deck-count',2);host.$('#jump-in').checked=true;host.$('#jump-in').dispatchEvent(new host.w.Event('change',{bubbles:true}));await host.click('[data-choose-seat="8"]');await host.submit();
  assert.ok(host.$('#page-label').textContent.startsWith('Table '));const room=host.w.localStorage.getItem('troika.lastRoom');assert.ok(room);
  guest=browser(handler,'https://troika.example.test/?room='+room);await guest.settle();assert.equal(guest.$$('#seats .seat').length,9);guest.input('#nickname','Cloud Guest');await guest.click('[data-choose-seat="6"]');await guest.submit();await guest.click('#ready-button');assert.equal(guest.$('#start-button'),null);
  await host.poll();await host.click('#add-bot-button');await host.click('[data-remove-bot="0"]');await host.click('#start-button');assert.equal(host.w.document.body.dataset.gameStatus,'playing');
  const load=async()=>(await pool.query('SELECT state FROM troika_rooms WHERE code=$1',[room])).rows[0].state;
  const save=async(g)=>{E.tk_touch(g,'Cloud test fixture','test');g.botAt=E.tk_now()+3600;await pool.query('UPDATE troika_rooms SET state=$2::jsonb WHERE code=$1',[room,JSON.stringify(g)]);};
  let g=await load();assert.equal(g.deck.length,86);const hp=g.players.find(p=>p.name==='Cloud Host'),gp=g.players.find(p=>p.name==='Cloud Guest');const card=(rank,suit)=>({id:E.tk_id(),rank,suit});
  g.deck=[];g.pile=[card(13,'S'),card(13,'H'),card(13,'D')];g.hole=[];g.openingRank=null;g.turnId=gp.id;hp.hand=[card(13,'C'),card(14,'S')];gp.hand=[card(12,'H'),card(14,'D')];await save(g);await host.poll();
  const king=hp.hand[0].id;assert.ok(!host.$(`#hand-panel [data-card="${king}"]`).disabled);await host.click(`#hand-panel [data-card="${king}"]`);assert.ok(host.$('#play-button').textContent.includes('Jump in'));await host.click('#play-button');g=await load();assert.equal(g.turnId,hp.id);assert.equal(g.pile.length,0);assert.equal(g.hole.length,4);assert.equal(g.lastMove.type,'jump');
  await guest.poll();const guestView=guest.responses.at(-1).state;assert.equal(guestView.players.find(p=>p.id===hp.id).hand,null);assert.ok(!JSON.stringify(guestView).includes(hp.tokenHash));
  await host.click('#pile-inspect');assert.equal(host.$$('#pile-history .history-card').length,1);assert.ok(host.$('#pile-history').textContent.includes('K'));await host.click('#close-pile-history');
  const beforeReplay=host.calls.length;await host.click('#replay-button');assert.ok(host.$('#replay-dialog').open);assert.ok(host.$('#replay-content').textContent.includes('4 sent to the hole'));await host.click('#replay-again');assert.equal(host.calls.length,beforeReplay);await host.click('.close-replay-dialog');
  await host.click('#pause-button');assert.equal((await load()).paused,true);assert.ok(host.$$('#hand-panel [data-card]').every(el=>el.disabled));await guest.poll();assert.equal(guest.$('#pause-button'),null);assert.equal(guest.w.document.body.dataset.paused,'true');await guest.click('#scoreboard-button');assert.ok(guest.$('#scoreboard-dialog').open);await guest.click('.close-scoreboard-dialog');await host.click('#pause-button');assert.equal((await load()).paused,false);
  const ace=hp.hand[1].id;await host.double(`#hand-panel [data-card="${ace}"]`);assert.deepEqual(host.calls.filter(c=>c.action==='play').at(-1).cards,[ace]);
  g=await load();g.deck=[];g.pile=[];g.hole=[];g.openingRank=null;g.results=[];g.turnId=hp.id;for(const p of g.players){p.hand=[card(2,'S')];p.up=[];p.down=[];p.finish=null;}await save(g);await host.poll();await host.click('#hand-panel [data-card]');await host.click('#play-button');assert.equal((await load()).status,'finished');await host.click('#scoreboard-button');const row=host.$$('#scoreboard-content tbody tr').find(tr=>tr.textContent.includes('Cloud Host'));assert.equal(row.children[1].textContent,'1');assert.equal(row.children[2].textContent,'1');await host.click('.close-scoreboard-dialog');await host.click('#rematch-button');assert.equal((await load()).settings.maxPlayers,9);assert.equal(host.w.document.body.dataset.gameStatus,'lobby');assert.equal(host.errors.length,0);assert.equal(guest.errors.length,0);
 }finally{host?.close();guest?.close();if(pool)await pool.end();await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();}
});
