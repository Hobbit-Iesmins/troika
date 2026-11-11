# Deploy Troika to Vercel

Troika has two supported runtimes: the original PHP + SQLite version for MAMP, and a Node.js + PostgreSQL version for Vercel. They use the same interface and house rules. Vercel needs a separate PostgreSQL database because serverless functions cannot share a durable local SQLite file.

## 1. Import the repository

1. Push the latest code to [Hobbit-Iesmins/troika](https://github.com/Hobbit-Iesmins/troika).
2. In Vercel, choose **Add New → Project** and import that repository.
3. Keep the repository root as the **Root Directory**. Do not select `public`, `api`, or `cloud` as the project root.
4. Use these settings. The repository's configuration supplies the build and output settings automatically; check them if you override project settings.

| Setting | Value |
| --- | --- |
| Framework Preset | Other |
| Node.js Version | 22.x |
| Install Command | `npm ci` |
| Build Command | `npm run build` |
| Output Directory | `public` |

The build creates the public game files and configures them to call the Node API at `/api/game`. PHP implementation files, tests, and database credentials are not copied into the public output.

## 2. Connect PostgreSQL

A database connection is required before multiplayer can work. A successful static build alone does not establish that the database is configured.

1. Open Vercel's **Marketplace**, choose **Neon**, and create or connect a PostgreSQL database to this project. Another PostgreSQL provider works too.
2. Select a database region close to your Vercel function region and your players. Use the provider's pooled connection URL when one is supplied. The committed function region is `fra1` (Frankfurt); choose a nearby database region, or change `regions` in `vercel.json` to match your provider.
3. In the project's **Settings → Environment Variables**, make sure `DATABASE_URL` contains the PostgreSQL connection URL. If the integration instead adds `POSTGRES_URL`, that name is also accepted.
4. Enable the variable for **Production**. Configure **Preview** too if you intend to test preview deployments; use a separate database or database branch for previews so a preview does not change production matches.
5. Use verified TLS (`sslmode=verify-full`). Neon URLs that contain `sslmode=require` are automatically normalized to full verification; provider CA/client-certificate settings are preserved. Keep this variable server-side: do not name it `NEXT_PUBLIC_DATABASE_URL`, put it in frontend JavaScript, or commit its value.
6. Deploy or **Redeploy** after adding or changing environment variables. Vercel applies them to new deployments.

The database user needs permission to create and update the `troika_rooms` table in its selected schema. Troika creates the table automatically on the first API request; no manual migration is needed for a new database. Room updates run in transactions with row locking so simultaneous players cannot overwrite each other's moves.

## 3. Check the deployed game

Open the production HTTPS URL and perform this short check:

1. Enter a nickname, create a Standard table, and add a practice bot. Start the round and play a card.
2. Open the invite link in a private/incognito window or another device. Use a different nickname and join a fresh lobby. Confirm that each player sees only their own hand.
3. Create an Expanded table and check the chosen seat and deck counts. Twelve seats must select at least three decks.
4. Enable jump-ins in a fresh table and test a completing fourth card. Check the selected suit rule too.
5. Pause and resume as host. Check Replay, Scoreboard, and the last-ten-card pile history.
6. Refresh a player's page and confirm that their seat reconnects.

Share the Vercel HTTPS invite link. Players do not need your private IP, MAMP, or the same Wi-Fi network. Your computer can be off once the cloud game is deployed. Keep the same production domain during a session: browser reconnect keys belong to that site's origin.

Local MAMP matches stay in their local SQLite database; they are not automatically imported into PostgreSQL. Start new cloud tables after deployment.

## Development checks

Use Node.js 22 and run:

```sh
npm ci
npm test
npm run build
```

Cloud database integration tests need `TEST_DATABASE_URL` pointing to a disposable PostgreSQL database. These tests create and remove test room records; do not use a production database. Without that variable, database-dependent tests may be skipped. The GitHub Actions workflow starts PostgreSQL automatically so those checks run in CI.

The original PHP checks remain available for MAMP and are listed in the main README.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| The page opens but creating a table fails | Confirm `DATABASE_URL` or `POSTGRES_URL` is set for this deployment's environment, then redeploy. |
| Database connection or storage is unavailable | Check the provider's database status, connection URL, TLS options, and table-creation permissions. |
| API endpoint returns 404 | Import the repository root and keep `api/game.js` in the deployed source; verify the repository's `vercel.json` has not been replaced. |
| Deployment succeeds but changes are missing | Confirm the deployed commit and refresh the page. The build uses versioned frontend assets. |
| A player cannot restore their seat | Reopen the same production domain in the same browser profile. Clearing site data or switching domains removes access to that browser's saved seat key. |

For a failed request, inspect the project's function logs in Vercel. Use the error category and timestamp to diagnose it; do not paste database URLs, passwords, or player tokens into logs or issue comments.

Troika uses short HTTP polling to synchronize the table. Function and database usage depend on the number of active players and the length of your sessions, so review the limits of the Vercel and database plans you choose.

## Supabase certificate verification

If the game reports `DB_TLS_CERTIFICATE`, download the public server/root CA certificate from the Supabase project's database SSL settings. Set `DATABASE_CA_CERT` in Vercel to the full PEM text, including BEGIN/END CERTIFICATE, then redeploy. Multiline PEM or literal `\n` line breaks are accepted. Alternatively, the same public certificate may be committed as `cloud/certs/supabase.crt`; never use a private key for this file. Hostname and certificate verification remain enabled.
