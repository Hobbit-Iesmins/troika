<?php
declare(strict_types=1);
require __DIR__.'/../server/service.php';
$n=0;
function ok(bool $v,string $label):void{global $n;if(!$v)throw new RuntimeException($label);$n++;}
function c(int $rank,string $suit):array{return ['id'=>tk_id(),'rank'=>$rank,'suit'=>$suit];}
$any=tk_settings();$strict=tk_settings(['mode'=>'expanded','maxPlayers'=>12,'decks'=>3,'burnRule'=>'all_suits']);
$spades=[c(13,'S'),c(13,'S'),c(13,'S'),c(13,'S')];
ok(tk_four_burn($spades,$any),'any four accepts identical suits');
ok(!tk_four_burn($spades,$strict),'all suits rejects four spades');
$run=[c(13,'S'),c(13,'S'),c(13,'H'),c(13,'D'),c(13,'C')];
ok(tk_four_burn($run,$strict),'duplicates in uninterrupted run still allow all four suits');
ok(!tk_four_burn([c(13,'C'),c(12,'D'),c(13,'S'),c(13,'H'),c(13,'D')],$strict),'different rank breaks the suit collection');
foreach(['any','all_suits'] as $rule){
 $a=tk_new_player('A',0,true);$g=tk_new_game('TESTX',$a,['mode'=>'expanded','maxPlayers'=>9,'decks'=>2,'burnRule'=>$rule]);
 $g['players'][]=tk_new_player('B',1,true);$g['players'][]=tk_new_player('C',2,true);tk_start($g);
 $g['deck']=[];$g['openingRank']=null;$g['turnId']=$a['id'];$g['pile']=array_slice($spades,0,3);
 $g['players'][0]['hand']=[c(13,'S'),c(14,'H')];$id=$g['players'][0]['hand'][0]['id'];tk_play($g,$a['id'],'hand',[$id]);
 ok(($g['pile']===[])===($rule==='any'),'real play respects configured burn rule');
 ok(($g['turnId']===$a['id'])===($rule==='any'),'only qualifying burn grants extra turn');
 $g['turnId']=$a['id'];$g['players'][0]['hand']=[c(10,'S'),c(14,'C')];$id=$g['players'][0]['hand'][0]['id'];tk_play($g,$a['id'],'hand',[$id]);
 ok($g['pile']===[]&&$g['turnId']===$a['id'],'ten always burns and grants extra turn');
}
try{tk_settings(['burnRule'=>'invalid']);throw new LogicException('accepted invalid');}catch(RuntimeException $e){ok(true,'invalid rule rejected');}
$db=new PDO('sqlite::memory:');$db->exec('CREATE TABLE rooms(code TEXT PRIMARY KEY,state TEXT NOT NULL,updated REAL NOT NULL)');
$r=tk_dispatch($db,['action'=>'create','nickname'=>'Host','mode'=>'expanded','maxPlayers'=>12,'decks'=>3,'burnRule'=>'all_suits']);$auth=['room'=>$r['room'],'token'=>$r['token']];
ok($r['state']['settings']['burnRule']==='all_suits','creation persists option');
ok(tk_dispatch($db,['action'=>'lobby','room'=>$r['room']])['lobby']['settings']['burnRule']==='all_suits','guests see option');
$g=json_decode($db->query('SELECT state FROM rooms')->fetchColumn(),true);$g['status']='finished';tk_save($db,$g);
ok(tk_dispatch($db,array_merge($auth,['action'=>'rematch']))['state']['settings']['burnRule']==='all_suits','rematch retains option');
foreach([2,3,4] as $decks){
 $g=tk_new_game('BOTXX',tk_new_player('0',0,true),['mode'=>'expanded','maxPlayers'=>9,'decks'=>$decks,'burnRule'=>'all_suits']);
 for($i=1;$i<9;$i++)$g['players'][]=tk_new_player((string)$i,$i,true);tk_start($g);
 for($step=0;$step<10000&&$g['status']==='playing';$step++){
  tk_bot_step($g);$cards=array_merge($g['deck'],$g['pile'],$g['hole']);foreach($g['players'] as $p)$cards=array_merge($cards,$p['hand'],$p['up'],$p['down']);
  ok(count($cards)===52*$decks&&count(array_unique(array_column($cards,'id')))===52*$decks,'all cards conserved in strict-suit bot match');
 }
 ok($g['status']==='finished','strict-suit match completes');
}
echo 'PASS: '.$n.' burn-rule checks and 3 complete strict-suit bot matches.'.PHP_EOL;
