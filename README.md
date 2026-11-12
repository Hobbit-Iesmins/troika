# Troika

A card game for 2–5 players in Standard mode, or up to 12 players in Expanded mode, with practice bots, private hands, selectable seats, and switchable table themes. Run it on your local network with MAMP, or host it online with Vercel and PostgreSQL. Casual players do not need accounts. Online accounts unlock ranked games, profiles, match history, and the Elo ladder.

See [Accounts and rankings](docs/ACCOUNTS.md) for registration, private owner setup, password recovery, and rating rules.

## Choose how to host

| Host | Runtime and storage | Players join with |
| --- | --- | --- |
| Local MAMP | PHP 8 + PDO SQLite; no Node.js, Composer, MySQL, or internet service needed | Your private IP and Apache port on the same local network |
| Vercel | Node.js 22 + a separate PostgreSQL database, such as Neon | Your deployed HTTPS invite link from any network |

**For Vercel, follow [the deployment guide](docs/VERCEL.md).** Import this repository at its root, connect PostgreSQL, and set the server-side database environment variable before playing. The cloud build publishes the interface and a Node API; the PHP version remains available for local hosting.

## Run with MAMP

1. Extract the `troika` folder into MAMP’s document root. Typical locations are `/Applications/MAMP/htdocs/troika` on macOS and `C:\MAMP\htdocs\troika` on Windows. You can also choose `troika` as a dedicated document root in MAMP.
2. Select PHP 8.0 or newer and start Apache. PHP’s PDO SQLite extension must be enabled; it is normally included in MAMP. MySQL is not required.
3. Open `http://localhost:8888/troika/` on the host computer, replacing `8888` with the Apache port shown in MAMP. If `troika` itself is your document root, omit `/troika/`.
4. Enter a nickname, choose Standard or Expanded mode, and pick your seat before creating a table. Add bots to test alone, or invite friends to the same table using the room code.
5. Other players open `http://YOUR-PRIVATE-IP:PORT/troika/` on the same network. For example: `http://192.168.1.50:8888/troika/`. They enter a nickname and the room code, then choose an open seat.
6. When everyone is ready, the host starts the game.

Use the Apache port, not MAMP’s MySQL port. `localhost` only points to the device opening the page; friends must use the host’s private IP. Keep MAMP running and the host computer awake. Allow inbound connections to Apache’s port in the host firewall. Some lab Wi-Fi networks isolate devices; if so, ask the lab administrator to permit local connections or use an approved shared network. Router port forwarding is not needed for players on the same LAN.

For a quick PHP CLI launch outside MAMP, run `php -S 0.0.0.0:8080 -t .` from the `troika` folder and visit `http://localhost:8080/`. This is a development server for local testing.

## Choose a table mode

Before creating a table, the host chooses:

| Mode | Table capacity | Decks |
| --- | --- | --- |
| Standard | 5 seats | One 52-card deck |
| Expanded | 9, 10, 11, or 12 seats | 2, 3, or 4 decks |

You do not need to fill every seat: a round can start with two ready players, and bots can occupy open seats. Every player still receives nine cards. A 12-seat table needs at least three decks because its deal uses 108 cards; two decks contain only 104. Selecting 12 seats raises the deck selection to three if needed and disables the two-deck option.

The selected mode, capacity, and deck count stay fixed for the table and its rematches. Existing saved tables continue in Standard mode. Extra decks include repeated rank-and-suit faces, with each physical card tracked separately. Four-card burns follow the selected suit rule; play at most four matching cards in one action, then take any earned extra turn.

## Playing

- Each player receives three face-down cards, three face-up cards, and three cards in hand. There is no pre-game swapping.
- The player holding the lowest hand card starts by playing that rank. Ties use seat order. Suits never affect strength; ordinary ranks run from 2 up to ace.
- On your turn, play one card or up to four cards of the same rank. The rank must be equal to or higher than the top card, except for the two special ranks below. You may pick up the playing pile instead and end your turn.
- **6 — reset:** playable on anything. The next player may play any rank.
- **10 — burn:** playable on anything. The playing pile goes into the hole and you get another turn.
- **Four-card burn:** by default, any four consecutive matching ranks burn. With All four suits, the uninterrupted same-rank run must include ♠ ♥ ♦ ♣. The entire pile goes into the hole. The player completing the run gets another turn. The four cards may have been played across several turns.
- After playing from your hand, draw back to at least three cards while cards remain in the draw deck.
- Once the draw deck and your hand are empty, play your face-up cards directly. If your attempted face-up card is too low, take only that attempted card plus the playing pile into your hand. Other face-up cards stay in place. Multiple attempted cards must all have the same rank.
- Once your hand and face-up cards are gone, choose one face-down card without looking. If it can be played, it goes onto the pile; otherwise take it and the pile into your hand.
- After a pickup, empty your hand before returning to your table cards.
- Get rid of all your cards to finish. Play continues until one player remains; that player finishes last.

## Quick card play

Click cards once to select them, then use **Play card** as before. You can also double-click a playable card in your hand to play that specific card immediately. If other hand cards have the same rank, a small warning lets you play only the clicked card, play the matching group (up to four), or cancel. Suits do not affect the match. Face-up and blind cards still use the normal selection and Play button.

Selecting a hand card with matching ranks also shows **Play N × rank** between Play card and Pick up pile. For example, select one of three sevens and choose **Play 3 × 7** to play all three immediately. Expanded hands with more than four copies offer four at a time, keeping your selected cards in the group. This shortcut is available only on your turn; jump-ins still use exactly one card.

## Optional jump-in burns

Enable **Jump-in burns** before creating either a Standard or Expanded table. It is off by default and stays fixed for the table and its rematches.

When it is enabled, an unfinished player may play **one card out of turn** if that card completes a valid four-card burn of the rank currently on top. The selected suit rule still applies: Any four needs the fourth matching rank; All four suits needs the missing suit that completes ♠ ♥ ♦ ♣ in that uninterrupted rank run. The pile burns and the jumping player takes the next turn, unless that play finishes them.

Eligible cards glow gold. Select one and click **Jump in & burn**, or double-click an eligible hand card to jump immediately.

Use a card from your current phase: your hand, or a face-up table card once your hand and draw deck are empty. Blind cards cannot jump in, and a 10 cannot be used as an unrelated out-of-turn burn. Jumping in is unavailable before the opening card or while paused. If several players react, the server accepts the first valid action; a stale attempt leaves the cards untouched. Bots follow these same rules.

## Scoreboard, replay, and pause

**Scoreboard** tracks completed rounds at this table: rounds played, wins, last-place finishes, burns, and pile pickups. Totals stay across rematches, including rows for players who leave. Current-round card statistics remain separate until the round finishes. Existing saved games start collecting scores from completed rounds after the update; earlier scores are not invented.

**Replay** shows the latest move's public cards, the pile before and after, and the reason for a burn or extra turn. It does not reveal another player's hand, the draw deck, or blind cards taken into a hand after a failed attempt.

The host can **Pause** an active round and **Resume** it. Pause freezes plays, pickups, jump-ins, and bot turns. Players can still reconnect, leave, read Table Talk, inspect the scoreboard, and review the last move while the table is paused.

Once the whole round finishes, each player can choose **Reveal my blind cards** in their hand panel. This privately shows the three original blind cards from their deal, including cards they already played. It sends no public message and does not change the game. Hide them again with the same button; a rematch resets the reveal. Rounds dealt before this feature can show only blind cards still remaining at the end.

## Table layout and Table Talk

The table adapts to the available browser width and height, including when zooming to 130–150%. During a round, decorative content gives way to the table and hand controls. Large hands scroll within the hand area instead of pushing the play buttons down the page. On narrow screens, Table Talk is available from the speech-bubble button in the top bar.

Table Talk shows public plays with rank and suit, including grouped plays and cards that burn the pile. A failed blind attempt only reports the pickup, keeping that card private in Table Talk, replay, and pile history. Hearts and diamonds use red symbols. Older saved events keep their original text without guessing a suit.

Hover over or focus the middle playing pile to inspect the last ten public cards; touch users can open the same history by tapping the pile. This history survives burns and pickups and clears for a new round. Failed blind attempts are excluded. Your turn has a red pulsing hand panel and an explicit turn banner; reduced-motion settings use a steady highlight.

To update an existing MAMP installation, replace the game files in the same folder and refresh the browser. The versioned CSS and JavaScript links load the updated interface. Matches remain in the separate SQLite storage folder.

## Local storage and reconnecting

Your browser stores a private player token so refreshing or reopening the same page in the same browser restores your seat. Avoid clearing site data during a game. Each human should use their own device or a separate browser profile; opening another tab in the same browser continues the same player.

If someone disconnects, their seat and cards stay in the match so they can reconnect. In casual games, the host can assign a bot after 30 seconds offline. Ranked players get a five-minute reconnect window, followed by automatic bot takeover and the ranked abandonment policy. That takeover ends the original player’s access to the seat. Leaving during a round also gives the seat to a bot so the game can continue.

The host can also open **Players → Kick → Confirm kick** at any time, even while a player is connected or the table is paused. In the lobby, kicking frees the seat. During or after a round, a bot takes the seat while cards, turn order, and results stay intact. The kicked player's saved seat key stops working immediately. Guests cannot kick anyone, and the host cannot kick themselves. During active ranked rounds, the host must also be an administrator; kicks preserve the ranked result and are audited. See [ranked abandonment rules](docs/ACCOUNTS.md#ranked-abandonment-policy) for warnings and cooldowns.

For the MAMP runtime, shared matches are stored in SQLite outside the website folder, under PHP’s temporary directory in a folder named `troika-<installation hash>`. Apache’s PHP process needs permission to create and write there. For a more permanent location, set the `TROIKA_DATA_DIR` environment variable to a writable folder outside the web document root. Old tables are cleaned up after seven days when a new table is created; clearing the temporary directory also removes saved matches.

For local play, keep the MAMP installation on the lab LAN. The Vercel runtime stores shared matches in PostgreSQL and uses the deployed HTTPS domain. No external fonts or analytics are required.

## Checks

For the cloud runtime, use Node.js 22:

```sh
npm ci
npm test
npm run build
```

Set `TEST_DATABASE_URL` to a disposable PostgreSQL database to run the database and concurrency tests. GitHub Actions supplies a test database automatically. See [the Vercel guide](docs/VERCEL.md) for deployment verification.

For the local PHP runtime, run these from the game folder:

```sh
php tests/engine-test.php
php tests/service-test.php
php tests/burn-rule-test.php
php tests/session-test.php
```

The first checks rules and automated matches, including card conservation in Standard and Expanded games. The second checks table settings, seating, authorization, private hands, rollback, disconnected-player takeover, and rematches using an isolated in-memory SQLite database. The session checks cover jump-ins, pause, cumulative scores, and public move history. The test suite needs PHP 8 with PDO SQLite. These checks use isolated fixtures and do not touch saved tables.

For optional DOM integration checks, install `jsdom` into a separate development folder, then run `node tests/ui-test.cjs` with that folder’s `node_modules` in `NODE_PATH`. Set `PHP_BIN` if PHP is not on your command path. This suite connects the page’s actual event handlers to the PHP service through a CLI bridge and uses a temporary SQLite database; it does not launch a browser or web server. These tools are only needed for development, not for playing Troika.

## Four-card burn option

Before creating any table, choose **Suits don’t matter — any four** (default), or **Suits matter — need ♠ ♥ ♦ ♣**. The latter requires every suit of the same rank in the uninterrupted top run. For example K♠ K♠ K♥ K♦ K♣ burns when the club arrives; four K♠ alone do not. A different rank breaks the run. The option stays fixed for the table and rematches and appears in lobby/invite settings. Ordinary comparisons still ignore suits, and 6 resets and 10 burns work as before.
