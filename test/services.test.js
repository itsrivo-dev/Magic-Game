'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {MemoryStore}=require('../server/store');
const {
  initializeSettings,ensureTelegramUser,initializeGameProgress,getOperationalSettings,
  saveAdminSettings,syncGameProgress,claimReferralReward,createDeposit,decideDeposit,
  createWithdrawal,decideWithdrawal,adminSummary,normalizePaymentSettings
}=require('../server/services');
const {telegramUser,configOverrides}=require('../test-support/helpers');

function verified(id,startParam){return {user:telegramUser(String(id)),...(startParam?{startParam}:{})};}

async function setup(overrides={}){
  const config=configOverrides(overrides);const store=new MemoryStore();
  await initializeSettings(store,config);
  return {store,config};
}

test('zero-exponent currencies remain zero-exponent through payment normalization',()=>{
  const config=configOverrides({paymentCurrency:'JPY',paymentCurrencyExponent:0});
  const settings=normalizePaymentSettings({},config);
  assert.equal(settings.currency,'JPY');assert.equal(settings.currencyExponent,0);
});

test('verified Telegram account creation is atomic and referral qualification/reward is one-time',async()=>{
  const {store,config}=await setup();
  const inviter=await ensureTelegramUser(store,verified(1001),config);
  const invitee=await ensureTelegramUser(store,verified(1002,`ref_${inviter.user.referralCode}`),config);
  assert.equal(inviter.created,true);assert.equal(invitee.created,true);
  assert.equal((await store.get('users/1002')).referredByUid,'1001');
  assert.equal((await store.get('referrals/1002')).status,'pending');
  await initializeGameProgress(store,'1001',null,false);
  const progress=await initializeGameProgress(store,'1002',null,false);
  await saveAdminSettings(store,'900000001',{referrals:{enabled:true,qualificationLevel:1,qualificationHours:0,rewardMagicCoins:125}},config);
  const settings=await getOperationalSettings(store,config);
  const synced=await syncGameProgress(store,'1002',progress.state,progress.version,settings);
  assert.equal(synced.conflict,false);
  assert.equal((await store.get('referrals/1002')).status,'eligible');
  const reward=await claimReferralReward(store,'1001','1002');
  assert.equal(reward.amount,125);assert.equal(reward.state.coins,150);
  assert.equal((await store.get('referrals/1002')).status,'rewarded');
  await assert.rejects(claimReferralReward(store,'1001','1002'),error=>error.code==='referral_reward_already_claimed');
  const summary=await adminSummary(store,settings);
  assert.equal(summary.users.total,2);
});

test('manual finance requests are idempotent and liabilities move between available and reserved',async()=>{
  const configOverride={
    paymentProvider:'manual',payoutProvider:'manual',paymentCurrency:'BDT',paymentCurrencyExponent:2,
    manualPaymentMethods:['bkash'],manualPaymentInstructions:'Send funds through the configured external provider and retain the receipt.',
    paymentMinDepositMinor:100,paymentMaxDepositMinor:100000,paymentMinWithdrawalMinor:100,paymentMaxWithdrawalMinor:100000
  };
  const {store,config}=await setup(configOverride);
  await ensureTelegramUser(store,verified(2001),config);
  await saveAdminSettings(store,'900000001',{
    system:{realMoneyEnabled:true},
    payments:{depositsEnabled:true,withdrawalsEnabled:true,currency:'BDT',currencyExponent:2,minimumDepositMinor:100,maximumDepositMinor:100000,minimumWithdrawalMinor:100,maximumWithdrawalMinor:100000}
  },config);
  const settings=await getOperationalSettings(store,config);
  assert.equal(settings.payments.depositsEnabled,true);assert.equal(settings.payments.withdrawalsEnabled,true);
  const deposit=await createDeposit(store,'2001',{amountMinor:1000,method:'bkash',transactionReference:'provider-user-ref-001'},settings,'deposit-idempotency-key-0001');
  const replay=await createDeposit(store,'2001',{amountMinor:1000,method:'bkash',transactionReference:'provider-user-ref-001'},settings,'deposit-idempotency-key-0001');
  assert.equal(replay.replayed,true);assert.equal(replay.id,deposit.id);
  await decideDeposit(store,'900000001',deposit.id,{decision:'approve',evidenceReference:'provider-receipt-0001'},config,settings);
  let balance=await store.get('balances/2001');let finance=await store.get('systemStats/finance');
  assert.equal(balance.availableMinor,1000);assert.equal(balance.reservedMinor,0);
  assert.equal(finance.availableLiabilitiesMinor,1000);assert.equal(finance.verifiedDepositsMinor,1000);
  const withdrawal=await createWithdrawal(store,'2001',{amountMinor:300,payoutDetails:{method:'bkash',destination:'01712345678',accountName:'Test User'}},settings,'withdrawal-idempotency-key-0001');
  balance=await store.get('balances/2001');finance=await store.get('systemStats/finance');
  assert.equal(balance.availableMinor,700);assert.equal(balance.reservedMinor,300);
  assert.equal(finance.availableLiabilitiesMinor,700);assert.equal(finance.reservedLiabilitiesMinor,300);
  await decideWithdrawal(store,'900000001',withdrawal.id,{action:'approve'},config,settings);
  await decideWithdrawal(store,'900000001',withdrawal.id,{action:'processing'},config,settings);
  await decideWithdrawal(store,'900000001',withdrawal.id,{action:'paid',evidenceReference:'payout-confirmed-0001'},config,settings);
  balance=await store.get('balances/2001');finance=await store.get('systemStats/finance');
  assert.equal(balance.availableMinor,700);assert.equal(balance.reservedMinor,0);
  assert.equal(finance.availableLiabilitiesMinor,700);assert.equal(finance.reservedLiabilitiesMinor,0);
  assert.equal(finance.verifiedWithdrawalsMinor,300);
  const rejected=await createWithdrawal(store,'2001',{amountMinor:200,payoutDetails:{method:'bkash',destination:'01712345678'}},settings,'withdrawal-idempotency-key-0002');
  await decideWithdrawal(store,'900000001',rejected.id,{action:'reject',reason:'Recipient details failed manual review.'},config,settings);
  balance=await store.get('balances/2001');finance=await store.get('systemStats/finance');
  assert.equal(balance.availableMinor,700);assert.equal(balance.reservedMinor,0);
  assert.equal(finance.availableLiabilitiesMinor,700);assert.equal(finance.reservedLiabilitiesMinor,0);
  assert.equal(finance.pendingWithdrawals,0);
});

test('finance features remain unavailable unless provider and workflow switches are enabled',async()=>{
  const {store,config}=await setup();
  const settings=await getOperationalSettings(store,config);
  assert.equal(settings.payments.depositsEnabled,false);assert.equal(settings.payments.withdrawalsEnabled,false);
  await assert.rejects(createDeposit(store,'1',{amountMinor:100,method:'bkash',transactionReference:'ref-1234'},settings,'deposit-idempotency-key-0002'),error=>error.code==='deposits_not_configured');
});
