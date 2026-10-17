'use strict';

const crypto = require('node:crypto');

function telegramInitData(user, botToken, { now = Date.now(), startParam, extra = {} } = {}) {
  const params = new URLSearchParams();
  params.set('auth_date',String(Math.floor(now/1000)));
  params.set('user',JSON.stringify(user));
  params.set('query_id','AAE_TEST_QUERY');
  if(startParam)params.set('start_param',startParam);
  for(const [key,value] of Object.entries(extra))params.set(key,String(value));
  const check=[...params.entries()].map(([key,value])=>`${key}=${value}`).sort((a,b)=>a.localeCompare(b)).join('\n');
  const secret=crypto.createHmac('sha256','WebAppData').update(botToken).digest();
  params.set('hash',crypto.createHmac('sha256',secret).update(check).digest('hex'));
  return params.toString();
}
function telegramUser(id, extra = {}) {
  return {id,first_name:'Test Mage',username:'test_mage',language_code:'en',...extra};
}
function configOverrides(overrides = {}) {
  return {
    nodeEnv:'test',isProduction:false,port:0,host:'127.0.0.1',root:require('node:path').resolve(__dirname,'..'),
    sessionSecret:'test-session-secret-with-more-than-thirty-two-bytes',telegramBotToken:'test-telegram-bot-token',telegramAdminId:'900000001',
    telegramBotUsername:'magia_test_bot',miniAppShortName:'magia',publicAppUrl:'',firebaseProjectId:'test-project',
    firebaseServiceAccount:null,firebaseCredentialsPath:null,firebaseDatabaseUrl:'',monetagPublisherId:'',monetagSdkUrl:null,monetagPostbackSecret:'',
    paymentProvider:'disabled',payoutProvider:'disabled',paymentCurrency:'',paymentCurrencyExponent:2,manualPaymentMethods:[],manualPaymentInstructions:'',
    paymentMinDepositMinor:0,paymentMaxDepositMinor:0,paymentMinWithdrawalMinor:0,paymentMaxWithdrawalMinor:0,
    adminTotpSecret:'JBSWY3DPEHPK3PXP',adminTotpRequiredForFinance:true,systemSettingsSeed:{},trustProxyHops:0,
    ...overrides
  };
}

module.exports={telegramInitData,telegramUser,configOverrides};
