# Accounts and rankings

The online Vercel version stores accounts in the existing Supabase PostgreSQL database. These are application accounts in `troika_accounts`, not Supabase Auth users. No additional API key, email service, or environment variable is required. The local MAMP version keeps casual play without accounts.

## Owner setup

Use the private, one-time owner setup link provided separately. Enter the reserved owner email, a nickname, and your chosen password (10–128 characters). First and last names are optional. The owner claim requires both the reserved email and a 256-bit setup token; ordinary registration can never grant administrator privileges. The repository contains only hashes of the owner email and setup token. The link fragment is consumed and removed immediately, never stored in browser storage or sent in a URL to the server. Once the claim succeeds it cannot be reused.

Do not share the private owner link. Use normal game invite links to invite players. Keep the owner's password in a password manager; if it is lost, a trusted database operator must recover the owner account through the database rather than reusing the consumed bootstrap link.

## Player accounts

Open **Account → Create account**. Nicknames and ratings are public; email, first name, and last name are private to the player and administrator. Emails and nicknames must be unique. Email delivery and email verification are not configured. The site does not claim to send recovery emails.

Passwords are salted and hashed using scrypt. Login sessions use HttpOnly, SameSite cookies, Secure over HTTPS. Only session hashes are stored in PostgreSQL. Logging out revokes that session. Changing or resetting a password revokes all old sessions. Suspension also revokes sessions and outstanding reset links. Requests check their origin, and persistent rate limits protect account actions. Account, session, room, reset, and ranking tables enable row-level security; the server database owner accesses them directly.

## Administration and password recovery

Open **Account → Admin**, select a player, then create a reset link. Copy and privately share it with that player. It expires after 15 minutes and can be used once; creating another replaces the previous link. The administrator cannot read anyone's existing password. **Forgot your password?** explains how to request this link from the administrator.

The same panel can suspend or restore a player and correct their Elo. Corrections require an explanation and create an audit record. Changing Elo does not rewrite historical match placements or wins. The administrator account cannot be suspended.

## Ranked tables

Sign in, enable **Ranked game** before creating a table, and invite signed-in human players. Each account can occupy one seat per table. The server binds the seat to the authenticated account; supplying an account ID or nickname in a request cannot impersonate another player. Ranked rounds cannot start with bots. Practice with bots is always casual.

Completed rounds update Elo and profile statistics atomically and exactly once, including after concurrent polls or reconnects. Only ranked rounds appear in account match history. A voluntary leave or disconnected-player bot takeover retains the original account's eventual finishing position. A host kick during an active ranked round voids its rating changes for everyone; that round remains visible in history as void. Kicking after a result was recorded does not change it. Bot seats must be removed from a rematch lobby before a new ranked deal.

## Rating algorithm

Everyone starts at **500 Elo**. For each opponent:

`expected = 1 / (1 + 10^((opponentRating - yourRating) / 400))`

`actual = 1` if you finish above the opponent, otherwise `0`.

`change = round(K × sum(actual - expected) / (players - 1))`

`K = 64` for the first ten rated matches, then `32`. Ratings used are locked current ratings at scoring time. Equal established players in a five-player match receive +16, +8, 0, −8, and −16 by finishing position. Placement matches move twice as much. Different experience levels can produce different gains and losses because their K values differ. Ratings are not artificially floored.

| Elo | Tier |
| --- | --- |
| Below 600 | Trash |
| 600–799 | Rookie |
| 800–999 | Bronze |
| 1000–1199 | Silver |
| 1200–1399 | Gold |
| 1400–1599 | Platinum |
| 1600–1799 | Diamond |
| 1800–1999 | Master |
| 2000+ | Grandmaster |

Profiles show ranked games, wins, last-place finishes, average placement, current and peak Elo. The public ladder shows the top 100 active accounts. Match history shows the most recent 50 ranked results with placement and rating changes, without other players' private profile fields.
