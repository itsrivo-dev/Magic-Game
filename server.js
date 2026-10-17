'use strict';

const { loadConfig, getConfigReport } = require('./server/config');
const { makeFirebaseStore } = require('./server/store');
const { createApp } = require('./server/app');
const { applyMenuButton } = require('./server/telegram-menu');

let config;
try {
  config = loadConfig();
} catch (error) {
  const code = String(error && error.message || 'CONFIG_LOAD_FAILED').split(':')[0];
  process.stderr.write(`[mag-ia] configuration error (${code})\n`);
  process.exit(1);
}

const report = getConfigReport(config);
process.stdout.write(`[mag-ia] private configuration source=${report.source}; format=${report.format || 'n/a'}\n`);
for (const warning of report.warnings) process.stderr.write(`[mag-ia] configuration warning: ${warning}\n`);
if (report.requiredMissing.length) {
  process.stderr.write(`[mag-ia] missing required configuration: ${report.requiredMissing.join(', ')}\n`);
}
if (report.invalidValues.length) {
  process.stderr.write(`[mag-ia] invalid configuration fields (values redacted): ${report.invalidValues.join(', ')}\n`);
}
process.stdout.write(`[mag-ia] config status: Telegram=${report.telegramBotToken}, admin=${report.adminTelegramId}, Firebase Admin=${report.firebaseAdminCredentials}, Monetag=${report.monetag.enabled ? 'verified' : 'disabled'}, payments=disabled\n`);

const firebase = makeFirebaseStore(config);
if (!firebase.store) process.stderr.write(`[mag-ia] Firebase store unavailable (${firebase.reason || 'unknown'}); Telegram cloud APIs will fail closed.\n`);
const app = createApp({ config, store: firebase.store, storeReason: firebase.reason });
const port = Number(process.env.PORT) || config.port || 3000;
const host = '0.0.0.0';
const server = app.listen(port, host, () => {
  process.stdout.write(`[mag-ia] listening on ${host}:${port}; firebase=${firebase.store ? 'configured' : 'not_configured'}\n`);
});

// Once the real deployed HTTPS URL is known (PUBLIC_APP_URL, or the
// Railway-generated RAILWAY_PUBLIC_DOMAIN), configure the bot menu button
// automatically through the Telegram Bot API. Safe: the URL is validated
// HTTPS first, and failures never expose the bot token.
async function setupMenuButton() {
  if (process.env.TELEGRAM_MENU_AUTO_SETUP === 'false') return;
  if (!config.telegramBotToken || !config.publicAppUrl) return;
  const result = await applyMenuButton(config, {
    log: message => process.stdout.write(`[mag-ia] ${message}\n`)
  });
  if (!result.ok) {
    process.stderr.write(`[mag-ia] telegram menu button not configured (${result.code}); run 'npm run telegram:menu' after setting PUBLIC_APP_URL.\n`);
  }
}
setupMenuButton().catch(() => {});

function stop(signal) {
  process.stdout.write(`[mag-ia] ${signal} received; shutting down\n`);
  server.close(() => {
    if (firebase.admin && firebase.admin.apps) {
      Promise.all(firebase.admin.apps.map(item => item.delete().catch(() => {}))).finally(() => process.exit(0));
    } else process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
