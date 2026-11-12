# Table performance

Idle state polling keeps the one-second update interval. It still processes connection status, disconnect takeover deadlines, ranked conduct and profile changes. Unchanged markup no longer replaces DOM nodes. Returning to a tab during an in-flight request cannot start a duplicate polling timer.

Game rendering caches each panel's markup. Cards, seats, player rows and Table Talk events keep their physical DOM nodes when their content changes. A played card is removed without redealing the surviving hand; keyboard focus and horizontal hand scroll remain in place. The pile inspector also preserves its scroll position. Replay deliberately recreates its animated section on each replay.

The turn panel keeps its red border and static glow. Breathing cues use opacity on small badges/borders, and the comet uses transform/opacity. The large hand glow and expanded-name outline no longer animate paint-heavy properties. Moves no longer dim the whole page. Pause and reduced-motion behavior remain supported.

Database transaction setup batches BEGIN and both fixed SET LOCAL timeout commands into one query. Guest state requests use four database round trips instead of six; signed-in state requests use five instead of seven. Session authentication, per-room row locks, heartbeat writes and commit/rollback remain in place.

## Verification

A local JSDOM workload used 12 seats, four decks, a 40-card hand and 80 feed events. Across 30 unchanged polls, the previous renderer inserted and removed 2,760 nodes; the updated renderer made zero DOM mutations. Across 30 unrelated profile events, inserted/removed node counts dropped from 16,088/16,200 to 180/292. These are DOM-work measurements, not browser frame-rate measurements. Shared Chrome/browser-control tools were unavailable in the managed workspace, so no FPS or GPU trace was collected.

`tests/cloud/ui.test.cjs` checks zero-mutation idle polling, same-version connection changes, card identity, legal/disabled state updates, keyboard focus, scroll, avatar failure fallback, reconnect banners and replay restart. `tests/cloud/service-performance.test.cjs` checks actual PostgreSQL query counts, transaction-local timeout scope and rollback after a setup error. Existing multiplayer, ranked conduct and local PHP integration checks also pass.
