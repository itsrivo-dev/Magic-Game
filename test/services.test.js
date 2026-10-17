'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {MemoryStore}=require('../server/store');
const {
  initializeSettings,ensureTelegramUser,initializeGameProgress,getOperationalSettings,
  saveAdminSettings,syncGameProgress,claimReferralReward,createDeposit,decideDeposit,
  createWithdrawal,decideWithdrawal,createAdRewardSession,adminSummary,normalizePaymentSettings
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
  await saveAdminSettings(store,'900000001',{
    system:{emergencySwitches:{magicCoinRewardsPaused:false,referralRewardsPaused:false},safetyLimits:{maxMagicCoinsPerReward:500,maxMagicCoinsPerUserDaily:500,dailyMagicCoinsRewardBudget:1000,monthlyMagicCoinsRewardBudget:5000}},
    referrals:{enabled:true,qualificationLevel:1,qualificationHours:0,rewardMagicCoins:125}
  },config);
  const settings=await getOperationalSettings(store,config);
  const synced=await syncGameProgress(store,'1002',progress.state,progress.version,settings);
  assert.equal(synced.conflict,false);
  assert.equal((await store.get('referrals/1002')).status,'eligible');
  const reward=await claimReferralReward(store,'1001','1002',settings);
  assert.equal(reward.amount,125);assert.equal(reward.state.coins,150);
  assert.equal((await store.get('referrals/1002')).status,'rewarded');
  await assert.rejects(claimReferralReward(store,'1001','1002'),error=>error.code==='referral_reward_already_claimed');
  const summary=await adminSummary(store,settings);
  assert.equal(summary.users.total,2);
});

test('synthetic ledger transitions are idempotent and preserve available/reserved liability invariants',async()=>{
  const {store,config}=await setup({paymentCurrency:'BDT',paymentCurrencyExponent:2});
  await ensureTelegramUser(store,verified(2001),config);
  const operational=await getOperationalSettings(store,config);
  // Unit-test-only trusted settings exercise ledger math in MemoryStore; no provider or real funds are contacted.
  const settings={
    ...operational,
    system:{...operational.system,realMoneyEnabled:true,maintenanceMode:false,emergencySwitches:{...operational.system.emergencySwitches,depositsPaused:false,withdrawalsPaused:false},safetyLimits:{...operational.system.safetyLimits,maxPendingWithdrawalLiabilityMinor:100000,maxPendingWithdrawalPerUserMinor:100000,maxWithdrawalsPerUserDaily:5,maxWithdrawalPerUserDailyMinor:100000,maxPendingDepositsPerUser:5,maxDepositsPerUserDaily:5,maxDepositPerUserDailyMinor:5000}},
    payments:{...operational.payments,depositsEnabled:true,withdrawalsEnabled:true,providerVerified:true,methods:['bkash'],currency:'BDT',currencyExponent:2,minimumDepositMinor:100,maximumDepositMinor:100000,minimumWithdrawalMinor:100,maximumWithdrawalMinor:100000}
  };
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

test('finance features remain unavailable without a verified provider adapter',async()=>{
  const {store,config}=await setup();
  const settings=await getOperationalSettings(store,config);
  assert.equal(settings.system.realMoneyEnabled,false);
  assert.equal(settings.payments.providerVerified,false);
  assert.equal(settings.payments.depositsEnabled,false);assert.equal(settings.payments.withdrawalsEnabled,false);
  await assert.rejects(createDeposit(store,'1',{amountMinor:100,method:'bkash',transactionReference:'ref-1234'},settings,'deposit-idempotency-key-0002'),error=>error.code==='deposits_not_configured');
  await assert.rejects(createWithdrawal(store,'1',{amountMinor:100,payoutDetails:{method:'bkash',destination:'01712345678'}},settings,'withdrawal-idempotency-key-0002'),error=>error.code==='withdrawals_not_configured');
  await assert.rejects(saveAdminSettings(store,'900000001',{system:{realMoneyEnabled:true}},config),error=>error.code==='payment_provider_not_configured');
  await assert.rejects(saveAdminSettings(store,'900000001',{payments:{depositsEnabled:true}},config),error=>error.code==='deposit_provider_not_configured');
});

test('corrupt financial counter types fail closed and are audited',async()=>{
  const {store,config}=await setup({paymentCurrency:'BDT',paymentCurrencyExponent:2});
  await ensureTelegramUser(store,verified(2501),config);
  const operational=await getOperationalSettings(store,config);
  const settings={...operational,system:{...operational.system,realMoneyEnabled:true,emergencySwitches:{...operational.system.emergencySwitches,depositsPaused:false},safetyLimits:{...operational.system.safetyLimits,maxPendingDepositsPerUser:2,maxDepositsPerUserDaily:2,maxDepositPerUserDailyMinor:2000}},payments:{...operational.payments,providerVerified:true,depositsEnabled:true,methods:['bkash'],currency:'BDT',currencyExponent:2,minimumDepositMinor:100,maximumDepositMinor:1000}};
  const finance=await store.get('systemStats/finance');
  await store.set('systemStats/finance',{...finance,availableLiabilitiesMinor:'0'});
  await assert.rejects(createDeposit(store,'2501',{amountMinor:100,method:'bkash',transactionReference:'corrupt-counter-ref'},settings,'corrupt-ledger-test-key-0001'),error=>error.code==='financial_ledger_corrupt');
  assert.equal((await store.list('deposits')).length,0);
  assert.equal((await store.list('securityEvents'))[0].data.reason,'financial_ledger_corrupt');
});

test('Magic Coin caps block over-budget referral awards transactionally and write audit events',async()=>{
  const {store,config}=await setup();
  const inviter=await ensureTelegramUser(store,verified(3001),config);
  const firstInvitee=await ensureTelegramUser(store,verified(3002,`ref_${inviter.user.referralCode}`),config);
  const secondInvitee=await ensureTelegramUser(store,verified(3003,`ref_${inviter.user.referralCode}`),config);
  await initializeGameProgress(store,'3001',null,false);
  const firstProgress=await initializeGameProgress(store,'3002',null,false);
  const secondProgress=await initializeGameProgress(store,'3003',null,false);
  await saveAdminSettings(store,'900000001',{
    system:{emergencySwitches:{magicCoinRewardsPaused:false,referralRewardsPaused:false},safetyLimits:{maxMagicCoinsPerReward:100,maxMagicCoinsPerUserDaily:100,dailyMagicCoinsRewardBudget:500,monthlyMagicCoinsRewardBudget:1000}},
    referrals:{enabled:true,qualificationLevel:1,qualificationHours:0,rewardMagicCoins:75}
  },config);
  const settings=await getOperationalSettings(store,config);
  await syncGameProgress(store,'3002',firstProgress.state,firstProgress.version,settings);
  await syncGameProgress(store,'3003',secondProgress.state,secondProgress.version,settings);
  assert.equal((await store.get('referrals/3002')).status,'eligible');
  assert.equal((await store.get('referrals/3003')).status,'eligible');
  const first=await claimReferralReward(store,'3001','3002',settings);
  assert.equal(first.amount,75);
  const before=await store.get('gameProgress/3001');
  await assert.rejects(claimReferralReward(store,'3001','3003',settings),error=>error.code==='magic_coin_user_daily_limit_reached');
  assert.equal((await store.get('gameProgress/3001')).state.coins,before.state.coins);
  assert.equal((await store.get('referrals/3003')).status,'eligible');
  assert.equal((await store.list('securityEvents')).filter(row=>row.data.event==='safety_guard_blocked').length,1);
  assert.equal((await store.list('adminLogs')).filter(row=>row.data.action==='safety.guard.blocked').length,1);
});

test('per-user financial limits deny over-cap requests and create safety audit records',async()=>{
  const {store,config}=await setup({paymentCurrency:'BDT',paymentCurrencyExponent:2});
  await ensureTelegramUser(store,verified(5001),config);
  const operational=await getOperationalSettings(store,config);
  const settings={
    ...operational,
    system:{...operational.system,realMoneyEnabled:true,emergencySwitches:{...operational.system.emergencySwitches,depositsPaused:false,withdrawalsPaused:false},safetyLimits:{...operational.system.safetyLimits,maxPendingWithdrawalLiabilityMinor:250,maxPendingWithdrawalPerUserMinor:250,maxWithdrawalsPerUserDaily:5,maxWithdrawalPerUserDailyMinor:1000,maxPendingDepositsPerUser:5,maxDepositsPerUserDaily:5,maxDepositPerUserDailyMinor:1500}},
    payments:{...operational.payments,providerVerified:true,depositsEnabled:true,withdrawalsEnabled:true,methods:['bkash'],currency:'BDT',currencyExponent:2,minimumDepositMinor:100,maximumDepositMinor:100000,minimumWithdrawalMinor:100,maximumWithdrawalMinor:100000}
  };
  const deposit=await createDeposit(store,'5001',{amountMinor:1000,method:'bkash',transactionReference:'user-deposit-ref-1001'},settings,'deposit-cap-test-key-0001');
  await assert.rejects(createDeposit(store,'5001',{amountMinor:600,method:'bkash',transactionReference:'user-deposit-ref-1002'},settings,'deposit-cap-test-key-0002'),error=>error.code==='deposit_daily_amount_limit_reached');
  await decideDeposit(store,'900000001',deposit.id,{decision:'approve',evidenceReference:'manual-receipt-test-1001'},config,settings);
  const withdrawal=await createWithdrawal(store,'5001',{amountMinor:200,payoutDetails:{method:'bkash',destination:'01712345678'}},settings,'withdrawal-cap-test-key-0001');
  await assert.rejects(createWithdrawal(store,'5001',{amountMinor:100,payoutDetails:{method:'bkash',destination:'01712345678'}},settings,'withdrawal-cap-test-key-0002'),error=>error.code==='pending_withdrawal_liability_limit_reached');
  assert.equal((await store.get(`withdrawals/${withdrawal.id}`)).status,'pending');
  const blocked=(await store.list('securityEvents')).filter(row=>row.data.event==='safety_guard_blocked');
  assert.deepEqual(blocked.map(row=>row.data.reason).sort(),['deposit_daily_amount_limit_reached','pending_withdrawal_liability_limit_reached']);
  assert.equal((await store.list('adminLogs')).filter(row=>row.data.action==='safety.guard.blocked').length,2);
});

test('server emergency switches pause referrals and monetization; paused referral attribution is ignored',async()=>{
  const {store,config}=await setup();
  const inviter=await ensureTelegramUser(store,verified(4001),config);
  await saveAdminSettings(store,'900000001',{system:{emergencySwitches:{referralsPaused:true,monetizationPaused:true}}},config);
  const settings=await getOperationalSettings(store,config);
  const invitee=await ensureTelegramUser(store,verified(4002,`ref_${inviter.user.referralCode}`),config,settings);
  assert.equal((await store.get('users/4002')).referredByUid,null);
  assert.equal(await store.get('referrals/4002'),null);
  assert.equal(settings.adsReady,false);
  assert.equal(settings.referrals.enabled,false);
  await assert.rejects(createAdRewardSession(store,'4002',settings),error=>error.code==='rewarded_ads_not_configured');
});
