'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {loadConfig,getConfigReport,parseDetailsText}=require('../server/config');

const botToken=`123456:${'a'.repeat(35)}`;

test('legacy private config is parsed as data, redacted diagnostics reveal no credentials, and Monetag stays disabled',()=>{
  const privateValues={
    telegram:{botToken,adminTelegramId:'900000001'},
    session:{secret:'S'.repeat(48)},
    firebase:{projectId:'magia-test-123',webConfig:{apiKey:'public-web-key'}},
    monetag:{publisherId:'publisher-123',mainZoneId:'123456',sdkUrl:'https://example.invalid/sdk.js',postbackSecret:'private-postback-value',policyReviewed:true},
    admin:{totpSecret:'JBSWY3DPEHPK3PXP'}
  };
  const config=loadConfig({file:privateValues,env:{},loadDotenv:false});
  const report=getConfigReport(config);
  assert.equal(report.telegramBotToken,'valid_format');
  assert.equal(report.adminTelegramId,'valid_format');
  assert.equal(report.firebaseAdminCredentials,'missing');
  assert.equal(report.monetag.enabled,false);
  assert.match(report.warnings.join(' '),/not enabled/);
  const diagnostic=JSON.stringify(report);
  for(const secret of [botToken,privateValues.session.secret,privateValues.monetag.postbackSecret,privateValues.admin.totpSecret]) {
    assert.equal(diagnostic.includes(secret),false);
  }
});

test('legacy JavaScript-shaped input is extracted without executing code',()=>{
  globalThis.__magiaConfigTestSideEffect=false;
  const parsed=parseDetailsText([
    'Bot Token: 123456:abcdefghijklmnopqrstuvwxyzABCDE',
    'Admin ID: 900000001',
    'const firebaseConfig = {',
    "  apiKey: 'web-key',",
    "  projectId: 'magia-test-123'",
    '};',
    'globalThis.__magiaConfigTestSideEffect = true;'
  ].join('\n'));
  assert.equal(parsed.telegram.botToken,'123456:abcdefghijklmnopqrstuvwxyzABCDE');
  assert.equal(parsed.firebase.webConfig.projectId,'magia-test-123');
  assert.equal(globalThis.__magiaConfigTestSideEffect,false);
  delete globalThis.__magiaConfigTestSideEffect;
});
