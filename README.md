# Mag IA · Arcane Idle RPG

Mag IA remains the existing fantasy idle RPG: 10 collectible mages, 14 tower floors, 5 spells, canvas battles, 12 normal enemies, 7 bosses, 35 boss-gated stages, relics, daily quests, 20 achievements, idle/offline Magic Coins, and the original dark-fantasy responsive UI. The game core and save key (`magia.save.v1`, version 1) are preserved.

The project now also includes an optional Telegram Mini App identity/cloud-save bridge, a Firebase Admin backend, and a separately protected operations console. Standalone play remains available; opening the Account screen does not add an email/password login.

> **Service status (this checkout, with the supplied `all_details.txt`):** Telegram bot token and admin ID pass format validation and Telegram `initData` verification is exercised locally with synthetic payloads; a session key is derived. Firebase **Web SDK** values (project `mag-ai-7f17c`) are public client settings and are loaded; **Firebase Admin service-account credentials are not present in the file**, so Firestore-backed cloud APIs fail closed. Monetag SDK URL and zone `12051648` parse successfully, but the Monetag integration is unverified and stays disabled. No payment provider is included; deposits and withdrawals are hard-disabled. Administrator TOTP is not set, so finance administration stays locked. No live Telegram, Firebase, Monetag, payment, or Railway connection has been made from this workspace.

## Play locally

The game needs no frontend build step. From the repository root:

```sh
python3 -m http.server 8080
# open http://localhost:8080
```

This serves the game and `client.js`; with no backend, it falls back to local browser saves. To run the Express server as well:

```sh
npm ci
npm start
# open http://localhost:3000
```

The backend binds to `0.0.0.0` and uses `PORT` when supplied. `/health` reports whether the process and storage configuration are available. With no Firebase Admin credentials, the game still runs locally, while identity/cloud APIs return a truthful unavailable state.

## Gameplay systems retained

| System | Notes |
| --- | --- |
| Idle economy | 10 mages mint Magic Coins into the capped pouch; collect, overflow, upgrades, and Blessing of Haste remain part of the original game. |
| Offline progress | Timestamp-based, clamped and capped; the baseline is 8 hours at reduced efficiency, with the original Chronomancer/tower modifiers. |
| Active combat | Canvas arena, mana/cooldowns, 5 spells, Focus Blast, 12 enemy types with traits, 7 bosses with unique abilities/keys, and 35 boss-gated stages. |
| Collection | Mage recruitment/ranks, talents, active lead, circle synergy, tower upgrades and relic forge. |
| Quests & achievements | Deterministic daily missions, streaks, 20 lifetime achievements and one-time claim guards. |
| Save compatibility | Existing `magia.save.v1` exports/imports remain usable. Cloud migration sanitizes the old save; a local pre-cloud recovery copy is retained when applicable. Importing a game save never changes a real-money balance or transaction history. |
| UI & feel | Responsive phone/tablet/desktop layout, reduced-motion setting, procedural canvas/SVG art, optional synthesized audio and haptics. |

Magic Coins are **game currency only** and have no cash value. The backend keeps their game-save state separate from the real-money ledger. Reward claims use atomic daily/monthly Magic Coin budgets and per-user caps; missing/zero caps block claims. Server-enforced emergency switches and financial caps are exposed in the admin settings page, with MFA required to unpause reward/financial operations or raise limits. The default financial switches are paused and all issuance limits are zero.

## Architecture

- `index.html` — original inline game modules and responsive UI, with Account screen, Telegram SDK include, runtime game tuning, and a small cloud-save hook.
- `client.js` — Telegram WebApp launch handling, same-origin API calls, cloud migration/sync, local recovery, referral/finance rendering, and optional Monetag SDK client. It never decides payment confirmations or rewards from an ad callback.
- `server.js`, `server/` — Express 5 API, Telegram `initData` HMAC verification, signed HttpOnly sessions, TOTP-protected financial admin actions, server-side game-save sanitization, Firestore adapter, and idempotent service/ledger operations.
- `admin.html`, `admin.js` — responsive operations console. The static shell contains no privileged data; every admin API verifies the server-issued Telegram session and the configured administrator ID. Finance reads and writes additionally require a short-lived TOTP verification.
- `firestore.rules` — denies all direct client Firestore access. All reads/writes go through Firebase Admin on the server.
- `firestore.indexes.json`, `firebase.json` — Firestore composite indexes and deployment references.
- `scripts/migrate-firestore.js` — initializes missing default settings documents only; it does not import user data.
- `scripts/set-telegram-menu.js` — configures and verifies the Telegram bot menu button after a deployed HTTPS URL is supplied.
- `all_details.example.txt`, `.env.example` — templates only. Never put real credentials in tracked files.

Telegram `initData` is validated server-side with the bot token and an `auth_date` age check. A client-supplied Telegram ID, admin flag, balance, payment reference, or save is not accepted as identity or financial authority. Game saves are normalized and versioned with conservative sync-delta checks. They are **not** a full server-side simulation of every idle/combat event, so they should not be represented as an anti-cheat guarantee; this is safe only because Magic Coins are not money or a cash-equivalent reward.

## Automatic configuration from all_details.txt

The project is configured automatically from a single private details file. You only need to supply `all_details.txt`; do not copy values into multiple files.

```sh
npm run configure          # validate + print a redacted report
npm run configure:apply    # also write a local .env pointer (git-ignored)
```

`server/config.js` loads values from, in priority order: explicit environment variables, `ALL_DETAILS_JSON`, `ALL_DETAILS_TEXT`, `ALL_DETAILS_FILE`, then `all_details.txt` at the project root. The parser treats legacy JavaScript-shaped text as **data**; it never executes uploaded JavaScript. Every supported entry is read, validated, and applied:

- Telegram bot token and admin ID (server-side only; the token is never sent to any client)
- Telegram Mini App URL/username/short-name settings
- Firebase Web SDK config (public client values) and project ID
- Firebase Admin SDK credentials (service-account JSON or `GOOGLE_APPLICATION_CREDENTIALS` file)
- Monetag publisher ID, zone IDs, SDK URL, postback secret, policy flag
- Payment provider fields (parsed for diagnostics only — payments stay disabled)
- Session secret, admin TOTP, financial safety limits, and system defaults

A derived session key (HKDF from the bot token) is used only as a local bootstrap fallback; set an independent `SESSION_SECRET` in production.

**Security:** private credentials exist only on the server. Nothing secret is written to frontend JavaScript, `index.html`, public assets, or client bundles; nothing secret is printed in logs or error messages (diagnostics are redacted status codes only). `all_details.txt` is git-ignored and excluded from the Docker build context. Do not commit a file containing real secrets.

## Deploying to Railway with minimal manual setup

Railway cannot read a local file, and a GitHub file is not automatically available to the runtime either. The supported method is a single Railway **private variable** carrying the whole file:

```sh
railway variables set "ALL_DETAILS_TEXT=$(cat all_details.txt)"
```

or paste the full contents of `all_details.txt` as the value of `ALL_DETAILS_TEXT` in the Railway Variables UI. The server parses and validates it at boot — no per-value entry is required. `railway.json` is intentionally not used (Railway's legacy JSON Config-as-Code path is deprecated for new services); the Dockerfile sets `NODE_ENV=production`, `TRUST_PROXY_HOPS=1`, the start command `npm start`, and health check path `/health`.

After the first deploy, Railway generates the real public HTTPS URL. Identify it from the Railway dashboard (or `railway domain`) — never invent it — then either:

- set `PUBLIC_APP_URL` to that URL and redeploy/restart: the server configures the Telegram menu button automatically at boot through the Bot API (verified via `getChatMenuButton`); or
- run `npm run telegram:menu` once with `PUBLIC_APP_URL` set. If automatic setup is unavailable, do it manually in @BotFather: `/setmenubutton` → select your bot → **Web App** → button text `Open Mag IA` → URL `https://<your-railway-domain>/`.

If any required value is absent (for example Firebase Admin credentials), the app still starts and reports the gap truthfully; affected APIs fail closed rather than pretending to work.

Deposits and withdrawals are hard-disabled in the backend: `PAYMENT_PROVIDER` / `PAYOUT_PROVIDER` values are parsed for diagnostics but never activate an adapter. The request/decision service code is not an integration with any bank, card, wallet or mobile-money provider. Do not attempt financial tests with real funds. Money operations must remain unavailable until a real provider adapter, callback/evidence semantics, reconciliation, and jurisdictional requirements are implemented and independently tested.

The supplied config does **not** contain Firebase Admin credentials, an explicit session secret, `ADMIN_TOTP_SECRET`, Monetag publisher/postback credentials, or provider verification. No placeholder should be treated as a working credential. A derived session key is a fallback for local bootstrapping only; set an independent `SESSION_SECRET` in production.

## Firestore setup

1. Create a Firebase project and Firestore database.
2. Configure the server-only Firebase Admin credential and `FIREBASE_PROJECT_ID`.
3. From a trusted development environment with Firebase CLI configured, deploy the deny-by-default rules and indexes:

   ```sh
   firebase deploy --only firestore:rules,firestore:indexes
   ```

4. Initialize absent defaults with `npm run migrate`. Existing settings are preserved. This script has **not** been run against a live Firebase project in this workspace.

Do not add Firebase browser SDK credentials or direct Firestore access to the game. The included Firebase Web SDK config from the upload is not sufficient to authenticate the server.

## Railway deployment outline

1. Create a Railway service from this repository (Node.js 22+; the included Dockerfile is used automatically).
2. Set the single private variable `ALL_DETAILS_TEXT` to the full contents of `all_details.txt` (see "Deploying to Railway" above). Optionally set `PUBLIC_APP_URL` after the first deploy.
3. Deploy, confirm `/health` reports `telegramConfigured:true`, then set the Telegram Mini App HTTPS URL in BotFather (or let the server configure the menu button automatically once `PUBLIC_APP_URL` is correct).
4. To enable cloud saves, add the Firebase Admin service-account JSON (`FIREBASE_SERVICE_ACCOUNT_JSON`) and deploy `firestore.rules` / `firestore.indexes.json` from a trusted environment with the Firebase CLI. To unlock finance administration, add `ADMIN_TOTP_SECRET`. Monetag and payments remain disabled until their respective verified integrations exist.

No `railway.json` is included: Railway's legacy JSON Config-as-Code path is deprecated for new services. Start command and health check are defined in the Dockerfile; the server listens on the injected `PORT` and binds `0.0.0.0`.

## Monetag and real-money boundaries

- Monetag and ad rewards are hard-disabled. The existing callback-shaped code is not treated as a verified provider adapter; adding an SDK URL/zone/postback secret or marking a policy review complete is insufficient to enable it.
- Do not assume frontend SDK events or the current callback field names match Monetag's current official semantics. Verify against the provider's documentation, implement the supported signature/replay protections, and test with provider-approved non-financial test events before changing the fail-closed gate.
- Estimated ad price is not settled cash. The admin overview reports settled advertising revenue as unavailable/unverified and keeps cash reward budgets at zero.
- The dormant deposit/withdrawal service methods maintain a separate minor-unit ledger with idempotency keys, atomic liability changes, reserved withdrawal funds, limits and audit logs. The HTTP workflows remain disabled; a human-entered evidence reference is not provider verification. Automated tests use only synthetic MemoryStore data and never move real funds.
- No live Telegram, Firebase, Monetag, payment-provider or Railway connection/deployment has been verified in this workspace.

## Checks run locally

```sh
npm ci
npm run check
npm test
```

`npm test` currently passes 29 tests using Node's test runner, jsdom for the existing game UI/save compatibility seam, a MemoryStore that rejects Firestore-style reads after writes, and native HTTP against Express. Coverage includes Telegram signature checks, sessions/TOTP, save compatibility/sanitization, server-side emergency switches, reward/financial caps, blocked-operation audit events, provider-off gates, synthetic ledger idempotency/liability transitions, admin access and recovery backups, and the details-file configuration pipeline (parsing, redaction, Railway payload round-trip, fail-closed menu helper). Synthetic ledger tests use in-memory records only; they do not move money. The suite does **not** connect to Firebase, verify Telegram with a live bot, contact Monetag/payment APIs, exercise a live device, build the Docker image (Docker is not installed in the workspace), or deploy. Report only these local checks as verified.
