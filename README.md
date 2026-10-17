# Mag IA · Arcane Idle RPG

Mag IA remains the existing fantasy idle RPG: 10 collectible mages, 14 tower floors, 5 spells, canvas battles, 12 normal enemies, 7 bosses, 35 boss-gated stages, relics, daily quests, 20 achievements, idle/offline Magic Coins, and the original dark-fantasy responsive UI. The game core and save key (`magia.save.v1`, version 1) are preserved.

The project now also includes an optional Telegram Mini App identity/cloud-save bridge, a Firebase Admin backend, and a separately protected operations console. Standalone play remains available; opening the Account screen does not add an email/password login.

> **Service status:** Source and local automated tests are in place. This checkout is not deployed, Firebase Admin credentials are not configured, Telegram authentication has not been tested against a live bot, and Monetag/payment providers have not been verified. Deposits and withdrawals are disabled by default.

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

Magic Coins are **game currency only** and have no cash value. The backend keeps their game-save state separate from the real-money ledger.

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

`server/config.js` reads `.env` and the optional `all_details.txt` on the server only. `all_details.txt` is ignored by Git and is not exposed by the web server. The uploaded details were mapped into that local file, but the uploaded Firebase Web SDK values are **not Firebase Admin credentials**. This checkout still needs a Firebase service-account credential (or an explicitly configured credentials path) and a session signing secret before Telegram/cloud persistence can work.

For local development, copy/edit the template without committing private values:

```sh
cp all_details.example.txt all_details.txt
cp .env.example .env
```

For Railway, prefer Railway Variables rather than uploading a credential file. At minimum configure:

- `PUBLIC_APP_URL` — the deployed HTTPS game URL.
- `TELEGRAM_BOT_TOKEN` and `ADMIN_TELEGRAM_ID` — private server variables. Set `TELEGRAM_BOT_USERNAME`; set `TELEGRAM_MINI_APP_SHORT_NAME` if using a named Mini App link.
- `SESSION_SECRET` — random, at least 32 bytes. Example generator: `openssl rand -hex 32`.
- `FIREBASE_PROJECT_ID` and `FIREBASE_SERVICE_ACCOUNT_JSON`, or `GOOGLE_APPLICATION_CREDENTIALS` pointing at a private service-account JSON file. The service account needs Firestore access; keep its key out of Git and frontend assets.
- `ADMIN_TOTP_SECRET` — a private Base32 authenticator secret. Generate a seed locally, add that same seed to an authenticator app, and store it in a password manager; for example, run `node -e "const c=require('node:crypto'),a='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',b=c.randomBytes(20);let bits=[...b].map(x=>x.toString(2).padStart(8,'0')).join(''),s='';for(let i=0;i<bits.length;i+=5)s+=a[parseInt(bits.slice(i,i+5).padEnd(5,'0'),2)];console.log(s)"` in a private terminal. Finance admin endpoints remain locked if it is absent.
- Optional Monetag: `MONETAG_SDK_URL`, `MONETAG_MAIN_ZONE_ID`, `MONETAG_POSTBACK_SECRET`, and optionally `MONETAG_PUBLISHER_ID`. Confirm the SDK URL and postback fields in the Monetag dashboard before enabling anything. The supplied script reference is parsed as HTTPS but has not been tested against Monetag.

Payment settings default to `PAYMENT_PROVIDER=disabled`, `PAYOUT_PROVIDER=disabled`, blank currency, and zero limits. There is no automated Stripe/bank/mobile-money provider adapter in this implementation. The optional `manual` mode is only a human-reviewed request/evidence workflow; it is not provider verification. Keep deposits and withdrawals disabled unless an actual external process/provider has been configured, tested safely, and is supported in your jurisdiction. Never test with real user money. Submitting a reference is not proof of payment, and marking a payout paid requires independent provider confirmation plus an audit reference.

The configuration file included here does **not** contain Firebase Admin credentials, a session secret, Monetag postback secret, payment provider setup, or administrator TOTP secret. No placeholder should be treated as a working credential.

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
4. Add the required Telegram, session, Firebase, and admin TOTP variables above. Add optional Monetag variables only after provider-side verification. Keep financial workflows disabled.
5. Deploy, confirm `/health`, then configure the Telegram Mini App HTTPS URL in BotFather or run `npm run telegram:menu` only after `PUBLIC_APP_URL` is correct. The menu script uses the Telegram Bot API; it was not run here.
6. Test login with a non-financial test account, cloud migration/recovery, and admin access before enabling any optional provider feature.

No `railway.json` is included: Railway's legacy JSON Config-as-Code path is deprecated for new services. Set start and health-check values in the Railway service settings instead.

## Monetag and real-money boundaries

- Monetag is disabled until server config and runtime settings are complete. A frontend SDK Promise/click is not proof of a valued impression. Rewarded Magic Coins require a matching server-side Monetag postback and an idempotent claim.
- Estimated ad price is not settled cash. The admin overview reports settled advertising revenue as unavailable/unverified and holds the reward budget at zero without verified revenue.
- Deposit/withdrawal records use a separate minor-unit currency ledger with idempotency keys, atomic balance/liability changes, reserved withdrawal funds, evidence references, rate limits and audit logs. Manual approval is explicitly labeled as manual external review; the code does not call a payment processor or verify a provider receipt itself.
- No live Telegram, Firebase, Monetag, payment-provider or Railway connection/deployment has been verified in this workspace.

## Checks run locally

```sh
npm ci
npm run check
npm test
```

`npm test` uses Node's test runner, jsdom for the existing game UI/save compatibility seam, a MemoryStore that rejects Firestore-style reads after writes, and native HTTP against the Express app. It covers Telegram signature checks, sessions/TOTP, routes, save sanitization and sync limits, referrals, idempotency, finance liability transitions, admin access, and recovery backups. It does **not** connect to a real Firebase project or external provider, test actual Telegram WebApp `initData`, exercise a live browser/device, or deploy the service. Report only these local tests as verified.
