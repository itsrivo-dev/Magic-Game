'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {createApp}=require('../server/app');
const {MemoryStore}=require('../server/store');
const {starterSave}=require('../server/game-state');
const {verifyTotp,totpAt}=require('../server/session');
const {telegramInitData,telegramUser,configOverrides}=require('../test-support/helpers');

function cookies(response){
  const values=typeof response.headers.getSetCookie==='function'?response.headers.getSetCookie():[response.headers.get('set-cookie')||''];
  return values.map(value=>value.split(';')[0]).filter(value=>value.includes('='));
}
async function jsonRequest(base,path,{method='GET',body,cookie,origin=true}={}){
  const headers={'X-MagIA-Request':'1','Accept':'application/json'};
  if(origin)headers.Origin=base;
  if(cookie)headers.Cookie=cookie;
  if(body!==undefined)headers['Content-Type']='application/json';
  const response=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  const text=await response.text();let data={};try{data=JSON.parse(text);}catch{}
  return {response,data,text,cookies:cookies(response)};
}

test('native HTTP app verifies Telegram identity, protects admin APIs, migrates saves and serves the protected panel shell',async t=>{
  const config=configOverrides({adminTotpSecret:'JBSWY3DPEHPK3PXP',adminTotpRequiredForFinance:true});
  const store=new MemoryStore();const app=createApp({config,store});
  const server=app.listen(0,'127.0.0.1');
  await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const health=await jsonRequest(base,'/health');assert.equal(health.response.status,200);assert.equal(health.data.status,'ok');
  const panel=await fetch(base+'/admin');assert.equal(panel.status,200);assert.match(await panel.text(),/Operations Console/);
  const privateFile=await jsonRequest(base,'/all_details.txt');assert.equal(privateFile.response.status,404);

  const raw=telegramInitData(telegramUser('123450001'),config.telegramBotToken);
  const auth=await jsonRequest(base,'/api/auth/telegram',{method:'POST',body:{initData:raw}});
  assert.equal(auth.response.status,200);assert.equal(auth.data.authenticated,true);assert.equal(auth.data.profile.telegramId,'123450001');
  const session=auth.cookies.find(value=>value.startsWith('magia_session='));assert.ok(session);
  const me=await jsonRequest(base,'/api/me',{cookie:session,origin:false});assert.equal(me.response.status,200);assert.equal(me.data.profile.telegramId,'123450001');
  const denied=await jsonRequest(base,'/api/admin/me',{cookie:session,origin:false});assert.equal(denied.response.status,403);assert.equal(denied.data.error,'admin_access_denied');
  const migration=await jsonRequest(base,'/api/game/migrate',{method:'POST',cookie:session,body:{state:starterSave()}});
  assert.equal(migration.response.status,200);assert.equal(migration.data.migrated,true);assert.equal(migration.data.version,1);
  const game=await jsonRequest(base,'/api/game',{cookie:session,origin:false});assert.equal(game.response.status,200);assert.equal(game.data.state.coins,25);
  const recovery=await jsonRequest(base,'/api/game/recover',{method:'POST',cookie:session,body:{state:game.data.state,version:game.data.version}});
  assert.equal(recovery.response.status,200);assert.equal(recovery.data.backupCreated,true);assert.equal(recovery.data.version,2);
  assert.equal((await store.list('gameBackups')).length,1);
  const forged=await jsonRequest(base,'/api/auth/telegram',{method:'POST',body:{initData:raw.replace('123450001','900000001')}});
  assert.equal(forged.response.status,403);assert.equal(forged.data.error,'telegram_signature_invalid');

  const adminRaw=telegramInitData(telegramUser(config.telegramAdminId,{first_name:'Admin'}),config.telegramBotToken);
  const adminLogin=await jsonRequest(base,'/api/auth/telegram',{method:'POST',body:{initData:adminRaw}});
  assert.equal(adminLogin.response.status,200);
  const adminSession=adminLogin.cookies.find(value=>value.startsWith('magia_session='));assert.ok(adminSession);
  let adminMe=await jsonRequest(base,'/api/admin/me',{cookie:adminSession,origin:false});
  assert.equal(adminMe.response.status,200);assert.equal(adminMe.data.authorized,true);assert.equal(adminMe.data.mfaVerified,false);
  const gameSettings=await jsonRequest(base,'/api/admin/settings',{method:'PATCH',cookie:adminSession,body:{settings:{game:{battleRewardMultiplier:1.1}}}});
  assert.equal(gameSettings.response.status,200);
  const lockedSettings=await jsonRequest(base,'/api/admin/settings',{method:'PATCH',cookie:adminSession,body:{settings:{payments:{depositsEnabled:true}}}});
  assert.equal(lockedSettings.response.status,403);assert.equal(lockedSettings.data.error,'admin_mfa_required');
  const lockedUnpause=await jsonRequest(base,'/api/admin/settings',{method:'PATCH',cookie:adminSession,body:{settings:{system:{emergencySwitches:{magicCoinRewardsPaused:false}}}}});
  assert.equal(lockedUnpause.response.status,403);assert.equal(lockedUnpause.data.error,'admin_mfa_required');
  const lockedRewardIncrease=await jsonRequest(base,'/api/admin/settings',{method:'PATCH',cookie:adminSession,body:{settings:{referrals:{rewardMagicCoins:100}}}});
  assert.equal(lockedRewardIncrease.response.status,403);assert.equal(lockedRewardIncrease.data.error,'admin_mfa_required');
  const summaryBeforeMfa=await jsonRequest(base,'/api/admin/summary',{cookie:adminSession,origin:false});
  assert.equal(summaryBeforeMfa.response.status,200);assert.equal(summaryBeforeMfa.data.finance.locked,true);assert.equal(summaryBeforeMfa.data.finance.verifiedDepositsMinor,null);
  assert.ok(summaryBeforeMfa.data.recentActions.every(row=>!Object.hasOwn(row,'details')));
  const logsBeforeMfa=await jsonRequest(base,'/api/admin/logs',{cookie:adminSession,origin:false});assert.equal(logsBeforeMfa.response.status,403);
  const beforeMfa=await jsonRequest(base,'/api/admin/deposits',{cookie:adminSession,origin:false});
  assert.equal(beforeMfa.response.status,403);assert.equal(beforeMfa.data.error,'admin_mfa_required');
  const code=totpAt(config.adminTotpSecret,Date.now());assert.equal(verifyTotp(config.adminTotpSecret,code),true);
  const verified=await jsonRequest(base,'/api/admin/mfa',{method:'POST',cookie:adminSession,body:{code}});
  assert.equal(verified.response.status,200);assert.equal(verified.data.verified,true);
  const mfaCookie=verified.cookies.find(value=>value.startsWith('magia_admin_mfa='));assert.ok(mfaCookie);
  const combined=`${adminSession}; ${mfaCookie}`;
  adminMe=await jsonRequest(base,'/api/admin/me',{cookie:combined,origin:false});
  assert.equal(adminMe.response.status,200);assert.equal(adminMe.data.mfaVerified,true);
  const deposits=await jsonRequest(base,'/api/admin/deposits',{cookie:combined,origin:false});
  assert.equal(deposits.response.status,200);assert.deepEqual(deposits.data.deposits,[]);
  const runtimeSettings=await jsonRequest(base,'/api/admin/settings',{cookie:combined,origin:false});
  assert.equal(runtimeSettings.response.status,200);assert.equal(runtimeSettings.data.payments.providerVerified,false);assert.equal(runtimeSettings.data.payments.depositsEnabled,false);
  assert.equal(runtimeSettings.data.secretStatus.monetagIntegrationVerified,false);
  const serializedSettings=JSON.stringify(runtimeSettings.data);
  assert.doesNotMatch(serializedSettings,/test-session-secret|test-telegram-bot-token|JBSWY3DPEHPK3PXP/);
  const disabledDeposit=await jsonRequest(base,'/api/admin/settings',{method:'PATCH',cookie:combined,body:{settings:{payments:{depositsEnabled:true}}}});
  assert.equal(disabledDeposit.response.status,400);assert.equal(disabledDeposit.data.error,'deposit_provider_not_configured');
  const disabledAds=await jsonRequest(base,'/api/admin/settings',{method:'PATCH',cookie:combined,body:{settings:{ads:{enabled:true}}}});
  assert.equal(disabledAds.response.status,400);assert.equal(disabledAds.data.error,'monetag_integration_not_verified');
  const summaryAfterMfa=await jsonRequest(base,'/api/admin/summary',{cookie:combined,origin:false});assert.equal(summaryAfterMfa.data.finance.locked,false);
  const logsAfterMfa=await jsonRequest(base,'/api/admin/logs',{cookie:combined,origin:false});assert.equal(logsAfterMfa.response.status,200);
  const maintenance=await jsonRequest(base,'/api/admin/settings',{method:'PATCH',cookie:combined,body:{settings:{system:{maintenanceMode:true}}}});
  assert.equal(maintenance.response.status,200);assert.ok(maintenance.data.settings.system.maintenanceMode);
  const pausedAdSession=await jsonRequest(base,'/api/ads/reward-session',{method:'POST',cookie:session,body:{}});
  assert.equal(pausedAdSession.response.status,503);assert.equal(pausedAdSession.data.error,'maintenance_mode');
  const pausedSync=await jsonRequest(base,'/api/game/sync',{method:'POST',cookie:session,body:{state:game.data.state,version:game.data.version}});
  assert.equal(pausedSync.response.status,503);assert.equal(pausedSync.data.error,'maintenance_mode');
});

test('state-changing routes reject missing origin/request protections',async t=>{
  const config=configOverrides();const app=createApp({config,store:new MemoryStore()});
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const raw=telegramInitData(telegramUser('123450002'),config.telegramBotToken);
  const response=await fetch(base+'/api/auth/telegram',{method:'POST',headers:{Origin:'https://attacker.invalid','X-MagIA-Request':'1','Content-Type':'application/json'},body:JSON.stringify({initData:raw})});
  assert.equal(response.status,403);assert.equal((await response.json()).error,'origin_not_allowed');
});
