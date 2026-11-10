# Troika

A local-network card game for 2–5 players in Standard mode, or up to 12 players in Expanded mode, with practice bots, private hands, selectable seats, and switchable table themes. No accounts, internet service, Composer, or Node.js are needed to run it.

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

The selected mode, capacity, and deck count stay fixed for the table and its rematches. Existing saved tables continue in Standard mode. Extra decks include repeated rank-and-suit faces, with each physical card tracked separately. Four consecutive matching ranks still burn the pile; play at most four matching cards in one action, then take the earned extra turn.

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

## Table layout and Table Talk

The table adapts to the available browser width and height, including when zooming to 130–150%. During a round, decorative content gives way to the table and hand controls. Large hands scroll within the hand area instead of pushing the play buttons down the page. On narrow screens, Table Talk is available from the speech-bubble button in the top bar.

Table Talk shows each played or revealed card with its rank and suit, including grouped plays and cards that burn the pile. Hearts and diamonds use red symbols. Older saved events keep their original text without guessing a suit.

To update an existing MAMP installation, replace the game files in the same folder and refresh the browser. The versioned CSS and JavaScript links load the updated interface. Matches remain in the separate SQLite storage folder.

## Local storage and reconnecting

Your browser stores a private player token so refreshing or reopening the same page in the same browser restores your seat. Avoid clearing site data during a game. Each human should use their own device or a separate browser profile; opening another tab in the same browser continues the same player.

If someone disconnects, their seat and cards stay in the match so they can reconnect. After 30 seconds offline, the host can give their seat to a bot. That takeover ends the original player’s access to the seat. Leaving during a round also gives the seat to a bot so the game can continue.

Shared matches are stored in SQLite outside the website folder, under PHP’s temporary directory in a folder named `troika-<installation hash>`. Apache’s PHP process needs permission to create and write there. For a more permanent location, set the `TROIKA_DATA_DIR` environment variable to a writable folder outside the web document root. Old tables are cleaned up after seven days when a new table is created; clearing the temporary directory also removes saved matches.

This game is intended for trusted players on a private local network. Keep the installation on the lab LAN. No external fonts, analytics, or hosted game services are required.

## Checks

From the game folder, run:

```sh
php tests/engine-test.php
php tests/service-test.php
php tests/burn-rule-test.php
```

The first checks rules and automated matches, including card conservation in Standard and Expanded games. The second checks table settings, seating, authorization, private hands, rollback, disconnected-player takeover, and rematches using an isolated in-memory SQLite database. The test suite needs PHP 8 with PDO SQLite. Neither suite touches saved tables.

For optional DOM integration checks, install `jsdom` into a separate development folder, then run `node tests/ui-test.cjs` with that folder’s `node_modules` in `NODE_PATH`. Set `PHP_BIN` if PHP is not on your command path. This suite connects the page’s actual event handlers to the PHP service through a CLI bridge and uses a temporary SQLite database; it does not launch a browser or web server. These tools are only needed for development, not for playing Troika.

## Four-card burn option

Before creating any table, choose **Suits don’t matter — any four** (default), or **Suits matter — need ♠ ♥ ♦ ♣**. The latter requires every suit of the same rank in the uninterrupted top run. For example K♠ K♠ K♥ K♦ K♣ burns when the club arrives; four K♠ alone do not. A different rank breaks the run. The option stays fixed for the table and rematches and appears in lobby/invite settings. Ordinary comparisons still ignore suits, and 6 resets and 10 burns work as before.
