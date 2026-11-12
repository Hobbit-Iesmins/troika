<?php
/** Troika's authoritative game rules. No database or network dependencies. */
declare(strict_types=1);

function tk_id(): string { return bin2hex(random_bytes(12)); }
function tk_now(): float { return microtime(true); }
function tk_require(bool $condition, string $message): void { if (!$condition) throw new RuntimeException($message); }
/** Optional public avatar metadata; external URLs and executable image formats are not accepted. */
function tk_avatar(mixed $value): ?array {
    if(!is_array($value)) return null;
    if(($value['kind']??null)==='initial') {
        if(array_diff(array_keys($value),['kind','text','color'])) return null;
        $text=$value['text']??''; $color=$value['color']??'gold';
        if(!is_string($text) || preg_match('//u',$text)!==1 || preg_match_all('/./us',$text)>2 || preg_match('/[\x00-\x1f\x7f\x{202a}-\x{202e}\x{2066}-\x{2069}<>&]/u',$text) || !in_array($color,['gold','coral','mint','sky','violet'],true)) return null;
        return ['kind'=>'initial','text'=>$text,'color'=>$color];
    }
    if(($value['kind']??null)!=='image' || array_diff(array_keys($value),['kind','dataUrl']) || !is_string($value['dataUrl']??null) || strlen($value['dataUrl'])>24000) return null;
    if(!preg_match('/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+\/]+={0,2})$/D',$value['dataUrl'],$parts)) return null;
    $bytes=base64_decode($parts[2],true); if($bytes===false || base64_encode($bytes)!==$parts[2]) return null;
    $size=@getimagesizefromstring($bytes); $types=['png'=>IMAGETYPE_PNG,'jpeg'=>IMAGETYPE_JPEG,'webp'=>IMAGETYPE_WEBP];
    if(!$size || $size[2]!==$types[$parts[1]] || $size[0]<1 || $size[1]<1 || $size[0]>256 || $size[1]>256) return null;
    return ['kind'=>'image','dataUrl'=>$value['dataUrl']];
}
/** Settings are fixed at table creation. Old saved tables use the standard setup. */
function tk_settings(array $settings=[]): array {
    $mode=array_key_exists('mode',$settings)?$settings['mode']:'standard';
    tk_require(is_string($mode) && in_array($mode,['standard','expanded'],true),'Choose Standard or Expanded mode.');
    $capacity=array_key_exists('maxPlayers',$settings)?$settings['maxPlayers']:($mode==='standard'?5:9);
    $decks=array_key_exists('decks',$settings)?$settings['decks']:($mode==='standard'?1:2);
    tk_require(is_int($capacity) && is_int($decks),'Choose a whole number of seats and decks.');
    if ($mode==='standard') tk_require($capacity===5 && $decks===1,'Standard mode uses five seats and one deck.');
    else {
        tk_require(in_array($capacity,[9,10,11,12],true),'Expanded mode has 9, 10, 11, or 12 seats.');
        tk_require(in_array($decks,[2,3,4],true),'Expanded mode uses two, three, or four decks.');
    }
    tk_require($capacity*9<=$decks*52,'Twelve seats need 108 dealt cards. Choose three or four decks for a twelve-seat table.');
    $rule=$settings['burnRule']??'any';
    tk_require(is_string($rule) && in_array($rule,['any','all_suits'],true),'Choose Any four or All four suits for burns.');
    $jump=array_key_exists('jumpIn',$settings)?$settings['jumpIn']:false;
    tk_require(is_bool($jump),'Choose whether jump-in burns are enabled.');
    return array_merge(['mode'=>$mode,'maxPlayers'=>$capacity,'decks'=>$decks],$rule==='any'?[]:['burnRule'=>$rule],$jump?['jumpIn'=>true]:[]);
}
function tk_game_settings(array $g): array { return tk_settings($g['settings']??[]); }
function tk_new_player(string $name, int $seat, bool $bot = false, string $tokenHash = ''): array {
    return ['id'=>tk_id(), 'name'=>$name, 'seat'=>$seat, 'bot'=>$bot, 'tokenHash'=>$tokenHash,
        'ready'=>$bot, 'lastSeen'=>tk_now(), 'hand'=>[], 'up'=>[], 'down'=>[], 'finish'=>null,
        'stats'=>['pickups'=>0,'burns'=>0]];
}
function tk_new_game(string $room, array $host, array $settings=[]): array {
    $settings=tk_settings($settings);
    tk_require(is_int($host['seat']) && $host['seat']>=0 && $host['seat']<$settings['maxPlayers'],'Choose a seat within this table.');
    $host['ready'] = true;
    return ['room'=>$room,'status'=>'lobby','settings'=>$settings,'hostId'=>$host['id'],'players'=>[$host], 'turnId'=>null,
        'deck'=>[], 'pile'=>[], 'hole'=>[], 'openingRank'=>null,'results'=>[], 'events'=>[],
        'version'=>1,'eventSeq'=>0,'botAt'=>0,'updatedAt'=>tk_now(),'round'=>0,
        'paused'=>false,'scoreboard'=>[],'scoredRounds'=>[],'lastMove'=>null,'recentCards'=>[]];
}
/** Upgrade old tables without inventing scores for already completed rounds. */
function tk_session_init(array &$g): void {
    if(!array_key_exists('scoreboard',$g)) {
        $g['scoreboard']=[];
        $g['scoredRounds']=$g['status']==='finished'?[$g['round']??0]:[];
    }
    $g['scoredRounds']=$g['scoredRounds']??[];
    $g['paused']=$g['paused']??false;
    $g['lastMove']=$g['lastMove']??null;
    $g['recentCards']=$g['recentCards']??[];
    foreach($g['players'] as $p) {
        $row=$g['scoreboard'][$p['id']]??['id'=>$p['id'],'rounds'=>0,'wins'=>0,'lastPlaces'=>0,'burns'=>0,'pickups'=>0];
        $row['name']=$p['name'];$row['bot']=$p['bot'];$g['scoreboard'][$p['id']]=$row;
    }
}
function tk_record_scores(array &$g): void {
    tk_session_init($g);
    if($g['status']!=='finished' || in_array($g['round'],$g['scoredRounds'],true))return;
    foreach($g['players'] as $p) {
        $row=&$g['scoreboard'][$p['id']];$row['rounds']++;
        if($p['finish']===1)$row['wins']++;
        if($p['finish']===count($g['players']))$row['lastPlaces']++;
        $row['burns']+=$p['stats']['burns'];$row['pickups']+=$p['stats']['pickups'];unset($row);
    }
    $g['scoredRounds'][]=$g['round'];
}
function tk_faces(array $cards): array { return array_map(fn($c)=>['rank'=>$c['rank'],'suit'=>$c['suit']],$cards); }
function tk_record_move(array &$g,string $id,array $before,array $played,string $type,?string $reason,bool $extra,int $holeBefore): void {
    tk_session_init($g);$event=end($g['events']);$p=$g['players'][tk_index($g,$id)];
    $g['lastMove']=['id'=>$event['id'],'type'=>$type,'playerId'=>$id,'playerName'=>$p['name'],'text'=>$event['text'],
        'cards'=>tk_faces($played),'beforePile'=>tk_faces(array_slice($before,-10)),'afterPile'=>tk_faces(array_slice($g['pile'],-10)),
        'pileBeforeCount'=>count($before),'pileAfterCount'=>count($g['pile']),'holeAdded'=>count($g['hole'])-$holeBefore,
        'extraTurn'=>$extra,'burnReason'=>$reason];
    foreach($played as $c)$g['recentCards'][]=['rank'=>$c['rank'],'suit'=>$c['suit'],'playerName'=>$p['name'],'moveId'=>$event['id']];
    $g['recentCards']=array_slice($g['recentCards'],-10);
}
function tk_jump_cards(array $g,string $id): array {
    if($g['status']!=='playing' || ($g['paused']??false) || !(tk_game_settings($g)['jumpIn']??false) || $g['turnId']===$id || $g['openingRank']!==null || !$g['pile'])return [];
    $p=$g['players'][tk_index($g,$id)];$source=tk_phase($p);
    if(!in_array($source,['hand','up'],true) || ($source==='up' && $g['deck']))return [];
    $top=end($g['pile']);$settings=tk_game_settings($g);
    if(tk_four_burn($g['pile'],$settings))return [];
    $out=[];
    foreach($p[$source] as $c)if($c['rank']===$top['rank'] && $c['rank']!==10 && tk_four_burn(array_merge($g['pile'],[$c]),$settings))$out[]=['id'=>$c['id'],'source'=>$source];
    return $out;
}
function tk_jump_in(array &$g,string $id,string $source,string $cardId,int $version): void {
    tk_require($version===$g['version'],'The pile changed. Check the table before jumping in.');
    $valid=false;foreach(tk_jump_cards($g,$id) as $c)if($c['id']===$cardId&&$c['source']===$source)$valid=true;
    tk_require($valid,'Jump in with one card that completes the selected four-card burn rule.');
    tk_play($g,$id,$source,[$cardId],true);
}
function tk_index(array $g, string $id): int {
    foreach ($g['players'] as $i=>$p) if ($p['id']===$id) return $i;
    throw new RuntimeException('This seat no longer exists. Join the table again.');
}
function tk_touch(array &$g, string $text, string $type='play', ?string $playerId=null, array $cards=[]): void {
    $g['version']++; $g['updatedAt']=tk_now();
    // Store only cards made public by this action, never unplayed hand/blind cards.
    $faces=array_map(fn($c)=>['rank'=>$c['rank'],'suit'=>$c['suit']],$cards);
    $g['events'][]=['id'=>++$g['eventSeq'],'text'=>$text,'type'=>$type,'playerId'=>$playerId,'cards'=>$faces];
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
    $settings=tk_game_settings($g);
    tk_require(count($g['players'])>=2 && count($g['players'])<=$settings['maxPlayers'],'Seat between two and '.$settings['maxPlayers'].' players before dealing.');
    tk_require(count($g['players'])*9<=$settings['decks']*52,'There are not enough cards to deal nine cards to every player.');
    $seats=[];
    foreach ($g['players'] as $p) {
        tk_require(is_int($p['seat']) && $p['seat']>=0 && $p['seat']<$settings['maxPlayers'],'A player is outside this table’s seat range.');
        tk_require(!in_array($p['seat'],$seats,true),'Each player needs a separate seat.'); $seats[]=$p['seat'];
    }
    $g['settings']=$settings;
    foreach ($g['players'] as $p) tk_require($p['ready'], $p['name'].' must be ready before dealing.');
    usort($g['players'], fn($a,$b)=>$a['seat']<=>$b['seat']);
    $deck=[];
    for($copy=0;$copy<$settings['decks'];$copy++) foreach (['S','H','D','C'] as $s) for ($r=2;$r<=14;$r++) $deck[]=['id'=>tk_id(),'rank'=>$r,'suit'=>$s];
    // Fisher-Yates with the OS random source.
    for ($i=count($deck)-1;$i>0;$i--) { $j=random_int(0,$i); [$deck[$i],$deck[$j]]=[$deck[$j],$deck[$i]]; }
    foreach ($g['players'] as &$p) {
        $p['hand']=[]; $p['up']=[]; $p['down']=[]; $p['finish']=null; $p['stats']=['pickups'=>0,'burns'=>0];
    } unset($p);
    foreach (['down','up','hand'] as $zone) for($n=0;$n<3;$n++) foreach ($g['players'] as &$p) $p[$zone][]=array_pop($deck);
    unset($p);
    foreach ($g['players'] as &$p) $p['dealtDown']=$p['down'];
    unset($p);
    $minimum=15; $starter=null;
    foreach ($g['players'] as &$p) {
        tk_sort_hand($p);
        foreach ($p['hand'] as $c) if ($c['rank']<$minimum) { $minimum=$c['rank']; $starter=$p['id']; }
    } unset($p);
    tk_session_init($g);$g['paused']=false;$g['lastMove']=null;$g['recentCards']=[];
    $g['status']='playing'; $g['deck']=$deck; $g['pile']=[]; $g['hole']=[]; $g['openingRank']=$minimum;
    $g['results']=[]; $g['turnId']=$starter; $g['botAt']=tk_now()+0.85; $g['round']++;
    $p=$g['players'][tk_index($g,$starter)];
    tk_touch($g,$p['name'].' opens with the lowest hand card: '.tk_rank_name($minimum).'.','deal',$starter);
}
/** Only the uninterrupted top run counts. Duplicate suits do not reset that run. */
function tk_four_burn(array $pile,array $settings): bool {
    if(count($pile)<4)return false;
    $rank=$pile[count($pile)-1]['rank']; $run=[];
    foreach(array_reverse($pile) as $c){if($c['rank']!==$rank)break;$run[]=$c;}
    if(($settings['burnRule']??'any')==='all_suits')return count(array_unique(array_column($run,'suit')))===4;
    return count($run)>=4;
}
function tk_bot_group(array $cards,int $rank,array $g): array {
    $group=array_values(array_filter($cards,fn($c)=>$c['rank']===$rank));
    if((tk_game_settings($g)['burnRule']??'any')==='all_suits'){
        $seen=[]; foreach(array_reverse($g['pile']) as $c){if($c['rank']!==$rank)break;$seen[$c['suit']]=true;}
        $preferred=[];$rest=[];
        foreach($group as $c){if(!isset($seen[$c['suit']])){$preferred[]=$c;$seen[$c['suit']]=true;}else $rest[]=$c;}
        $group=array_merge($preferred,$rest);
    }
    return array_slice($group,0,4);
}
function tk_sort_hand(array &$p): void { usort($p['hand'],fn($a,$b)=>($a['rank']<=>$b['rank']) ?: strcmp($a['suit'],$b['suit'])); }
function tk_can_play(array $c, array $pile): bool {
    if (!$pile || in_array($c['rank'],[6,10],true)) return true;
    $top=$pile[count($pile)-1]['rank'];
    return $top===6 || $c['rank']>=$top;
}
function tk_assert_turn(array $g, string $id): int {
    tk_require($g['status']==='playing','There is no round in progress.');
    tk_require(!($g['paused']??false),'The host has paused this round.');
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
        $g['status']='finished'; $g['turnId']=null;tk_record_scores($g); return;
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
function tk_play(array &$g, string $id, string $source, array $ids,bool $jump=false): void {
    if($jump){
        tk_require(count($ids)===1,'Jump in with one card.');$valid=false;
        foreach(tk_jump_cards($g,$id) as $c)if($c['source']===$source&&$c['id']===$ids[0])$valid=true;
        tk_require($valid,'That card cannot jump in now.');$i=tk_index($g,$id);
    }else $i=tk_assert_turn($g,$id);
    $before=$g['pile'];$holeBefore=count($g['hole']);
    $p=&$g['players'][$i];
    tk_require(in_array($source,['hand','up','down'],true),'Choose cards from your current phase.');
    tk_require(tk_phase($p)===$source,'Play your hand first, then face-up cards, then face-down cards.');
    tk_require($source==='hand' || !$g['deck'],'Finish drawing and playing your hand first.');
    tk_require(count($ids)>0 && count($ids)<=4 && count(array_unique($ids))===count($ids),'Choose one to four matching cards.');
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
        // A failed blind card goes into a private hand, so never publish its face.
        $publicCards=$source==='down'?[]:$selected;
        $text=$source==='down'?$name.' picks up the pile ('.$taken.' cards).':$name.' reveals '.tk_rank_name($rank).' and picks up '.$taken.' cards.';
        tk_touch($g,$text,'pickup',$id,$publicCards);
        tk_record_move($g,$id,$before,$publicCards,'pickup',null,false,$holeBefore);
        tk_finish_and_advance($g,$id); return;
    }
    $g['pile']=array_merge($g['pile'],$selected);
    unset($p);
    if ($source==='hand') tk_refill($g,$i);
    $four=tk_four_burn($g['pile'],tk_game_settings($g));
    $burn=$rank===10 || $four;
    if ($burn) {
        $burned=count($g['pile']); $g['hole']=array_merge($g['hole'],$g['pile']); $g['pile']=[]; $g['players'][$i]['stats']['burns']++;
        tk_touch($g,$name.($jump?' jumps in with ':' plays ').count($selected).' × '.tk_rank_name($rank).'. '.($rank===10?'Ten burns':((tk_game_settings($g)['burnRule']??'any')==='all_suits'?'All four suits burn':'Four of a kind burns')).' '.$burned.' cards. Extra turn!','burn',$id,$selected);
    } else {
        tk_touch($g,$name.' plays '.count($selected).' × '.tk_rank_name($rank).($rank===6?'. The pile is reset.':'.'),'play',$id,$selected);
    }
    $reason=$burn?($rank===10?'ten':((tk_game_settings($g)['burnRule']??'any')==='all_suits'?'all_suits':'four')):null;
    tk_record_move($g,$id,$before,$selected,$jump?'jump':($burn?'burn':'play'),$reason,$burn,$holeBefore);
    tk_finish_and_advance($g,$id,$burn);
    $g['lastMove']['extraTurn']=$burn&&$g['status']==='playing'&&$g['turnId']===$id;
    if($burn&&!$g['lastMove']['extraTurn'])$g['lastMove']['text']=preg_replace('/ Extra turn!$/','',$g['lastMove']['text']);
}
function tk_pickup(array &$g,string $id): void {
    $i=tk_assert_turn($g,$id); $p=&$g['players'][$i];
    tk_require($g['openingRank']===null,'The first move must be the lowest card.');
    tk_require(count($g['pile'])>0,'The pile is empty. Play a card.');
    tk_require(tk_phase($p)==='hand','Attempt one of your table cards to pick it up with the pile.');
    $before=$g['pile'];$holeBefore=count($g['hole']);
    $count=count($g['pile']); $p['hand']=array_merge($p['hand'],$g['pile']); $g['pile']=[]; $p['stats']['pickups']++; tk_sort_hand($p);
    $name=$p['name']; unset($p);
    tk_touch($g,$name.' picks up the pile ('.$count.' cards).','pickup',$id);
    tk_record_move($g,$id,$before,[],'pickup',null,false,$holeBefore);tk_finish_and_advance($g,$id);
}
function tk_bot_step(array &$g): bool {
    if ($g['status']!=='playing' || $g['turnId']===null || ($g['paused']??false)) return false;
    if(tk_game_settings($g)['jumpIn']??false)foreach($g['players'] as $bot)if($bot['bot']){
        $jump=tk_jump_cards($g,$bot['id']);if($jump){tk_jump_in($g,$bot['id'],$jump[0]['source'],$jump[0]['id'],$g['version']);return true;}
    }
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
        $burn=tk_four_burn(array_merge($g['pile'],tk_bot_group($cards,$c['rank'],$g)),tk_game_settings($g));
        return ($burn?-100:0)+($c['rank']===6?20:($c['rank']===10?25:$c['rank']))-$n*1.5;
    };
    usort($legal,fn($a,$b)=>$score($a)<=>$score($b)); $rank=$legal[0]['rank'];
    // With several decks a rank can appear more than four times. Burn one group per turn.
    $ids=array_column(tk_bot_group($cards,$rank,$g),'id');
    tk_play($g,$p['id'],$source,$ids); return true;
}
function tk_view(array $g,string $youId): array {
    tk_session_init($g);
    $scores=array_values($g['scoreboard']);
    usort($scores,fn($a,$b)=>($b['wins']<=>$a['wins'])?:($a['lastPlaces']<=>$b['lastPlaces'])?:strcmp($a['name'],$b['name']));
    $out=['room'=>$g['room'],'status'=>$g['status'],'settings'=>tk_game_settings($g),'hostId'=>$g['hostId'],'youId'=>$youId,
        'players'=>[],'turnId'=>$g['turnId'],'deckCount'=>count($g['deck']),'pile'=>$g['pile'],
        'holeCount'=>count($g['hole']),'openingRank'=>$g['openingRank'],'results'=>$g['results'],
        'events'=>$g['events'],'version'=>$g['version'],'round'=>$g['round'],
        'paused'=>$g['paused'],'jumpCards'=>tk_jump_cards($g,$youId),'scoreboard'=>$scores,'lastMove'=>$g['lastMove'],'recentCards'=>$g['recentCards'],'ownBlindCards'=>[]];
    foreach($g['players'] as $p) {
        if($g['status']==='finished' && $p['id']===$youId) $out['ownBlindCards']=$p['dealtDown']??$p['down'];
        $out['players'][]=['id'=>$p['id'],'name'=>$p['name'],'seat'=>$p['seat'],'bot'=>$p['bot'],'ready'=>$p['ready'],
            'connected'=>$p['bot'] || tk_now()-$p['lastSeen']<25,'disconnectedFor'=>$p['bot']?0:max(0,(int)(tk_now()-$p['lastSeen'])),
            'handCount'=>count($p['hand']),'hand'=>$p['id']===$youId?$p['hand']:null,
            'up'=>$p['up'],'downCount'=>count($p['down']),'downSlots'=>array_column($p['down'],'id'),
            'finish'=>$p['finish'],'stats'=>$p['stats'],'phase'=>tk_phase($p)];
        $avatar=tk_avatar($p['avatar']??null);if($avatar!==null)$out['players'][count($out['players'])-1]['avatar']=$avatar;
    }
    return $out;
}
