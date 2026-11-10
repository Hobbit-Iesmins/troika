<?php
/** Troika's authoritative game rules. No database or network dependencies. */
declare(strict_types=1);

function tk_id(): string { return bin2hex(random_bytes(12)); }
function tk_now(): float { return microtime(true); }
function tk_require(bool $condition, string $message): void { if (!$condition) throw new RuntimeException($message); }
function tk_new_player(string $name, int $seat, bool $bot = false, string $tokenHash = ''): array {
    return ['id'=>tk_id(), 'name'=>$name, 'seat'=>$seat, 'bot'=>$bot, 'tokenHash'=>$tokenHash,
        'ready'=>$bot, 'lastSeen'=>tk_now(), 'hand'=>[], 'up'=>[], 'down'=>[], 'finish'=>null,
        'stats'=>['pickups'=>0,'burns'=>0]];
}
function tk_new_game(string $room, array $host): array {
    $host['ready'] = true;
    return ['room'=>$room,'status'=>'lobby','hostId'=>$host['id'],'players'=>[$host], 'turnId'=>null,
        'deck'=>[], 'pile'=>[], 'hole'=>[], 'openingRank'=>null,'results'=>[], 'events'=>[],
        'version'=>1,'eventSeq'=>0,'botAt'=>0,'updatedAt'=>tk_now(),'round'=>0];
}
function tk_index(array $g, string $id): int {
    foreach ($g['players'] as $i=>$p) if ($p['id']===$id) return $i;
    throw new RuntimeException('This seat no longer exists. Join the table again.');
}
function tk_touch(array &$g, string $text, string $type='play', ?string $playerId=null): void {
    $g['version']++; $g['updatedAt']=tk_now();
    $g['events'][]=['id'=>++$g['eventSeq'],'text'=>$text,'type'=>$type,'playerId'=>$playerId];
    if (count($g['events'])>40) $g['events']=array_slice($g['events'],-40);
}
function tk_phase(array $p): string {
    if ($p['finish']!==null) return 'out';
    if (count($p['hand'])) return 'hand';
    if (count($p['up'])) return 'up';
    if (count($p['down'])) return 'down';
    return 'out';
}
function tk_rank_name(int $rank): string { return [11=>'J',12=>'Q',13=>'K',14=>'A'][$rank] ?? (string)$rank; }
function tk_start(array &$g): void {
    tk_require($g['status']==='lobby', 'This table has already started.');
    tk_require(count($g['players'])>=2 && count($g['players'])<=5,'Seat at least two players before dealing.');
    foreach ($g['players'] as $p) tk_require($p['ready'], $p['name'].' must be ready before dealing.');
    usort($g['players'], fn($a,$b)=>$a['seat']<=>$b['seat']);
    $deck=[];
    foreach (['S','H','D','C'] as $s) for ($r=2;$r<=14;$r++) $deck[]=['id'=>tk_id(),'rank'=>$r,'suit'=>$s];
    // Fisher-Yates with the OS random source.
    for ($i=count($deck)-1;$i>0;$i--) { $j=random_int(0,$i); [$deck[$i],$deck[$j]]=[$deck[$j],$deck[$i]]; }
    foreach ($g['players'] as &$p) {
        $p['hand']=[]; $p['up']=[]; $p['down']=[]; $p['finish']=null; $p['stats']=['pickups'=>0,'burns'=>0];
    } unset($p);
    foreach (['down','up','hand'] as $zone) for($n=0;$n<3;$n++) foreach ($g['players'] as &$p) $p[$zone][]=array_pop($deck);
    unset($p);
    $minimum=15; $starter=null;
    foreach ($g['players'] as &$p) {
        tk_sort_hand($p);
        foreach ($p['hand'] as $c) if ($c['rank']<$minimum) { $minimum=$c['rank']; $starter=$p['id']; }
    } unset($p);
    $g['status']='playing'; $g['deck']=$deck; $g['pile']=[]; $g['hole']=[]; $g['openingRank']=$minimum;
    $g['results']=[]; $g['turnId']=$starter; $g['botAt']=tk_now()+0.85; $g['round']++;
    $p=$g['players'][tk_index($g,$starter)];
    tk_touch($g,$p['name'].' opens with the lowest hand card: '.tk_rank_name($minimum).'.','deal',$starter);
}
function tk_sort_hand(array &$p): void { usort($p['hand'],fn($a,$b)=>($a['rank']<=>$b['rank']) ?: strcmp($a['suit'],$b['suit'])); }
function tk_can_play(array $c, array $pile): bool {
    if (!$pile || in_array($c['rank'],[6,10],true)) return true;
    $top=$pile[count($pile)-1]['rank'];
    return $top===6 || $c['rank']>=$top;
}
function tk_assert_turn(array $g, string $id): int {
    tk_require($g['status']==='playing','There is no round in progress.');
    tk_require($g['turnId']===$id,'Wait for your turn.');
    return tk_index($g,$id);
}
function tk_refill(array &$g, int $i): void {
    while (count($g['players'][$i]['hand'])<3 && count($g['deck'])) $g['players'][$i]['hand'][]=array_pop($g['deck']);
    tk_sort_hand($g['players'][$i]);
}
function tk_finish_and_advance(array &$g, string $id, bool $extra=false): void {
    $i=tk_index($g,$id); $p=&$g['players'][$i];
    if (!$p['hand'] && !$p['up'] && !$p['down'] && $p['finish']===null) {
        $p['finish']=count($g['results'])+1; $g['results'][]=$id;
        tk_touch($g,$p['name'].' finishes #'.$p['finish'].'!','finish',$id);
    }
    unset($p);
    $active=array_values(array_filter($g['players'],fn($p)=>$p['finish']===null));
    if (count($active)<=1) {
        if ($active) {
            $last=$active[0]['id']; $li=tk_index($g,$last);
            $g['players'][$li]['finish']=count($g['results'])+1; $g['results'][]=$last;
            tk_touch($g,$g['players'][$li]['name'].' is the last player holding cards.','result',$last);
        }
        $g['status']='finished'; $g['turnId']=null; return;
    }
    if ($extra && $g['players'][$i]['finish']===null) $g['turnId']=$id;
    else {
        for ($n=1;$n<=count($g['players']);$n++) {
            $ni=($i+$n)%count($g['players']);
            if ($g['players'][$ni]['finish']===null) { $g['turnId']=$g['players'][$ni]['id']; break; }
        }
    }
    $g['botAt']=tk_now()+0.85;
}
function tk_play(array &$g, string $id, string $source, array $ids): void {
    $i=tk_assert_turn($g,$id); $p=&$g['players'][$i];
    tk_require(in_array($source,['hand','up','down'],true),'Choose cards from your current phase.');
    tk_require(tk_phase($p)===$source,'Play your hand first, then face-up cards, then face-down cards.');
    tk_require($source==='hand' || !$g['deck'],'Finish drawing and playing your hand first.');
    tk_require(count($ids)>0 && count($ids)<=4 && count(array_unique($ids))===count($ids),'Choose one or more matching cards.');
    tk_require($source!=='down' || count($ids)===1,'Reveal only one face-down card at a time.');
    $selected=[];
    foreach ($ids as $cid) {
        $found=null;
        foreach ($p[$source] as $c) if ($c['id']===$cid) { $found=$c; break; }
        tk_require($found!==null,'That card is no longer available.'); $selected[]=$found;
    }
    $rank=$selected[0]['rank'];
    foreach($selected as $c) tk_require($c['rank']===$rank,'Cards played together must have the same rank.');
    if ($g['openingRank']!==null) tk_require($rank===$g['openingRank'],'Open with your lowest hand card: '.tk_rank_name($g['openingRank']).'.');
    $legal=tk_can_play($selected[0],$g['pile']);
    tk_require($source!=='hand' || $legal,'That card is too low. Play an equal or higher card, a 6, or a 10.');
    $p[$source]=array_values(array_filter($p[$source],fn($c)=>!in_array($c['id'],$ids,true)));
    $g['openingRank']=null;
    $name=$p['name'];
    if (!$legal) {
        $taken=count($g['pile'])+count($selected);
        $p['hand']=array_merge($p['hand'],$g['pile'],$selected); $g['pile']=[]; $p['stats']['pickups']++;
        tk_sort_hand($p); unset($p);
        tk_touch($g,$name.' reveals '.tk_rank_name($rank).' and picks up '.$taken.' cards.','pickup',$id);
        tk_finish_and_advance($g,$id); return;
    }
    $g['pile']=array_merge($g['pile'],$selected);
    unset($p);
    if ($source==='hand') tk_refill($g,$i);
    $four=false;
    if (count($g['pile'])>=4) {
        $four=true;
        foreach (array_slice($g['pile'],-4) as $c) if ($c['rank']!==$rank) $four=false;
    }
    $burn=$rank===10 || $four;
    if ($burn) {
        $burned=count($g['pile']); $g['hole']=array_merge($g['hole'],$g['pile']); $g['pile']=[]; $g['players'][$i]['stats']['burns']++;
        tk_touch($g,$name.' plays '.count($selected).' × '.tk_rank_name($rank).'. '.($rank===10?'Ten burns':'Four of a kind burns').' '.$burned.' cards. Extra turn!','burn',$id);
    } else {
        tk_touch($g,$name.' plays '.count($selected).' × '.tk_rank_name($rank).($rank===6?'. The pile is reset.':'.'),'play',$id);
    }
    tk_finish_and_advance($g,$id,$burn);
}
function tk_pickup(array &$g,string $id): void {
    $i=tk_assert_turn($g,$id); $p=&$g['players'][$i];
    tk_require($g['openingRank']===null,'The first move must be the lowest card.');
    tk_require(count($g['pile'])>0,'The pile is empty. Play a card.');
    tk_require(tk_phase($p)==='hand','Attempt one of your table cards to pick it up with the pile.');
    $count=count($g['pile']); $p['hand']=array_merge($p['hand'],$g['pile']); $g['pile']=[]; $p['stats']['pickups']++; tk_sort_hand($p);
    $name=$p['name']; unset($p);
    tk_touch($g,$name.' picks up the pile ('.$count.' cards).','pickup',$id); tk_finish_and_advance($g,$id);
}
function tk_bot_step(array &$g): bool {
    if ($g['status']!=='playing' || $g['turnId']===null) return false;
    $i=tk_index($g,$g['turnId']); $p=$g['players'][$i];
    if (!$p['bot']) return false;
    $source=tk_phase($p);
    if ($source==='down') {
        $card=$p['down'][random_int(0,count($p['down'])-1)];
        tk_play($g,$p['id'],'down',[$card['id']]); return true;
    }
    $cards=$p[$source];
    // A bot sees only its hand, face-up cards, and the public pile.
    $legal=array_values(array_filter($cards,fn($c)=>($g['openingRank']===null || $c['rank']===$g['openingRank']) && tk_can_play($c,$g['pile'])));
    if (!$legal) {
        if ($source==='hand') tk_pickup($g,$p['id']);
        else { usort($cards,fn($a,$b)=>$a['rank']<=>$b['rank']); tk_play($g,$p['id'],$source,[$cards[0]['id']]); }
        return true;
    }
    // Save wild cards when an ordinary card works. Favor rank groups to shed cards.
    $score=function($c)use($cards,$g){
        $n=count(array_filter($cards,fn($x)=>$x['rank']===$c['rank']));
        $topRun=0; foreach(array_reverse($g['pile']) as $pc) { if ($pc['rank']!==$c['rank']) break; $topRun++; }
        return (($n+$topRun>=4)?-100:0)+($c['rank']===6?20:($c['rank']===10?25:$c['rank']))-$n*1.5;
    };
    usort($legal,fn($a,$b)=>$score($a)<=>$score($b)); $rank=$legal[0]['rank'];
    $ids=array_column(array_values(array_filter($cards,fn($c)=>$c['rank']===$rank)),'id');
    tk_play($g,$p['id'],$source,$ids); return true;
}
function tk_view(array $g,string $youId): array {
    $out=['room'=>$g['room'],'status'=>$g['status'],'hostId'=>$g['hostId'],'youId'=>$youId,
        'players'=>[],'turnId'=>$g['turnId'],'deckCount'=>count($g['deck']),'pile'=>$g['pile'],
        'holeCount'=>count($g['hole']),'openingRank'=>$g['openingRank'],'results'=>$g['results'],
        'events'=>$g['events'],'version'=>$g['version'],'round'=>$g['round']];
    foreach($g['players'] as $p) {
        $out['players'][]=['id'=>$p['id'],'name'=>$p['name'],'seat'=>$p['seat'],'bot'=>$p['bot'],'ready'=>$p['ready'],
            'connected'=>$p['bot'] || tk_now()-$p['lastSeen']<25,'disconnectedFor'=>$p['bot']?0:max(0,(int)(tk_now()-$p['lastSeen'])),
            'handCount'=>count($p['hand']),'hand'=>$p['id']===$youId?$p['hand']:null,
            'up'=>$p['up'],'downCount'=>count($p['down']),'downSlots'=>array_column($p['down'],'id'),
            'finish'=>$p['finish'],'stats'=>$p['stats'],'phase'=>tk_phase($p)];
    }
    return $out;
}
