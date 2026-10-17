'use strict';

// Shared Telegram menu-button (Web App) configuration.
// Used at server startup (automatic) and by scripts/set-telegram-menu.js
// (manual). Never logs or returns the bot token; errors carry codes only.

async function telegramRequest(botToken, method, body) {
  const response = await fetch(`https://api.telegram.org/bot${encodeURIComponent(botToken)}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(12000)
  });
  let payload;
  try { payload = await response.json(); } catch { throw new Error('TELEGRAM_INVALID_RESPONSE'); }
  if (!response.ok || payload.ok !== true) throw new Error(`TELEGRAM_API_FAILED_${method}`);
  return payload.result;
}

function normalizeBotUsername(value) {
  return String(value || '').replace(/^@/, '').toLowerCase();
}

async function applyMenuButton(config, options = {}) {
  const log = options.log || (() => {});
  if (!config.telegramBotToken) return { ok: false, code: 'telegram_bot_token_not_configured' };
  if (!config.publicAppUrl) return { ok: false, code: 'public_app_url_not_configured' };
  let url;
  try { url = new URL(config.publicAppUrl); } catch { return { ok: false, code: 'public_app_url_invalid' }; }
  if (url.protocol !== 'https:') return { ok: false, code: 'public_app_url_not_https' };
  try {
    const bot = await telegramRequest(config.telegramBotToken, 'getMe');
    const configured = normalizeBotUsername(config.telegramBotUsername);
    if (configured && normalizeBotUsername(bot.username) !== configured) {
      return { ok: false, code: 'bot_username_mismatch' };
    }
    await telegramRequest(config.telegramBotToken, 'setChatMenuButton', {
      menu_button: { type: 'web_app', text: 'Open Mag IA', web_app: { url: url.toString() } }
    });
    const verified = await telegramRequest(config.telegramBotToken, 'getChatMenuButton');
    const actualUrl = verified && verified.web_app && verified.web_app.url;
    if (!verified || verified.type !== 'web_app' || actualUrl !== url.toString()) {
      return { ok: false, code: 'menu_button_verify_failed' };
    }
    log(`Telegram menu button configured and verified for @${bot.username}.`);
    return { ok: true, botUsername: bot.username, appUrl: url.toString() };
  } catch (error) {
    return { ok: false, code: String(error && error.message || 'TELEGRAM_MENU_SETUP_FAILED').split(':')[0] };
  }
}

module.exports = { applyMenuButton, telegramRequest };
