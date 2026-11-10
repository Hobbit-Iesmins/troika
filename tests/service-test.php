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
    echo 'PASS: ' . $checks . ' service assertions (seats, authorization, privacy, rollback, reconnect takeover, rematch).' . PHP_EOL;
} catch (Throwable $e) {
    fwrite(STDERR, $e->getMessage() . PHP_EOL . $e->getTraceAsString() . PHP_EOL);
    exit(1);
}
