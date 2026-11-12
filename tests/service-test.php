<?php
declare(strict_types=1);

require __DIR__ . '/../server/service.php';
$checks = 0;
function check(bool $condition, string $description): void {
    global $checks;
    if (!$condition) throw new RuntimeException('FAIL: ' . $description);
    $checks++;
}
function rejects(callable $operation, string $description): void {
    try { $operation(); } catch (Throwable $e) { check(true, $description); return; }
    check(false, $description);
}
function request(PDO $db, string $action, array $credentials = [], array $data = []): array {
    return tk_dispatch($db, array_merge($credentials, $data, ['action' => $action]));
}
function loadGame(PDO $db, string $room): array {
    $query = $db->prepare('SELECT state FROM rooms WHERE code=?');
    $query->execute([$room]);
    return json_decode($query->fetchColumn(), true, 512, JSON_THROW_ON_ERROR);
}

try {
    $db = new PDO('sqlite::memory:');
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $db->exec('CREATE TABLE rooms (code TEXT PRIMARY KEY, state TEXT NOT NULL, updated REAL NOT NULL)');
    foreach (['', str_repeat('x', 21), "bad\nname", "\xFF"] as $nickname) {
        rejects(fn() => request($db, 'create', [], ['nickname' => $nickname]), 'invalid nickname rejected');
    }
    foreach ([-1, 5, '1', 1.2] as $seat) rejects(fn() => request($db, 'create', [], ['nickname' => 'Host', 'seat' => $seat]), 'invalid seat rejected');
    rejects(fn() => request($db,'create',[],['nickname'=>'Host','ranked'=>true]),'local MAMP cannot create an untracked ranked table');
    $host = request($db, 'create', [], ['nickname' => 'Host', 'seat' => 4]);
    $hc = ['room' => $host['room'], 'token' => $host['token']];
    check(strlen($host['token']) === 48 && strlen($host['room']) === 5, 'opaque host token and short table code issued');
    check($host['state']['players'][0]['ready'] && $host['state']['hostId'] === $host['state']['youId'], 'host ready by default');
    $room = $host['room'];
    $guest = request($db, 'join', ['room' => strtolower($room)], ['nickname' => 'Guest', 'seat' => 0]);
    $gc = ['room' => $room, 'token' => $guest['token']];
    check($guest['token'] !== $host['token'] && !$guest['state']['players'][1]['ready'], 'guest receives own token and starts unready');
    rejects(fn() => request($db, 'join', ['room' => $room], ['nickname' => 'Other', 'seat' => 0]), 'occupied seat rejected');
    rejects(fn() => request($db, 'join', ['room' => $room], ['nickname' => 'gUESt', 'seat' => 1]), 'duplicate nickname rejected');
    rejects(fn() => request($db, 'state', ['room' => $room, 'token' => str_repeat('0', 48)]), 'forged token rejected');
    rejects(fn() => request($db, 'state', ['room' => $room]), 'missing token rejected');
    rejects(fn() => request($db, 'start', $gc), 'guest cannot start table');
    rejects(fn() => request($db, 'bot', $gc, ['seat' => 1]), 'guest cannot add bots');
    rejects(fn() => request($db, 'start', $hc), 'host cannot start before guest is ready');
    $public = request($db, 'lobby', ['room' => $room]);
    check(count($public['lobby']['players']) === 2, 'unauthenticated seat preview available');
    foreach ($public['lobby']['players'] as $p) check(array_keys($p) === ['name', 'seat', 'bot'], 'public lobby discloses only seating data');
    request($db, 'ready', $gc, ['ready' => true]);
    rejects(fn() => request($db, 'ready', $gc, ['ready' => 'yes']), 'ready accepts only boolean');
    foreach ([1, 2, 3] as $seat) request($db, 'bot', $hc, ['seat' => $seat]);
    $full = request($db, 'state', $hc)['state'];
    check(count($full['players']) === 5 && count(array_unique(array_column($full['players'], 'seat'))) === 5, 'five unique seats supported');
    rejects(fn() => request($db, 'join', ['room' => $room], ['nickname' => 'Sixth', 'seat' => 2]), 'sixth human rejected');
    rejects(fn() => request($db, 'bot', $hc, ['seat' => 2]), 'sixth bot rejected');
    rejects(fn() => request($db, 'seat', $gc, ['seat' => 4]), 'cannot move into occupied seat');
    rejects(fn() => request($db, 'remove_bot', $gc, ['seat' => 1]), 'guest cannot remove bots');
    rejects(fn() => request($db, 'remove_bot', $hc, ['seat' => 0]), 'host cannot remove human as bot');
    request($db, 'remove_bot', $hc, ['seat' => 1]);
    $moved = request($db, 'seat', $gc, ['seat' => 1])['state'];
    $self = array_values(array_filter($moved['players'], fn($p) => $p['id'] === $moved['youId']))[0];
    check($self['seat'] === 1 && !$self['ready'], 'seat change succeeds and resets guest readiness');
    request($db, 'bot', $hc, ['seat' => 0]);
    request($db, 'ready', $gc, ['ready' => true]);
    $started = request($db, 'start', $hc)['state'];
    check($started['status'] === 'playing' && $started['deckCount'] === 7, 'five-player match deals nine cards each, leaving seven');
    foreach ($started['players'] as $p) {
        check($p['handCount'] === 3 && count($p['up']) === 3 && $p['downCount'] === 3, 'each player has correct starting zones');
        check(!isset($p['tokenHash']) && !isset($p['down']), 'tokens and blind card faces are private');
        check($p['id'] === $started['youId'] ? count($p['hand']) === 3 : $p['hand'] === null, 'only requester can see their hand');
    }
    check(!isset($started['deck']) && !isset($started['hole']), 'shared state omits hidden card collections');
    rejects(fn() => request($db, 'join', ['room' => $room], ['nickname' => 'Late', 'seat' => 3]), 'no joining ongoing match');
    rejects(fn() => request($db, 'ready', $gc, ['ready' => false]), 'cannot ready during match');
    rejects(fn() => request($db, 'seat', $gc, ['seat' => 2]), 'cannot move during match');
    rejects(fn() => request($db, 'replace_bot', $gc, ['seat' => 4]), 'guest cannot replace player');
    rejects(fn() => request($db, 'replace_bot', $hc, ['seat' => 4]), 'host cannot replace themselves');
    rejects(fn() => request($db, 'replace_bot', $hc, ['seat' => 1]), 'connected human cannot be replaced');
    $before = loadGame($db, $room);
    rejects(fn() => request($db, 'play', $hc, ['source' => 'hand', 'cards' => ['fake']]), 'invalid play rejected');
    $after = loadGame($db, $room);
    check($before === $after, 'failed mutation rolls back complete game state');
    $guestId = $guest['state']['youId'];
    $game = loadGame($db, $room);
    foreach ($game['players'] as &$p) if ($p['id'] === $guestId) $p['lastSeen'] = tk_now() - 31;
    unset($p);
    tk_save($db, $game);
    $takenOver = request($db, 'replace_bot', $hc, ['seat' => 1])['state'];
    $replaced = array_values(array_filter($takenOver['players'], fn($p) => $p['id'] === $guestId))[0];
    check($replaced['bot'] === true && $replaced['handCount'] === 3, 'host may replace disconnected guest without losing cards');
    rejects(fn() => request($db, 'state', $gc), 'replaced guest token invalidated');
    $game = loadGame($db, $room);
    $game['status'] = 'finished';
    $game['results'] = array_column($game['players'], 'id');
    tk_save($db, $game);
    $seatsBefore = array_column($game['players'], 'seat', 'id');
    $rematch = request($db, 'rematch', $hc)['state'];
    check($rematch['status'] === 'lobby' && $rematch['deckCount'] === 0 && $rematch['pile'] === [], 'rematch returns to clean lobby');
    check(array_column($rematch['players'], 'seat', 'id') === $seatsBefore, 'rematch preserves seats');
    foreach ($rematch['players'] as $p) check($p['handCount'] === 0 && $p['downCount'] === 0 && $p['up'] === [] && $p['ready'], 'rematch clears cards and readies bots plus host');
    $host2 = request($db, 'create', [], ['nickname' => 'Other host']);
    $guest2 = request($db, 'join', ['room' => $host2['room']], ['nickname' => 'Successor', 'seat' => 1]);
    request($db, 'leave', ['room' => $host2['room'], 'token' => $host2['token']]);
    $successor = request($db, 'state', ['room' => $host2['room'], 'token' => $guest2['token']])['state'];
    check($successor['hostId'] === $successor['youId'] && count($successor['players']) === 1, 'host leaving lobby transfers host to remaining human');
    rejects(fn() => request($db, 'state', ['room' => $host2['room'], 'token' => $host2['token']]), 'leaving lobby invalidates old token');
    $host3 = request($db, 'create', [], ['nickname' => 'Departing host']);
    $h3c = ['room' => $host3['room'], 'token' => $host3['token']];
    request($db, 'bot', $h3c, ['seat' => 1]);
    request($db, 'leave', $h3c);
    $newHost = request($db, 'join', ['room' => $host3['room']], ['nickname' => 'New host', 'seat' => 0]);
    check($newHost['state']['hostId'] === $newHost['state']['youId'], 'new human inherits host at a table left with only bots');
    $newStart = request($db, 'start', ['room' => $host3['room'], 'token' => $newHost['token']]);
    check($newStart['state']['status'] === 'playing', 'new inherited host is ready and can start');
    foreach ([
        ['mode'=>'unknown'], ['mode'=>'expanded','maxPlayers'=>8,'decks'=>2],
        ['mode'=>'expanded','maxPlayers'=>13,'decks'=>3], ['mode'=>'expanded','maxPlayers'=>'12','decks'=>3],
        ['mode'=>'expanded','maxPlayers'=>12,'decks'=>2], ['mode'=>'expanded','maxPlayers'=>9,'decks'=>1],
        ['mode'=>'expanded','maxPlayers'=>9,'decks'=>5], ['mode'=>'expanded','maxPlayers'=>9,'decks'=>'2'],
        ['mode'=>'standard','maxPlayers'=>12,'decks'=>3], ['mode'=>'standard','maxPlayers'=>5,'decks'=>2],
    ] as $config) rejects(fn()=>request($db,'create',[],array_merge(['nickname'=>'Bad config'],$config)), 'invalid or insufficient-card configuration rejected');
    $settings=['mode'=>'expanded','maxPlayers'=>12,'decks'=>3];
    $large=request($db,'create',[],array_merge(['nickname'=>'Māra','seat'=>11],$settings));
    $lc=['room'=>$large['room'],'token'=>$large['token']];
    check($large['state']['settings']===$settings && $large['state']['players'][0]['seat']===11, 'host creates expanded table and chooses twelfth seat');
    $preview=request($db,'lobby',['room'=>$large['room']])['lobby'];
    check($preview['settings']===$settings, 'join preview exposes room capacity and deck choice');
    $largeGuest=request($db,'join',['room'=>$large['room']],['nickname'=>'Guest twelve','seat'=>10]);
    $lgc=['room'=>$large['room'],'token'=>$largeGuest['token']];
    check($largeGuest['state']['settings']===$settings, 'joiner inherits host settings');
    rejects(fn()=>request($db,'seat',$lc,['seat'=>12]), 'expanded host cannot move past configured seat capacity');
    rejects(fn()=>request($db,'join',['room'=>$large['room']],['nickname'=>'Outside','seat'=>12]), 'expanded guest cannot choose nonexistent thirteenth seat');
    rejects(fn()=>request($db,'bot',$lgc,['seat'=>0]), 'expanded guests cannot add bots');
    for($seat=0;$seat<10;$seat++) request($db,'bot',$lc,['seat'=>$seat]);
    $largeLobby=request($db,'state',$lc)['state'];
    check(count($largeLobby['players'])===12 && count(array_unique(array_column($largeLobby['players'],'name')))===12, 'twelve players including bots have unique names despite host-name collision');
    rejects(fn()=>request($db,'bot',$lc,['seat'=>0]), 'thirteenth bot rejected');
    rejects(fn()=>request($db,'join',['room'=>$large['room']],['nickname'=>'Thirteenth','seat'=>0]), 'thirteenth human rejected');
    request($db,'ready',$lgc,['ready'=>true]);
    $largeStart=request($db,'start',$lc)['state'];
    check($largeStart['status']==='playing' && $largeStart['deckCount']===48, 'twelve players deal108 from three decks, leaving48');
    foreach($largeStart['players'] as $p) check($p['handCount']===3 && count($p['up'])===3 && $p['downCount']===3 && ($p['id']===$largeStart['youId'] || $p['hand']===null), 'twelve-player deal keeps zones and privacy correct');
    $persisted=loadGame($db,$large['room']);$all=$persisted['deck'];
    foreach($persisted['players'] as $p) $all=array_merge($all,$p['hand'],$p['up'],$p['down']);
    check(count($all)===156 && count(array_unique(array_column($all,'id')))===156, 'expanded service stores every physical card exactly once');
    rejects(fn()=>request($db,'create',[],array_merge(['nickname'=>'Bad initial seat','seat'=>9],['mode'=>'expanded','maxPlayers'=>9,'decks'=>2])), 'initial seat validated against chosen capacity');
    $persisted['status']='finished';$persisted['results']=array_column($persisted['players'],'id');tk_save($db,$persisted);
    $largeRematch=request($db,'rematch',$lc)['state'];
    check($largeRematch['status']==='lobby' && $largeRematch['settings']===$settings && count($largeRematch['players'])===12, 'rematch retains expanded capacity and deck settings');
    // Sending create-only settings during normal commands cannot change a host's table.
    $unchanged=request($db,'state',$lc,['mode'=>'standard','maxPlayers'=>5,'decks'=>1])['state'];
    check($unchanged['settings']===$settings, 'settings remain immutable after creation');
    $two=request($db,'create',[],['nickname'=>'Two decks','mode'=>'expanded','maxPlayers'=>11,'decks'=>2,'seat'=>10]);
    $tc=['room'=>$two['room'],'token'=>$two['token']];
    for($seat=0;$seat<10;$seat++)request($db,'bot',$tc,['seat'=>$seat]);
    check(request($db,'start',$tc)['state']['deckCount']===5,'eleven-player two-deck match deals99 and leaves5');
    $legacy=request($db,'create',[],['nickname'=>'Legacy host']);$legacyGame=loadGame($db,$legacy['room']);unset($legacyGame['settings']);tk_save($db,$legacyGame);
    $legacyCredentials=['room'=>$legacy['room'],'token'=>$legacy['token']];
    $default=['mode'=>'standard','maxPlayers'=>5,'decks'=>1];
    check(request($db,'state',$legacyCredentials)['state']['settings']===$default && request($db,'lobby',['room'=>$legacy['room']])['lobby']['settings']===$default, 'legacy table settings default in private and public views');
    rejects(fn()=>request($db,'bot',$legacyCredentials,['seat'=>5]),'legacy tables retain original five-seat limit');
    $kickHost=request($db,'create',[],['nickname'=>'Kick host','seat'=>4]);$kh=['room'=>$kickHost['room'],'token'=>$kickHost['token']];
    $kickGuest=request($db,'join',['room'=>$kh['room']],['nickname'=>'Kick guest','seat'=>1]);$kg=['room'=>$kh['room'],'token'=>$kickGuest['token']];$target=$kickGuest['state']['youId'];
    $withBot=request($db,'bot',$kh,['seat'=>2])['state'];$botId=$withBot['players'][2]['id'];$before=loadGame($db,$kh['room']);
    rejects(fn()=>request($db,'kick',$kg,['playerId'=>$kickHost['state']['youId']]),'guest cannot kick the host');
    foreach([null,1,[], '',$target.'x',str_repeat('f',24),$kickHost['state']['youId'],$botId] as $playerId) {
        rejects(fn()=>request($db,'kick',$kh,['playerId'=>$playerId]),'invalid self bot or missing kick target rejected');
        check(loadGame($db,$kh['room'])===$before,'rejected kick rolls back heartbeat and state');
    }
    $kicked=request($db,'kick',$kh,['playerId'=>$target])['state'];
    check(count($kicked['players'])===2 && !in_array($target,array_column($kicked['players'],'id'),true),'lobby kick frees target seat');
    check($kicked['hostId']===$kickHost['state']['youId'] && end($kicked['events'])['text']==='Kick host kicked Kick guest from the table.','kick event identifies host and removed player');
    rejects(fn()=>request($db,'state',$kg),'lobby kicked key cannot reconnect');
    $replacement=request($db,'join',['room'=>$kh['room']],['nickname'=>'Replacement','seat'=>1]);$before=loadGame($db,$kh['room']);
    rejects(fn()=>request($db,'kick',$kh,['playerId'=>$target]),'stale ID cannot kick replacement occupying old seat');
    check(loadGame($db,$kh['room'])===$before,'stale kick leaves replacement untouched');
    foreach([false,true] as $paused) foreach([false,true] as $offline) {
        $h=request($db,'create',[],['nickname'=>'Round host']);$ha=['room'=>$h['room'],'token'=>$h['token']];
        $j=request($db,'join',['room'=>$h['room']],['nickname'=>'Round guest','seat'=>1]);$ja=['room'=>$h['room'],'token'=>$j['token']];
        request($db,'ready',$ja,['ready'=>true]);request($db,'start',$ha);$g=loadGame($db,$h['room']);
        $g['paused']=$paused;$g['turnId']=$j['state']['youId'];$g['botAt']=0;$g['players'][1]['lastSeen']=$offline?0:tk_now();
        $playerBefore=$g['players'][1];$beforeCards=[$g['deck'],$g['pile'],$g['hole'],array_map(fn($p)=>[$p['hand'],$p['up'],$p['down']],$g['players'])];tk_save($db,$g);$beforeTime=tk_now();
        $view=request($db,'kick',$ha,['playerId'=>$j['state']['youId']])['state'];$after=loadGame($db,$h['room']);
        $expected=$playerBefore;$expected['bot']=true;$expected['tokenHash']='';$expected['ready']=true;
        check($after['players'][1]===$expected,'kick converts online or offline human into bot without changing cards and stats');
        check([$after['deck'],$after['pile'],$after['hole'],array_map(fn($p)=>[$p['hand'],$p['up'],$p['down']],$after['players'])]===$beforeCards,'kick conserves every card and its zone');
        check($after['turnId']===$j['state']['youId'] && $after['paused']===$paused && $after['botAt']>=$beforeTime+0.85,'kick preserves turn and pause and defers bot action');
        check($view['players'][1]['hand']===null,'kick response does not reveal target hand');
        rejects(fn()=>request($db,'state',$ja),'round kicked key is revoked immediately');
        $before=loadGame($db,$h['room']);rejects(fn()=>request($db,'kick',$ha,['playerId'=>$j['state']['youId']]),'second kick cannot target existing bot');
        check(loadGame($db,$h['room'])===$before,'duplicate kick leaves state intact');
        if($paused){$after['botAt']=0;tk_save($db,$after);request($db,'state',$ha);$frozen=loadGame($db,$h['room']);check($frozen['players'][1]===$expected && $frozen['turnId']===$j['state']['youId'],'paused kicked player remains frozen on later polls');}
    }
    $h=request($db,'create',[],['nickname'=>'Finished host']);$ha=['room'=>$h['room'],'token'=>$h['token']];
    $j=request($db,'join',['room'=>$h['room']],['nickname'=>'Finished guest','seat'=>1]);$ja=['room'=>$h['room'],'token'=>$j['token']];
    request($db,'ready',$ja,['ready'=>true]);request($db,'start',$ha);$g=loadGame($db,$h['room']);$g['status']='finished';$g['turnId']=null;$g['results']=array_column($g['players'],'id');
    foreach($g['players'] as $i=>&$p)$p['finish']=$i+1;unset($p);tk_record_scores($g);tk_save($db,$g);$scores=$g['scoreboard'];$scores[$j['state']['youId']]['bot']=true;
    $view=request($db,'kick',$ha,['playerId'=>$j['state']['youId']])['state'];$after=loadGame($db,$h['room']);
    check($after['results']===$g['results'] && $after['scoreboard']===$scores && $after['players'][1]['bot'],'finished kick retains standings scores and player identity');
    rejects(fn()=>request($db,'state',$ja),'finished kicked player cannot reconnect');
    check(request($db,'rematch',$ha)['state']['players'][1]['bot'],'kicked seat remains bot for rematch');
    echo 'PASS: ' . $checks . ' service assertions (standard/expanded settings, seats, authorization, privacy, rollback, reconnect takeover, rematch).' . PHP_EOL;
} catch (Throwable $e) {
    fwrite(STDERR, $e->getMessage() . PHP_EOL . $e->getTraceAsString() . PHP_EOL);
    exit(1);
}
