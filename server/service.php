<?php
declare(strict_types=1);
require_once __DIR__.'/engine.php';

function tk_database(): PDO {
    tk_require(extension_loaded('pdo_sqlite'),'PHP SQLite support is missing. Enable pdo_sqlite in MAMP.');
    // Keep private cards and bearer-token hashes outside the HTTP document root.
    $dir=getenv('TROIKA_DATA_DIR') ?: sys_get_temp_dir().DIRECTORY_SEPARATOR.'troika-'.substr(hash('sha256',dirname(__DIR__)),0,16);
    if (!is_dir($dir) && !mkdir($dir,0700,true) && !is_dir($dir)) throw new RuntimeException('Cannot create Troika storage. Check PHP temporary-folder permissions.');
    $db=new PDO('sqlite:'.$dir.DIRECTORY_SEPARATOR.'games.sqlite');
    $db->setAttribute(PDO::ATTR_ERRMODE,PDO::ERRMODE_EXCEPTION);
    $db->exec('PRAGMA busy_timeout=5000');
    $db->exec('CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, state TEXT NOT NULL, updated REAL NOT NULL)');
    return $db;
}
function tk_nickname($name): string {
    tk_require(is_string($name),'Enter a nickname.'); $name=trim($name);
    tk_require(preg_match('//u',$name)===1,'Use a valid UTF-8 nickname.');
    tk_require(!preg_match('/[\x00-\x1F\x7F]/u',$name),'Remove control characters from your nickname.');
    $length=preg_match_all('/./u',$name);
    tk_require($length>=1 && $length<=20,'Use a nickname between 1 and 20 characters.');
    return $name;
}
function tk_seat($seat,int $maxPlayers=5): int {
    tk_require(is_int($seat) && $seat>=0 && $seat<$maxPlayers,'Choose a table seat from 1 to '.$maxPlayers.'.'); return $seat;
}
function tk_same_name(string $a,string $b): bool { return preg_match('/^'.preg_quote($a,'/').'$/iu',$b)===1; }
function tk_bot_name(array $g,int $seat): string {
    $names=['Māra','Rihards','Laima','Jānis','Dace','Artūrs','Elīna','Roberts','Līga','Edgars','Zane','Mārtiņš'];
    $base=$names[$seat]; $name=$base; $suffix=1;
    while(array_filter($g['players'],fn($p)=>tk_same_name($p['name'],$name))) {
        $name=$base.' Bot'.($suffix===1?'':' '.$suffix); $suffix++;
    }
    return $name;
}
function tk_free_seat(array $g,int $seat,?string $ignoreId=null): void {
    foreach($g['players'] as $p) tk_require($p['seat']!==$seat || $p['id']===$ignoreId,'Someone has already taken that seat.');
}
function tk_auth(array $g,$token): string {
    tk_require(is_string($token) && preg_match('/^[a-f0-9]{48}$/D',$token)===1,'Your seat key is missing. Rejoin the table.');
    $hash=hash('sha256',$token);
    foreach($g['players'] as $p) if (!$p['bot'] && $p['tokenHash']!=='' && hash_equals($p['tokenHash'],$hash)) return $p['id'];
    throw new RuntimeException('Your seat key is no longer valid. Rejoin the table.');
}
function tk_host(array $g,string $id): void { tk_require($g['hostId']===$id,'Only the host can do that.'); }
function tk_lobby(array $g): void { tk_require($g['status']==='lobby','Seats can only change before a round starts.'); }
function tk_save(PDO $db,array $g): void {
    tk_session_init($g);
    $q=$db->prepare('INSERT INTO rooms(code,state,updated) VALUES(?,?,?) ON CONFLICT(code) DO UPDATE SET state=excluded.state, updated=excluded.updated');
    $q->execute([$g['room'],json_encode($g,JSON_THROW_ON_ERROR),tk_now()]);
}
function tk_dispatch(PDO $db,array $request): array {
    $action=$request['action']??'';
    tk_require(is_string($action),'Choose a valid action.');
    $db->exec('BEGIN IMMEDIATE');
    try {
        if ($action==='create') {
            $settings=tk_settings(array_intersect_key($request,array_flip(['mode','maxPlayers','decks','burnRule','jumpIn'])));
            $name=tk_nickname($request['nickname']??null); $seat=tk_seat($request['seat']??0,$settings['maxPlayers']);
            $token=bin2hex(random_bytes(24)); $player=tk_new_player($name,$seat,false,hash('sha256',$token));
            do {
                $code=''; $alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
                for($n=0;$n<5;$n++) $code.=$alphabet[random_int(0,strlen($alphabet)-1)];
                $q=$db->prepare('SELECT 1 FROM rooms WHERE code=?'); $q->execute([$code]);
            } while($q->fetchColumn());
            $g=tk_new_game($code,$player,$settings); tk_touch($g,$name.' opened the table.','lobby',$player['id']); tk_save($db,$g);
            // Clean abandoned tables after seven days, without touching the active table.
            $q=$db->prepare('DELETE FROM rooms WHERE updated<?'); $q->execute([tk_now()-604800]);
            $db->exec('COMMIT'); return ['room'=>$code,'token'=>$token,'state'=>tk_view($g,$player['id'])];
        }
        $room=$request['room']??'';
        tk_require(is_string($room),'Enter a table code.'); $room=strtoupper(trim($room));
        tk_require(preg_match('/^[A-Z2-9]{5}$/D',$room)===1,'Enter the five-character table code.');
        $q=$db->prepare('SELECT state FROM rooms WHERE code=?'); $q->execute([$room]); $raw=$q->fetchColumn();
        tk_require($raw!==false,'Table not found. Check the code or create a new table.');
        $g=json_decode($raw,true,512,JSON_THROW_ON_ERROR);
        tk_session_init($g);
        $g['settings']=tk_game_settings($g); $capacity=$g['settings']['maxPlayers'];
        if ($action==='join') {
            tk_lobby($g); tk_require(count($g['players'])<$capacity,'This table is full.');
            $name=tk_nickname($request['nickname']??null); $seat=tk_seat($request['seat']??null,$capacity); tk_free_seat($g,$seat);
            foreach($g['players'] as $p) tk_require(!tk_same_name($p['name'],$name),'That nickname is already seated here.');
            $token=bin2hex(random_bytes(24)); $player=tk_new_player($name,$seat,false,hash('sha256',$token));
            if ($g['hostId']===null) { $g['hostId']=$player['id']; $player['ready']=true; }
            $g['players'][]=$player;
            tk_touch($g,$name.' took seat '.($seat+1).'.','lobby',$player['id']); tk_save($db,$g); $db->exec('COMMIT');
            return ['room'=>$room,'token'=>$token,'state'=>tk_view($g,$player['id'])];
        }
        // A read-only public lobby view permits choosing an actually open seat before joining.
        if ($action==='lobby') {
            $out=['room'=>$g['room'],'status'=>$g['status'],'settings'=>$g['settings'],'players'=>array_map(fn($p)=>['name'=>$p['name'],'seat'=>$p['seat'],'bot'=>$p['bot']],$g['players'])];
            $db->exec('COMMIT'); return ['lobby'=>$out];
        }
        $id=tk_auth($g,$request['token']??null); $i=tk_index($g,$id); $g['players'][$i]['lastSeen']=tk_now();
        switch($action) {
            case 'state': break;
            case 'pause':
                tk_host($g,$id);tk_require($g['status']==='playing','Pause is available during a round.');
                tk_require(isset($request['paused'])&&is_bool($request['paused']),'Choose pause or resume.');
                if($g['paused']!==$request['paused']){
                    $g['paused']=$request['paused'];$g['botAt']=tk_now()+0.85;
                    tk_touch($g,$g['players'][$i]['name'].($g['paused']?' paused the round.':' resumed the round.'),'pause',$id);
                }break;
            case 'jump':
                tk_require(isset($request['source'],$request['card'],$request['version'])&&is_string($request['source'])&&is_string($request['card'])&&is_int($request['version']),'Choose a valid jump-in card and table version.');
                tk_jump_in($g,$id,$request['source'],$request['card'],$request['version']);break;
            case 'seat':
                tk_lobby($g); $seat=tk_seat($request['seat']??null,$capacity); tk_free_seat($g,$seat,$id);
                $g['players'][$i]['seat']=$seat; $g['players'][$i]['ready']=$id===$g['hostId'];
                tk_touch($g,$g['players'][$i]['name'].' moved to seat '.($seat+1).'.','lobby',$id); break;
            case 'ready':
                tk_lobby($g); tk_require(isset($request['ready']) && is_bool($request['ready']),'Choose ready or not ready.');
                $g['players'][$i]['ready']=$request['ready']; tk_touch($g,$g['players'][$i]['name'].($request['ready']?' is ready.':' is not ready.'),'lobby',$id); break;
            case 'bot':
                tk_host($g,$id); tk_lobby($g); tk_require(count($g['players'])<$capacity,'This table is full.');
                $seat=tk_seat($request['seat']??null,$capacity); tk_free_seat($g,$seat);
                $name=tk_bot_name($g,$seat);
                $bot=tk_new_player($name,$seat,true); $g['players'][]=$bot; tk_touch($g,$name.' (bot) joined seat '.($seat+1).'.','lobby',$bot['id']); break;
            case 'remove_bot':
                tk_host($g,$id); tk_lobby($g); $seat=tk_seat($request['seat']??null,$capacity); $found=false;
                foreach($g['players'] as $j=>$p) if ($p['seat']===$seat) {
                    tk_require($p['bot'],'Only bot seats can be removed.'); array_splice($g['players'],$j,1); $found=true; tk_touch($g,$p['name'].' left the table.','lobby',$p['id']); break;
                }
                tk_require($found,'That seat is already empty.'); break;
            case 'start': tk_host($g,$id); tk_start($g); break;
            case 'play':
                tk_require(isset($request['cards']) && is_array($request['cards']),'Choose a card to play.');
                foreach($request['cards'] as $cid) tk_require(is_string($cid),'Choose a valid card.');
                tk_require(isset($request['source']) && is_string($request['source']),'Choose a card source.');
                tk_play($g,$id,$request['source'],$request['cards']); break;
            case 'pickup': tk_pickup($g,$id); break;
            case 'kick':
                tk_host($g,$id);
                $playerId=$request['playerId']??null;
                tk_require(is_string($playerId) && preg_match('/^[a-f0-9]{24}$/D',$playerId)===1,'Choose a player to kick.');
                $found=null;
                foreach($g['players'] as $j=>$p) if($p['id']===$playerId) { $found=$j; break; }
                tk_require($found!==null,'That player has already left the table.');
                $player=$g['players'][$found]; $name=$player['name']; $hostName=$g['players'][$i]['name'];
                tk_require($player['id']!==$id,'You cannot kick yourself. Use Leave table instead.');
                tk_require(!$player['bot'],'That seat is already controlled by a bot.');
                if($g['status']==='lobby') array_splice($g['players'],$found,1);
                else {
                    $g['players'][$found]['bot']=true; $g['players'][$found]['tokenHash']=''; $g['players'][$found]['ready']=true;
                    if($g['status']==='playing') $g['botAt']=tk_now()+0.85;
                }
                tk_touch($g,$hostName.' kicked '.$name.($g['status']==='lobby'?' from the table.':'; a bot takes over.'),'lobby',$player['id']); break;
            case 'replace_bot':
                tk_host($g,$id); tk_require($g['status']==='playing','Bot takeover is available during a round.'); $seat=tk_seat($request['seat']??null,$capacity); $found=false;
                foreach($g['players'] as &$p) if($p['seat']===$seat) {
                    tk_require(!$p['bot'] && $p['id']!==$id,'Choose a disconnected human player.');
                    tk_require(tk_now()-$p['lastSeen']>=30,'Wait 30 seconds after the player disconnects before using a bot.');
                    $p['bot']=true; $p['tokenHash']=''; $p['ready']=true; $found=true;
                    tk_touch($g,'A bot takes over for '.$p['name'].'.','lobby',$p['id']); break;
                } unset($p); tk_require($found,'Choose an occupied seat.'); break;
            case 'rematch':
                tk_host($g,$id); tk_require($g['status']==='finished','Finish this round before starting a rematch.');
                $g['paused']=false;$g['lastMove']=null;$g['recentCards']=[];
                $g['status']='lobby'; $g['turnId']=null; $g['deck']=[]; $g['pile']=[]; $g['hole']=[]; $g['openingRank']=null; $g['results']=[];
                foreach($g['players'] as &$p) { $p['hand']=[]; $p['up']=[]; $p['down']=[]; $p['finish']=null; $p['ready']=$p['bot']||$p['id']===$id; } unset($p);
                tk_touch($g,'Rematch! Seats stay the same. Get ready for a new deal.','lobby',$id); break;
            case 'leave':
                $name=$g['players'][$i]['name'];
                if ($g['status']==='lobby') array_splice($g['players'],$i,1);
                else { $g['players'][$i]['bot']=true; $g['players'][$i]['tokenHash']=''; $g['players'][$i]['ready']=true; }
                if($g['hostId']===$id) {
                    $g['hostId']=null;
                    foreach($g['players'] as &$p) if(!$p['bot']) { $g['hostId']=$p['id']; $p['ready']=true; break; } unset($p);
                }
                tk_touch($g,$name.' left'.($g['status']==='lobby'?'.':'; a bot takes over.'),'lobby',$id); tk_save($db,$g); $db->exec('COMMIT'); return ['left'=>true];
            default: throw new RuntimeException('Unknown game action.');
        }
        // Polling drives at most one bot turn. A persisted timer keeps all clients in sync.
        if($g['status']==='playing' && !$g['paused'] && tk_now()>=$g['botAt']) tk_bot_step($g);
        tk_save($db,$g); $db->exec('COMMIT'); return ['state'=>tk_view($g,$id)];
    } catch(Throwable $e) {
        try { $db->exec('ROLLBACK'); } catch(Throwable $ignored) {}
        throw $e;
    }
}
