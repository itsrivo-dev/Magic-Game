'use strict';

const { loadConfig } = require('../server/config');
const { applyMenuButton } = require('../server/telegram-menu');

async function main() {
  let config;
  try { config = loadConfig(); } catch (error) {
    console.error(`Configuration error (${String(error && error.message || 'CONFIG_LOAD_FAILED').split(':')[0]}).`);
    process.exitCode = 1;
    return;
  }
  const result = await applyMenuButton(config, { log: message => console.log(message) });
  if (!result.ok) {
    const hints = {
      telegram_bot_token_not_configured: 'Blocked: set TELEGRAM_BOT_TOKEN in Railway Variables or the private all_details.txt runtime file.',
      public_app_url_not_configured: 'Blocked: set PUBLIC_APP_URL to the deployed HTTPS Mini App URL.',
      public_app_url_invalid: 'Blocked: PUBLIC_APP_URL is not a valid URL.',
      public_app_url_not_https: 'Blocked: Telegram Mini App URLs must use HTTPS.',
      bot_username_mismatch: 'Blocked: configured bot username does not match Telegram getMe. No menu change was made.'
    };
    console.error(`Telegram menu setup failed (${result.code}). ${hints[result.code] || 'The bot token was not printed.'}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Menu button URL: ${result.appUrl}`);
}
main();
