<?php
declare(strict_types=1);
require __DIR__.'/../server/service.php';
$checks=0;
function check(bool $condition,string $description):void{global $checks;if(!$condition)throw new RuntimeException('FAIL: '.$description);$checks++;}
function rejects(callable $fn,string $description):void{try{$fn();}catch(Throwable $e){check(true,$description);return;}check(false,$description);}
function card(int $rank,string $suit='S'):array{return ['id'=>tk_id(),'rank'=>$rank,'suit'=>$suit];}
function db():PDO{$db=new PDO('sqlite::memory:');$db->setAttribute(PDO::ATTR_ERRMODE,PDO::ERRMODE_EXCEPTION);$db->exec('CREATE TABLE rooms(code TEXT PRIMARY KEY,state TEXT NOT NULL,updated REAL NOT NULL)');return $db;}
function req(PDO $db,string $action,array $auth=[],array $data=[]):array{return tk_dispatch($db,array_merge($auth,$data,['action'=>$action]));}
function loadGame(PDO $db,string $room):array{$q=$db->prepare('SELECT state FROM rooms WHERE code=?');$q->execute([$room]);return json_decode($q->fetchColumn(),true,512,JSON_THROW_ON_ERROR);}
function fixture(array $settings=['jumpIn'=>true]):array{
 $db=db();$host=req($db,'create',[],array_merge(['nickname'=>'Ada','seat'=>0],$settings));$room=$host['room'];$auth=[['room'=>$room,'token'=>$host['token']]];
 foreach(['Boris','Cora'] as $i=>$name){$r=req($db,'join',['room'=>$room],['nickname'=>$name,'seat'=>$i+1]);$auth[]=['room'=>$room,'token'=>$r['token']];req($db,'ready',$auth[$i+1],['ready'=>true]);}
 req($db,'start',$auth[0]);$g=loadGame($db,$room);$g['deck']=[];$g['pile']=[card(13,'S'),card(13,'H'),card(13,'D')];$g['hole']=[];$g['openingRank']=null;$g['turnId']=$g['players'][0]['id'];$g['botAt']=tk_now()+3600;$g['paused']=false;$g['lastMove']=null;$g['recentCards']=[];
 foreach($g['players'] as &$p){$p['hand']=[card(13,'C'),card(14)];$p['up']=[card(8)];$p['down']=[card(2)];$p['finish']=null;$p['stats']=['pickups'=>0,'burns'=>0];}unset($p);tk_save($db,$g);return [$db,$auth,$g];
}
function ids(array $g):array{$cards=array_merge($g['deck'],$g['pile'],$g['hole']);foreach($g['players'] as $p)$cards=array_merge($cards,$p['hand'],$p['up'],$p['down']);$ids=array_column($cards,'id');sort($ids);return $ids;}
function faces(array $cards):array{return array_map(fn($c)=>['rank'=>$c['rank'],'suit'=>$c['suit']],$cards);}
function row(array $state,string $id):array{foreach($state['scoreboard'] as $r)if($r['id']===$id)return $r;throw new RuntimeException('Missing scoreboard row');}
function jump(PDO $db,array $auth,array $g,int $who=1,string $source='hand',?string $cardId=null,?int $version=null):array{return req($db,'jump',$auth[$who],['source'=>$source,'card'=>$cardId??$g['players'][$who][$source][0]['id'],'version'=>$version??$g['version']]);}
try{
 foreach(['yes',1,null] as $value)rejects(fn()=>tk_settings(['jumpIn'=>$value]),'jump setting accepts boolean only');
 foreach([[],['mode'=>'expanded','maxPlayers'=>9,'decks'=>2]] as $mode){
  [$db,$auth,$g]=fixture(array_merge($mode,['jumpIn'=>true]));$before=ids($g);$candidate=$g['players'][1]['hand'][0];
  $view=req($db,'state',$auth[1])['state'];check($view['settings']['jumpIn']===true,'jump rule exposed in both table modes');
  check($view['jumpCards']===[['id'=>$candidate['id'],'source'=>'hand']],'only eligible own card offered for jump');
  $result=jump($db,$auth,$g)['state'];$after=loadGame($db,$g['room']);
  check($result['pile']===[]&&$result['holeCount']===4,'jump completes four and burns whole pile');
  check($result['turnId']===$g['players'][1]['id'],'jumper steals next turn');
  check($result['players'][1]['stats']['burns']===1&&$before===ids($after),'jump updates stats and conserves every physical card');
  check($result['lastMove']['type']==='jump'&&$result['lastMove']['cards']===[['rank'=>13,'suit'=>'C']],'jump replay records actual completing card');
  check($result['lastMove']['pileBeforeCount']===3&&$result['lastMove']['pileAfterCount']===0&&$result['lastMove']['holeAdded']===4&&$result['lastMove']['extraTurn'],'jump replay preserves burn before/after and extra turn');
  rejects(fn()=>jump($db,$auth,$g,2),'second competing jump with old version rejected');
  check(loadGame($db,$g['room'])['players'][2]['hand'][0]['id']===$g['players'][2]['hand'][0]['id'],'losing jump race consumes no card');
 }
 [$db,$auth,$g]=fixture(['jumpIn'=>false]);check(req($db,'state',$auth[1])['state']['jumpCards']===[],'disabled jump offers no candidates');rejects(fn()=>jump($db,$auth,$g),'disabled jump rejected');
 [$db,$auth,$g]=fixture();$before=$g;rejects(fn()=>jump($db,$auth,$g,1,'hand',null,$g['version']-1),'stale jump rejected even if pile still matches');check(loadGame($db,$g['room'])===$before,'rejected jump transaction rolls back all state');
 rejects(fn()=>jump($db,$auth,$g,0),'current player cannot use out-of-turn jump action');
 rejects(fn()=>jump($db,$auth,$g,1,'hand','not-owned'),'jump cannot use another or nonexistent card');
 rejects(fn()=>req($db,'jump',$auth[1],['source'=>'hand','card'=>[$g['players'][1]['hand'][0]['id']],'version'=>$g['version']]),'jump accepts exactly one physical card');
 $g['players'][1]['hand'][0]=card(10);tk_save($db,$g);rejects(fn()=>jump($db,$auth,$g),'ten cannot act as a wild out-of-turn jump');
 $g['openingRank']=2;tk_save($db,$g);check(tk_jump_cards($g,$g['players'][1]['id'])===[],'jump disabled before mandatory opening');
 [$db,$auth,$g]=fixture();$g['players'][1]['hand']=[];$g['players'][1]['up']=[card(13,'C'),card(7)];tk_save($db,$g);
 check(tk_jump_cards($g,$g['players'][1]['id'])===[['id'=>$g['players'][1]['up'][0]['id'],'source'=>'up']],'face-up jump available only in face-up phase');
 jump($db,$auth,$g,1,'up');check(count(loadGame($db,$g['room'])['players'][1]['up'])===1,'face-up jump consumes only attempted card');
 [$db,$auth,$g]=fixture();$g['players'][1]['hand']=[];$g['players'][1]['up']=[];$g['players'][1]['down']=[card(13,'C')];tk_save($db,$g);
 check(tk_jump_cards($g,$g['players'][1]['id'])===[],'blind cards never offered for jump');rejects(fn()=>jump($db,$auth,$g,1,'down'),'blind jump prohibited');
 [$db,$auth,$g]=fixture();$g['players'][1]['hand']=[];$g['players'][1]['up']=[card(13,'C')];$g['deck']=[card(2)];tk_save($db,$g);rejects(fn()=>jump($db,$auth,$g,1,'up'),'face-up jump prohibited while draw deck remains');
 [$db,$auth,$g]=fixture(['mode'=>'expanded','maxPlayers'=>9,'decks'=>2,'burnRule'=>'all_suits','jumpIn'=>true]);
 $g['pile']=[card(13,'S'),card(13,'S'),card(13,'H'),card(13,'D')];$g['players'][1]['hand'][0]=card(13,'S');tk_save($db,$g);rejects(fn()=>jump($db,$auth,$g),'matching rank with repeated suit cannot jump without missing suit');
 $g['players'][1]['hand'][0]=card(13,'C');tk_save($db,$g);$strict=jump($db,$auth,$g)['state'];check($strict['holeCount']===5&&$strict['lastMove']['burnReason']==='all_suits','strict jump completes all four suits across duplicate run');
 [$db,$auth,$g]=fixture();$g['players'][1]['hand']=[$g['players'][1]['hand'][0]];$g['players'][1]['up']=[];$g['players'][1]['down']=[];tk_save($db,$g);$finished=jump($db,$auth,$g)['state'];check($finished['players'][1]['finish']===1&&$finished['turnId']===$g['players'][2]['id'],'jumper finishing last card passes extra turn clockwise instead');
 check(!$finished['lastMove']['extraTurn']&&!str_contains($finished['lastMove']['text'],'Extra turn!'),'finished jumper replay does not claim an extra turn they cannot take');
 // Pausing freezes human actions, visible jump opportunities, and automatic bot steps.
 [$db,$auth,$g]=fixture();rejects(fn()=>req($db,'pause',$auth[1],['paused'=>true]),'guest cannot pause');rejects(fn()=>req($db,'pause',$auth[0],['paused'=>'yes']),'pause state requires boolean');
 $paused=req($db,'pause',$auth[0],['paused'=>true])['state'];check($paused['paused']&&$paused['jumpCards']===[],'host pause is shared and removes jump opportunity');$pg=loadGame($db,$g['room']);
 rejects(fn()=>req($db,'play',$auth[0],['source'=>'hand','cards'=>[$pg['players'][0]['hand'][0]['id']]]),'paused human play rejected');rejects(fn()=>req($db,'pickup',$auth[0]),'paused pickup rejected');rejects(fn()=>jump($db,$auth,$pg),'paused jump rejected');
 $pg['players'][0]['bot']=true;$snapshot=$pg;check(tk_bot_step($pg)===false&&$pg===$snapshot,'paused bot step cannot mutate game');
 check(req($db,'state',$auth[1])['state']['paused'],'paused guests can still view table');rejects(fn()=>req($db,'pause',$auth[1],['paused'=>false]),'guest cannot resume');
 check(!req($db,'pause',$auth[0],['paused'=>false])['state']['paused'],'host resumes');
 // A paused table remains recoverable when its host leaves.
 [$db,$auth,$g]=fixture();req($db,'pause',$auth[0],['paused'=>true]);req($db,'leave',$auth[0]);
 $successor=req($db,'state',$auth[1])['state'];check($successor['hostId']===$successor['youId']&&$successor['paused'],'host transfer preserves paused state without losing host authority');
 check(!req($db,'pause',$auth[1],['paused'=>false])['state']['paused'],'replacement human host can resume paused round');
 // Enabled bots jump using the same one-card burn rule, including from a human turn.
 [$db,$auth,$g]=fixture();$g['players'][1]['bot']=true;$g['botAt']=0;$id=$g['players'][1]['id'];check(tk_bot_step($g)&&$g['pile']===[]&&$g['turnId']===$id,'bot reacts to eligible jump instead of waiting for own turn');
 // Replay and last-ten history show public faces and survive a cleared pile.
 [$db,$auth,$g]=fixture(['jumpIn'=>false]);$g['pile']=[];$g['recentCards']=[];$g['lastMove']=null;
 foreach($g['players'] as &$p){$p['hand']=[];for($i=0;$i<16;$i++)$p['hand'][]=card(7,['S','H','D','C'][$i%4]);$p['hand'][]=card(14);$p['up']=[];$p['down']=[];}unset($p);
 $played=[];for($i=0;$i<12;$i++){$pi=tk_index($g,$g['turnId']);$c=$g['players'][$pi]['hand'][0];$played[]=$c;tk_play($g,$g['turnId'],'hand',[$c['id']]);}
 $view=tk_view($g,$g['players'][0]['id']);check(count($view['recentCards'])===10&&faces($view['recentCards'])===faces(array_slice($played,-10)),'history retains exactly latest ten played faces chronologically');
 check($g['pile']===[]&&count($view['recentCards'])===10,'burning pile does not erase public card history');check($view['lastMove']['holeAdded']===4&&$view['lastMove']['beforePile']&&$view['lastMove']['afterPile']===[],'burn replay retains pile that disappeared');
 foreach(array_merge($view['recentCards'],$view['lastMove']['cards'],$view['lastMove']['beforePile']) as $c)check(!isset($c['id']),'public replay/history do not need physical card identifiers');
 $pi=tk_index($g,$g['turnId']);tk_play($g,$g['turnId'],'hand',[$g['players'][$pi]['hand'][0]['id']]);$history=$g['recentCards'];tk_pickup($g,$g['turnId']);check($g['recentCards']===$history&&$g['lastMove']['cards']===[]&&$g['lastMove']['type']==='pickup','regular pickup keeps history and reveals no held cards');
 [$db,$auth,$g]=fixture();$g['players'][0]['hand']=[];$g['players'][0]['up']=[];$g['players'][0]['down']=[card(2,'D'),card(14,'H')];$g['pile']=[card(13,'S')];$g['recentCards']=[];tk_play($g,$g['turnId'],'down',[$g['players'][0]['down'][0]['id']]);
 $view=tk_view($g,$g['players'][0]['id']);check(faces($view['lastMove']['cards'])===[['rank'=>2,'suit'=>'D']]&&faces($view['recentCards'])===[['rank'=>2,'suit'=>'D']],'failed blind replay/history reveal only attempted card');check(!str_contains(json_encode($view['lastMove']),'14'),'hidden second blind card absent from replay');
 // Completed rounds are scored once, cumulative stats survive rematches and departures.
 [$db,$auth,$g]=fixture();$g['pile']=[];$g['deck']=[];$g['results']=[];$g['turnId']=$g['players'][0]['id'];
 foreach($g['players'] as $i=>&$p){$p['hand']=[card(2+$i)];$p['up']=[];$p['down']=[];$p['stats']=['burns'=>2-$i,'pickups'=>3+$i];}unset($p);
 $a=$g['players'][0]['id'];$b=$g['players'][1]['id'];$c=$g['players'][2]['id'];tk_play($g,$a,'hand',[$g['players'][0]['hand'][0]['id']]);tk_play($g,$b,'hand',[$g['players'][1]['hand'][0]['id']]);tk_save($db,$g);
 $scored=req($db,'state',$auth[0])['state'];check(row($scored,$a)['wins']===1&&row($scored,$a)['rounds']===1&&row($scored,$c)['lastPlaces']===1,'finishing round scores winner and last place');check(row($scored,$a)['burns']===2&&row($scored,$b)['pickups']===4,'scoreboard aggregates completed-round burn and pickup totals');
 req($db,'state',$auth[0]);check(req($db,'state',$auth[0])['state']['scoreboard']===$scored['scoreboard'],'polling finished table cannot double score round');
 $rematch=req($db,'rematch',$auth[0])['state'];check($rematch['scoreboard']===$scored['scoreboard']&&!$rematch['paused']&&$rematch['lastMove']===null&&$rematch['recentCards']===[],'rematch retains scoreboard but resets playback,history,pause');
 req($db,'leave',$auth[1]);$left=req($db,'state',$auth[0])['state'];check(row($left,$b)['rounds']===1,'departed player remains in session scoreboard');
 $g=loadGame($db,$g['room']);foreach($g['players'] as &$p)$p['ready']=true;unset($p);tk_start($g);$g['deck']=[];$g['openingRank']=null;$g['turnId']=$a;foreach($g['players'] as &$p){$p['hand']=[card(2)];$p['up']=[];$p['down']=[];}unset($p);tk_play($g,$a,'hand',[$g['players'][tk_index($g,$a)]['hand'][0]['id']]);
 $second=tk_view($g,$a);check(row($second,$a)['wins']===2&&row($second,$a)['rounds']===2&&row($second,$b)['rounds']===1,'second round increments participating rows only');
 // Legacy persisted tables acquire safe defaults without inventing historical scores.
 [$db,$auth,$g]=fixture(['jumpIn'=>false]);unset($g['paused'],$g['scoreboard'],$g['lastMove'],$g['recentCards']);tk_save($db,$g);$legacy=req($db,'state',$auth[0])['state'];check(!$legacy['paused']&&$legacy['lastMove']===null&&$legacy['recentCards']===[],'legacy table reads have safe defaults');foreach($legacy['scoreboard'] as $r)check($r['rounds']===0,'legacy reads do not fabricate completed rounds');
 // Complete rounds exercise jump turn-stealing and score aggregation with full decks.
 foreach([['mode'=>'standard','maxPlayers'=>5,'decks'=>1],['mode'=>'expanded','maxPlayers'=>12,'decks'=>3]] as $setup)foreach(['any','all_suits'] as $rule){
  $setup['jumpIn']=true;$setup['burnRule']=$rule;$g=tk_new_game('SIMJP',tk_new_player('Bot0',0,true),$setup);
  for($seat=1;$seat<$setup['maxPlayers'];$seat++)$g['players'][]=tk_new_player('Bot'.$seat,$seat,true);tk_start($g);$original=ids($g);$moves=0;
  while($g['status']==='playing'&&$moves<10000){tk_bot_step($g);check(ids($g)===$original,'jump-enabled bot turn conserves full physical deck');$moves++;}
  check($g['status']==='finished','complete jump-enabled bot round terminates');
  $scores=tk_view($g,$g['players'][0]['id'])['scoreboard'];check(array_sum(array_column($scores,'wins'))===1&&array_sum(array_column($scores,'lastPlaces'))===1,'jump-enabled round records exactly one winner and last place');
 }
 echo 'PASS: '.$checks.' session checks (jump-ins, pause, scoreboard, replay, public history).'.PHP_EOL;
}catch(Throwable $e){fwrite(STDERR,$e->getMessage().PHP_EOL.$e->getTraceAsString().PHP_EOL);exit(1);}
