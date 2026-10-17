'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {verifyTelegramInitData,TelegramAuthError}=require('../server/telegram');
const {telegramInitData,telegramUser}=require('../test-support/helpers');

const token='test-bot-token-123456789';
const now=Date.UTC(2026,9,17,12,0,0);

test('verifies Telegram Mini App HMAC and extracts only normalized profile data',()=>{
  const raw=telegramInitData(telegramUser('123456789',{first_name:'Ari',last_name:'Rune',is_premium:true}),token,{now,startParam:'ref_ABC12345'});
  const verified=verifyTelegramInitData(raw,token,{now:()=>now,maxAgeSeconds:600});
  assert.equal(verified.user.id,'123456789');
  assert.equal(verified.user.firstName,'Ari');
  assert.equal(verified.user.lastName,'Rune');
  assert.equal(verified.user.isPremium,true);
  assert.equal(verified.startParam,'ref_ABC12345');
  assert.equal('is_admin' in verified.user,false);
});

test('rejects changed data, duplicate keys and expired auth_date',()=>{
  const raw=telegramInitData(telegramUser('123456789'),token,{now});
  assert.throws(()=>verifyTelegramInitData(raw.replace('Test+Mage','Forged'),token,{now:()=>now}),TelegramAuthError);
  assert.throws(()=>verifyTelegramInitData(raw+'&auth_date=1',token,{now:()=>now}),error=>error.code==='telegram_init_data_malformed');
  const expired=telegramInitData(telegramUser('123456789'),token,{now:now-3_600_000});
  assert.throws(()=>verifyTelegramInitData(expired,token,{now:()=>now,maxAgeSeconds:600}),error=>error.code==='telegram_init_data_expired');
});

test('rejects untrusted identities and malformed Telegram users',()=>{
  const missing=telegramInitData({first_name:'No ID'},token,{now});
  assert.throws(()=>verifyTelegramInitData(missing,token,{now:()=>now}),error=>error.code==='telegram_user_id_invalid');
  const badName=telegramInitData({id:12},token,{now});
  assert.throws(()=>verifyTelegramInitData(badName,token,{now:()=>now}),error=>error.code==='telegram_user_name_missing');
  assert.throws(()=>verifyTelegramInitData('','',{now:()=>now}),error=>error.code==='telegram_auth_not_configured');
});
