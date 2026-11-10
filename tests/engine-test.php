<?php
declare(strict_types=1);

require __DIR__ . '/../server/engine.php';

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
function card(int $rank, string $suit = 'S'): array {
    static $counter = 0;
    return ['id' => 'test-card-' . (++$counter), 'rank' => $rank, 'suit' => $suit];
}
function fixture(): array {
    $a = tk_new_player('Ada', 0);
    $b = tk_new_player('Boris', 1);
    $b['ready'] = true;
    $g = tk_new_game('TEST01', $a);
    $g['players'][] = $b;
    tk_start($g);
    $g['deck'] = [];
    $g['pile'] = [];
    $g['hole'] = [];
    $g['results'] = [];
    $g['openingRank'] = null;
    $g['turnId'] = $a['id'];
    foreach ($g['players'] as &$p) {
        $p['hand'] = [card(3), card(14)];
        $p['up'] = [];
        $p['down'] = [];
        $p['finish'] = null;
    }
    unset($p);
    return $g;
}
function playFirst(array &$g, string $source = 'hand'): void {
    tk_play($g, $g['players'][0]['id'], $source, [$g['players'][0][$source][0]['id']]);
}
function allCards(array $g): array {
    $cards = array_merge($g['deck'], $g['pile'], $g['hole']);
    foreach ($g['players'] as $p) $cards = array_merge($cards, $p['hand'], $p['up'], $p['down']);
    return $cards;
}

try {
    foreach ([2, 5, 7, 9, 11, 12, 13, 14] as $rank) {
        check(tk_can_play(card($rank), [card($rank)]), 'equal rank is playable');
    }
    check(!tk_can_play(card(12), [card(13)]), 'queen cannot cover king');
    check(tk_can_play(card(14), [card(13)]), 'ace can cover king');
    check(tk_can_play(card(6), [card(14)]), 'six can cover ace');
    check(tk_can_play(card(10), [card(14)]), 'ten can cover ace');
    check(tk_can_play(card(2), [card(14), card(6)]), 'six resets the required rank');
    check(tk_can_play(card(2), []), 'any rank may lead an empty pile');

    $g = fixture();
    $g['pile'] = [card(14)];
    $g['players'][0]['hand'][0] = card(6);
    playFirst($g);
    check(count($g['pile']) === 2 && end($g['pile'])['rank'] === 6, 'six stays in playing pile');
    check($g['turnId'] === $g['players'][1]['id'], 'six passes the turn');
    check(end($g['events'])['cards'] === [['rank'=>6,'suit'=>'S']], 'reset event records the actual played card face');

    $g = fixture();
    $g['pile'] = [card(14), card(6), card(13)];
    $g['players'][0]['hand'][0] = card(10);
    playFirst($g);
    check(count($g['pile']) === 0 && count($g['hole']) === 4, 'ten burns the complete pile including itself');
    check($g['turnId'] === $g['players'][0]['id'], 'ten grants another turn');
    check(end($g['events'])['cards'] === [['rank'=>10,'suit'=>'S']], 'ten event retains the played face after the pile burns');

    $g = fixture();
    $g['pile'] = [card(2), card(13), card(13, 'H'), card(13, 'D')];
    $g['players'][0]['hand'][0] = card(13, 'C');
    playFirst($g);
    check(count($g['pile']) === 0 && count($g['hole']) === 5, 'four equal cards in a row burn the complete pile');
    check($g['turnId'] === $g['players'][0]['id'], 'fourth equal card grants another turn');
    check(end($g['events'])['cards'] === [['rank'=>13,'suit'=>'C']], 'four-card burn records only the new played card and its suit');

    $g = fixture();
    $g['pile'] = [card(13), card(13), card(6), card(13)];
    $g['players'][0]['hand'][0] = card(13);
    playFirst($g);
    check(count($g['pile']) === 5 && count($g['hole']) === 0, 'separated matching ranks do not burn');

    $g = fixture();
    $g['players'][0]['hand'] = [card(4, 'H'), card(4, 'D'), card(14)];
    tk_play($g, $g['players'][0]['id'], 'hand', array_column(array_slice($g['players'][0]['hand'], 0, 2), 'id'));
    check(count($g['pile']) === 2 && count($g['players'][0]['hand']) === 1, 'multiple equal hand cards form one turn');
    check(end($g['events'])['cards'] === [['rank'=>4,'suit'=>'H'],['rank'=>4,'suit'=>'D']], 'group event preserves each played suit without identifiers');
    check(tk_view($g,$g['players'][1]['id'])['events'] === $g['events'], 'opponent sees actual public played-card event faces');
    $g = fixture();
    rejects(function () use (&$g) { tk_play($g, $g['players'][0]['id'], 'hand', array_column($g['players'][0]['hand'], 'id')); }, 'mixed-rank move rejected');

    $g = fixture();
    $g['openingRank'] = 3;
    rejects(function () use (&$g) { tk_play($g, $g['players'][0]['id'], 'hand', [$g['players'][0]['hand'][1]['id']]); }, 'opening move must use the lowest hand rank');
    rejects(function () use (&$g) { tk_pickup($g, $g['players'][0]['id']); }, 'opening move cannot be skipped by pickup');
    playFirst($g);
    check($g['openingRank'] === null, 'lowest opening clears first-move restriction');

    $g = fixture();
    $g['deck'] = [card(4), card(5), card(7), card(8)];
    $g['players'][0]['hand'] = [card(3)];
    playFirst($g);
    check(count($g['players'][0]['hand']) === 3 && count($g['deck']) === 1, 'hand draws back to three');
    $g = fixture();
    $g['deck'] = [card(4)];
    $g['players'][0]['hand'] = [card(3)];
    playFirst($g);
    check(count($g['players'][0]['hand']) === 1 && count($g['deck']) === 0, 'short deck draws only available cards');

    $g = fixture();
    $g['players'][0]['up'] = [card(2), card(7), card(12)];
    rejects(function () use (&$g) { playFirst($g, 'up'); }, 'cannot use face-up while hand has cards');
    $g['players'][0]['hand'] = [];
    $g['deck'] = [card(9)];
    rejects(function () use (&$g) { playFirst($g, 'up'); }, 'cannot use face-up while draw deck remains');
    $g['deck'] = [];
    $g['players'][0]['hand'] = [];
    $g['pile'] = [card(13), card(13)];
    $attemptId = $g['players'][0]['up'][0]['id'];
    playFirst($g, 'up');
    check(count($g['players'][0]['up']) === 2, 'failed face-up attempt leaves other face-up cards');
    check(count($g['players'][0]['hand']) === 3 && count($g['pile']) === 0, 'failed face-up attempt picks up only attempt plus pile');
    check(in_array($attemptId, array_column($g['players'][0]['hand'], 'id'), true), 'attempted face-up card enters hand');
    check($g['turnId'] === $g['players'][1]['id'], 'failed face-up attempt ends turn');
    check(end($g['events'])['cards'] === [['rank'=>2,'suit'=>'S']], 'failed face-up event records only the attempted card');

    $g = fixture();
    $g['players'][0]['hand'] = [];
    $g['players'][0]['up'] = [card(2), card(2), card(7)];
    $g['pile'] = [card(13)];
    tk_play($g, $g['players'][0]['id'], 'up', array_column(array_slice($g['players'][0]['up'], 0, 2), 'id'));
    check(count($g['players'][0]['up']) === 1 && $g['players'][0]['up'][0]['rank'] === 7, 'multiple failed matching face-up attempts leave unselected card');
    check(count($g['players'][0]['hand']) === 3 && count($g['pile']) === 0, 'multiple failed matching face-up attempts take selected group plus pile');
    check(count(end($g['events'])['cards']) === 2, 'failed face-up group exposes exactly its two attempted cards');

    $g = fixture();
    $g['players'][0]['hand'] = [];
    $g['players'][0]['down'] = [card(2), card(14), card(6)];
    $g['pile'] = [card(13)];
    playFirst($g, 'down');
    check(count($g['players'][0]['down']) === 2 && count($g['players'][0]['hand']) === 2, 'failed blind card takes itself and pile');
    check(end($g['events'])['cards'] === [['rank'=>2,'suit'=>'S']], 'failed blind attempt reveals only its attempted face, excluding two remaining blind cards');
    $g = fixture();
    $g['players'][0]['hand'] = [];
    $g['players'][0]['down'] = [card(14), card(14), card(6)];
    rejects(function () use (&$g) { tk_play($g, $g['players'][0]['id'], 'down', array_column(array_slice($g['players'][0]['down'], 0, 2), 'id')); }, 'only one blind card may be attempted');
    $g['pile'] = [card(13)];
    playFirst($g, 'down');
    check(count($g['players'][0]['down']) === 2 && count($g['players'][0]['hand']) === 0 && count($g['pile']) === 2, 'legal blind card plays directly');
    check(end($g['events'])['cards'] === [['rank'=>14,'suit'=>'S']], 'successful blind attempt records its actual public face');

    $g = fixture();
    $g['pile'] = [card(8), card(9)];
    tk_pickup($g, $g['players'][0]['id']);
    check(count($g['players'][0]['hand']) === 4 && count($g['pile']) === 0, 'pickup takes full pile');
    check($g['turnId'] === $g['players'][1]['id'], 'pickup ends turn');
    check(end($g['events'])['cards'] === [], 'ordinary pickup does not expose unplayed hand cards');
    $g = fixture();
    rejects(function () use (&$g) { tk_play($g, $g['players'][1]['id'], 'hand', [$g['players'][1]['hand'][0]['id']]); }, 'out-of-turn move rejected');
    rejects(function () use (&$g) { tk_play($g, $g['players'][0]['id'], 'hand', ['fake-card']); }, 'unowned card rejected');
    $duplicate = $g['players'][0]['hand'][0]['id'];
    rejects(function () use (&$g, $duplicate) { tk_play($g, $g['players'][0]['id'], 'hand', [$duplicate, $duplicate]); }, 'duplicate card id rejected');

    $g = fixture();
    $g['players'][0]['hand'] = [card(2)];
    $g['players'][1]['hand'] = [card(14)];
    playFirst($g);
    check($g['status'] === 'finished', 'last opponent remaining ends match');
    check($g['results'][0] === $g['players'][0]['id'] && count($g['results']) === 2, 'finish order includes winner and last player');

    $g = fixture();
    $third = tk_new_player('Cora', 2, true);
    $third['hand'] = [card(3), card(14)];
    $g['players'][] = $third;
    $g['players'][0]['hand'] = [card(10)];
    $g['pile'] = [card(14)];
    playFirst($g);
    check($g['status'] === 'playing' && $g['players'][0]['finish'] === 1, 'burning final card finishes player while others continue');
    check($g['turnId'] === $g['players'][1]['id'], 'finished player cannot retain an extra turn');

    $g = fixture();
    check($g['events'][0]['cards'] === [], 'deal announcement does not predict a suit or expose undealt private card faces');
    $legacyEvent = ['id'=>0,'text'=>'Existing saved-table event','type'=>'lobby','playerId'=>null];
    array_unshift($g['events'],$legacyEvent);
    check(tk_view($g,$g['players'][0]['id'])['events'][0] === $legacyEvent, 'saved events without card metadata remain compatible');
    $g['players'][0]['down'] = [card(7), card(13)];
    $g['players'][1]['down'] = [card(5)];
    $view = tk_view($g, $g['players'][0]['id']);
    check($view['players'][0]['hand'] === $g['players'][0]['hand'], 'own hand visible');
    check(empty($view['players'][1]['hand']), 'opponent hand concealed');
    check(!array_key_exists('deck', $view) && !array_key_exists('hole', $view), 'deck and hole identities omitted');
    foreach ($view['players'] as $p) {
        check(!array_key_exists('down', $p) && !array_key_exists('tokenHash', $p), 'blind faces and token hashes omitted');
    }
    check(count($view['players'][0]['downSlots']) === 2, 'opaque face-down slots available');

    foreach ([2, 3, 4, 5] as $players) {
        for ($match = 0; $match < 8; $match++) {
            $first = tk_new_player('Bot 0', 0, true);
            $g = tk_new_game('SIM' . $players . $match, $first);
            for ($i = 1; $i < $players; $i++) $g['players'][] = tk_new_player('Bot ' . $i, $i, true);
            tk_start($g);
            $ids = array_column(allCards($g), 'id');
            sort($ids);
            check(count($ids) === 52 && count(array_unique($ids)) === 52, 'deal conserves one complete deck');
            $lowest = 15;
            $starter = null;
            foreach ($g['players'] as $p) foreach ($p['hand'] as $c) if ($c['rank'] < $lowest) { $lowest = $c['rank']; $starter = $p['id']; }
            check($g['openingRank'] === $lowest && $g['turnId'] === $starter, 'lowest hand rank starts, ties by seat');
            $steps = 0;
            while ($g['status'] === 'playing' && $steps < 10000) {
                tk_bot_step($g);
                $after = array_column(allCards($g), 'id');
                sort($after);
                check($ids === $after, 'every bot move conserves all 52 unique cards');
                $steps++;
            }
            check($g['status'] === 'finished', 'bot match terminates with ' . $players . ' players');
            check(count($g['results']) === $players && count(array_unique($g['results'])) === $players, 'all players receive unique finishing places');
        }
    }
    echo 'PASS: ' . $checks . ' assertions; 32 complete bot matches (2–5 players).' . PHP_EOL;
} catch (Throwable $e) {
    fwrite(STDERR, $e->getMessage() . PHP_EOL . $e->getTraceAsString() . PHP_EOL);
    exit(1);
}
