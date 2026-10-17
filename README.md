# Mag IA · Arcane Idle RPG

Mag IA remains the existing fantasy idle RPG: 10 collectible mages, 14 tower floors, 5 spells, canvas battles, 12 normal enemies, 7 bosses, 35 boss-gated stages, relics, daily quests, 20 achievements, idle/offline Magic Coins, and the original dark-fantasy responsive UI. The game core and save key (`magia.save.v1`, version 1) are preserved.

The project now also includes an optional Telegram Mini App identity/cloud-save bridge, a Firebase Admin backend, and a separately protected operations console. Standalone play remains available; opening the Account screen does not add an email/password login.

> **Service status:** Local code/tests are available, but this checkout has not been deployed. The supplied config passes Telegram token/admin-ID *format* checks and can derive a session key; Firebase Admin credentials and admin TOTP are missing. Monetag configuration is incomplete and its callback behavior is unverified. No payment/payout adapter is implemented or verified. Deposits, withdrawals, Monetag ads, and ad rewards are hard-disabled. No live integration has been tested.

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

## Private configuration

`server/config.js` reads `.env` and, server-side only, the optional `all_details.txt` / `all details.txt` or `ALL_DETAILS_FILE`. The parser treats legacy JavaScript-shaped text as data; it does not execute uploaded JavaScript. Private file names and credential files are ignored by Git, excluded from Docker build context, and not served by the app. The Arena upload was inspected through a redacted report; its secrets were not copied into tracked files. Its Telegram token/admin ID pass syntax checks only, a session key can be derived, and its Firebase Web SDK values are **not Firebase Admin credentials**. Firebase Admin credentials and `ADMIN_TOTP_SECRET` are missing; the uploaded file's permissions were restricted to owner-only (`0600`) in this sandbox.

For local development, use a private file with owner-only permissions, or set `ALL_DETAILS_FILE` in your ignored `.env`:

```sh
cp all_details.example.txt all_details.txt
chmod 600 all_details.txt
cp .env.example .env
# Optionally: ALL_DETAILS_FILE=/absolute/path/to/private/all_details.txt
```

Do not commit the private file. On Railway, an uploaded local file is not automatically available; set secrets as Railway service runtime variables instead.

For Railway, prefer Railway Variables rather than uploading a credential file. At minimum configure:

- `PUBLIC_APP_URL` — the deployed HTTPS game URL.
- `TELEGRAM_BOT_TOKEN` and `ADMIN_TELEGRAM_ID` — private server variables. Set `TELEGRAM_BOT_USERNAME`; set `TELEGRAM_MINI_APP_SHORT_NAME` if using a named Mini App link.
- `SESSION_SECRET` — random, at least 32 bytes. Example generator: `openssl rand -hex 32`.
- `FIREBASE_PROJECT_ID` and `FIREBASE_SERVICE_ACCOUNT_JSON`, or `GOOGLE_APPLICATION_CREDENTIALS` pointing at a private service-account JSON file. The service account needs Firestore access; keep its key out of Git and frontend assets.
- `ADMIN_TOTP_SECRET` — a private Base32 authenticator secret. Generate a seed locally, add that same seed to an authenticator app, and store it in a password manager; for example, run `node -e "const c=require('node:crypto'),a='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',b=c.randomBytes(20);let bits=[...b].map(x=>x.toString(2).padStart(8,'0')).join(''),s='';for(let i=0;i<bits.length;i+=5)s+=a[parseInt(bits.slice(i,i+5).padEnd(5,'0'),2)];console.log(s)"` in a private terminal. Finance admin endpoints remain locked if it is absent.
- Monetag fields are recognized for redacted diagnostics (`MONETAG_SDK_URL`, `MONETAG_MAIN_ZONE_ID`, `MONETAG_POSTBACK_SECRET`, `MONETAG_PUBLISHER_ID`, `MONETAG_POLICY_REVIEWED`) but do not activate ads or rewards. The supplied script reference parses as HTTPS only; neither it nor the callback behavior has been tested against Monetag.

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

1. Create a Railway service from this repository on Node.js 22 or newer.
2. Use `npm ci` as the install/build step and `npm start` as the start command. Set `NODE_ENV=production` and `TRUST_PROXY_HOPS=1` for Railway's HTTPS proxy.
3. Configure Railway health check path `/health`; the server listens on the injected `PORT` and binds to `0.0.0.0`.
4. Use the Railway service Variables screen / Raw Editor for runtime secrets; paste each required variable there (do not rely on a GitHub-private file or an unattached/upload-less volume). Add Telegram, an independent session secret, Firebase Admin JSON, and admin TOTP. No provider/ad feature becomes enabled by entering variables alone; keep them disabled.
5. Deploy, confirm `/health`, then configure the Telegram Mini App HTTPS URL in BotFather or run `npm run telegram:menu` only after `PUBLIC_APP_URL` is correct. The menu script uses the Telegram Bot API; it was not run here.
6. Test login with a non-financial test account, cloud migration/recovery, and admin access while money and Monetag remain disabled. Any future provider integration needs separate implementation, policy review, and tests.

No `railway.json` is included: Railway's legacy JSON Config-as-Code path is deprecated for new services. Set start and health-check values in the Railway service settings instead.

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

`npm test` currently passes 24 tests using Node's test runner, jsdom for the existing game UI/save compatibility seam, a MemoryStore that rejects Firestore-style reads after writes, and native HTTP against Express. Coverage includes Telegram signature checks, sessions/TOTP, save compatibility/sanitization, server-side emergency switches, reward/financial caps, blocked-operation audit events, provider-off gates, synthetic ledger idempotency/liability transitions, admin access and recovery backups. Synthetic ledger tests use in-memory records only; they do not move money. The suite does **not** connect to Firebase, verify Telegram with a live bot, contact Monetag/payment APIs, exercise a live device, build the Docker image (Docker is not installed in the workspace), or deploy. Report only these local checks as verified.
