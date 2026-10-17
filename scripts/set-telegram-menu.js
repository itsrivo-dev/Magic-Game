'use strict';

const { loadConfig } = require('../server/config');

async function telegram(method, token, body) {
  const response=await fetch(`https://api.telegram.org/bot${token}/${method}`,{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify(body||{}),
    signal:AbortSignal.timeout(12000)
  });
  let payload;
  try { payload=await response.json(); } catch { throw new Error('TELEGRAM_INVALID_RESPONSE'); }
  if(!response.ok||payload.ok!==true) throw new Error(`TELEGRAM_API_FAILED_${method}`);
  return payload.result;
}

async function main() {
  let config;
  try { config=loadConfig(); } catch (error) {
    console.error(`Configuration error (${String(error&&error.message||'CONFIG_LOAD_FAILED').split(':')[0]}).`);
    process.exitCode=1;
    return;
  }
  if(!config.telegramBotToken) {
    console.error('Blocked: set TELEGRAM_BOT_TOKEN in Railway Variables or the private all_details.txt runtime file.');
    process.exitCode=1;
    return;
  }
  if(!config.publicAppUrl) {
    console.error('Blocked: set PUBLIC_APP_URL to the deployed HTTPS Mini App URL.');
    process.exitCode=1;
    return;
  }
  let url;
  try { url=new URL(config.publicAppUrl); } catch { url=null; }
  if(!url||url.protocol!=='https:') {
    console.error('Blocked: Telegram Mini App URLs must use HTTPS.');
    process.exitCode=1;
    return;
  }
  try {
    const bot=await telegram('getMe',config.telegramBotToken,{});
    if(config.telegramBotUsername && String(bot.username||'').toLowerCase()!==String(config.telegramBotUsername).replace(/^@/,'').toLowerCase()) {
      console.error('Blocked: configured bot username does not match Telegram getMe. No menu change was made.');
      process.exitCode=1;
      return;
    }
    const result=await telegram('setChatMenuButton',config.telegramBotToken,{
      menu_button:{type:'web_app',text:'Open Mag IA',web_app:{url:url.toString()}}
    });
    const verified=await telegram('getChatMenuButton',config.telegramBotToken,{});
    const actualUrl=verified&&verified.web_app&&verified.web_app.url;
    if(!result || !verified || verified.type!=='web_app' || actualUrl!==url.toString()) {
      console.error('Telegram returned success, but the menu configuration could not be verified.');
      process.exitCode=1;
      return;
    }
    console.log(`Telegram menu button configured and verified for @${bot.username}. URL: ${actualUrl}`);
  } catch(error) {
    console.error(`Telegram menu setup failed (${error&&error.message||'unknown'}). The bot token was not printed.`);
    process.exitCode=1;
  }
}
main();
