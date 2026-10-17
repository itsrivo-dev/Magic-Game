'use strict';

const crypto = require('node:crypto');
const {
  starterSave, sanitizeSave, syncValidation, estimateCps, xpLevel, MAGES, MAGE_MAP,
  TOWER, TOWER_COSTS, referralCode
} = require('./game-state');
const { sha256 } = require('./store');

class AppError extends Error {
  constructor(status, code, message = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const DEFAULT_GAME_SETTINGS = Object.freeze({
  mageCosts: {},
  mageCps: {},
  mageUpgradeBaseCosts: {},
  towerCosts: TOWER_COSTS.slice(),
  towerBonuses: TOWER.slice(),
  questRewardMultiplier: 1,
  achievementRewardMultiplier: 1,
  battleRewardMultiplier: 1,
  offlineCapHours: 8,
  offlineEfficiency: 0.55
});
const DEFAULT_AD_SETTINGS = Object.freeze({
  enabled: false,
  publisherId: '',
  mainZoneId: '',
  placements: { interstitial: 'stage_break', rewarded: 'optional_bonus' },
  formats: { inAppInterstitial: false, rewardedInterstitial: false, rewardedPopup: false },
  interstitialFrequency: 1,
  interstitialCappingHours: 1,
  interstitialIntervalSeconds: 600,
  interstitialTimeoutSeconds: 180,
  rewardedMagicCoins: 0
});
const DEFAULT_REFERRAL_SETTINGS = Object.freeze({
  enabled: true,
  qualificationLevel: 5,
  qualificationHours: 24,
  rewardMagicCoins: 0
});
const DEFAULT_EMERGENCY_SWITCHES = Object.freeze({
  depositsPaused: true,
  withdrawalsPaused: true,
  cashRewardsPaused: true,
  magicCoinRewardsPaused: true,
  referralsPaused: false,
  referralRewardsPaused: true,
  monetizationPaused: true
});
const DEFAULT_SAFETY_LIMITS = Object.freeze({
  maxPendingWithdrawalLiabilityMinor: 0,
  maxPendingWithdrawalPerUserMinor: 0,
  maxWithdrawalsPerUserDaily: 0,
  maxWithdrawalPerUserDailyMinor: 0,
  maxPendingDepositsPerUser: 0,
  maxDepositsPerUserDaily: 0,
  maxDepositPerUserDailyMinor: 0,
  maxMagicCoinsPerReward: 0,
  maxMagicCoinsPerUserDaily: 0,
  dailyMagicCoinsRewardBudget: 0,
  monthlyMagicCoinsRewardBudget: 0,
  maxCashRewardPerUserMinor: 0,
  dailyCashRewardBudgetMinor: 0,
  monthlyCashRewardBudgetMinor: 0,
  maxTotalCashRewardLiabilityMinor: 0
});
const DEFAULT_SYSTEM_SETTINGS = Object.freeze({
  maintenanceMode: false,
  announcement: '',
  realMoneyEnabled: false,
  rewardBudgetCapMinor: 0,
  emergencySwitches: DEFAULT_EMERGENCY_SWITCHES,
  safetyLimits: DEFAULT_SAFETY_LIMITS,
  supportedPaymentMethods: []
});
const DEFAULT_PAYMENT_SETTINGS = Object.freeze({
  depositsEnabled: false,
  withdrawalsEnabled: false,
  minimumDepositMinor: 0,
  maximumDepositMinor: 0,
  minimumWithdrawalMinor: 0,
  maximumWithdrawalMinor: 0,
  currency: '',
  currencyExponent: 2
});
const FINANCE_DEFAULT = Object.freeze({
  pendingDeposits: 0,
  pendingWithdrawals: 0,
  verifiedDepositsMinor: 0,
  verifiedWithdrawalsMinor: 0,
  availableLiabilitiesMinor: 0,
  reservedLiabilitiesMinor: 0,
  rewardExpensesMinor: 0,
  updatedAtMs: 0
});
const MAX_LEDGER_AMOUNT = 1_000_000_000_000;
const MAX_GAME_REWARD = 100_000_000;
const RESERVED_COLLECTIONS = new Set(['users','gameProgress','balances','transactions','deposits','withdrawals','referrals','referralCodes','adminLogs','securityEvents','adminNotes','gameLedger','adRewards','idempotency','depositReferences','depositLimits','withdrawalLimits','rewardBudgets','systemSettings','gameSettings','adSettings','paymentSettings','referralSettings','systemStats']);

function asInt(value, fallback = 0, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) return fallback;
  return n;
}
function storedLedgerInt(value, fallback = -1, min = 0, max = MAX_LEDGER_AMOUNT) {
  if (typeof value !== 'number') return fallback;
  return asInt(value,fallback,min,max);
}
function asString(value, max = 256) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function safeId(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value); }
function safeTelegramId(value) {
  const uid=String(value ?? '');
  if(!/^\d{1,20}$/.test(uid)||BigInt(uid)<=0n) throw new AppError(400,'invalid_telegram_user_id');
  return uid;
}
function cleanDoc(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function publicProfile(user) {
  return {
    telegramId: String(user.telegramId),
    firstName: user.firstName || '',
    ...(user.lastName ? { lastName: user.lastName } : {}),
    ...(user.username ? { username: user.username } : {}),
    ...(user.photoUrl ? { photoUrl: user.photoUrl } : {}),
    ...(user.languageCode ? { languageCode: user.languageCode } : {}),
    createdAtMs: user.createdAtMs,
    lastActivityAtMs: user.lastActivityAtMs,
    status: user.accountStatus || 'active',
    referralCode: user.referralCode,
    referralCount: Number(user.referralCount) || 0,
    ...(user.referredByUid ? { referredBy: String(user.referredByUid) } : {}),
    preferences: user.preferences || { sound: true, motion: null, haptics: true }
  };
}
function safeClientBalance(balance, payment) {
  return {
    currency: payment.currency || null,
    currencyExponent: payment.currencyExponent,
    availableMinor: asInt(balance && balance.availableMinor, 0, 0, MAX_LEDGER_AMOUNT),
    reservedMinor: asInt(balance && balance.reservedMinor, 0, 0, MAX_LEDGER_AMOUNT)
  };
}
function isValidCode(value) { return typeof value === 'string' && /^[A-Z0-9]{6,16}$/.test(value); }
function timestampValue(store) { return store.timestamp ? store.timestamp() : new Date(); }
function utcPeriods(now = Date.now()) {
  const date = new Date(now);
  return { day:date.toISOString().slice(0,10), month:date.toISOString().slice(0,7) };
}
function recordSafetyBlock(tx, store, uid, operation, reason, details = {}) {
  const id = crypto.randomUUID();
  const now = Date.now();
  const safeDetails = Object.fromEntries(Object.entries(details).filter(([,value]) =>
    typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean'
      || typeof value === 'string' && value.length <= 80
  ));
  tx.create(`securityEvents/${id}`,{
    id,event:'safety_guard_blocked',operation,reason,userId:String(uid),details:safeDetails,
    createdAt:timestampValue(store),createdAtMs:now
  });
  tx.create(`adminLogs/${id}`,{
    id,actorUid:'system',action:'safety.guard.blocked',targetUid:String(uid),targetId:operation,
    details:{reason,...safeDetails},createdAt:timestampValue(store),createdAtMs:now
  });
  return { blocked:true,code:reason };
}
function financialLedgerError(raw) {
  if (!raw) return 'financial_ledger_uninitialized';
  const finance = { ...FINANCE_DEFAULT,...cleanDoc(raw) };
  const values = [
    finance.verifiedDepositsMinor,finance.verifiedWithdrawalsMinor,finance.availableLiabilitiesMinor,
    finance.reservedLiabilitiesMinor,finance.rewardExpensesMinor,
    finance.pendingDeposits,finance.pendingWithdrawals
  ].map(value => storedLedgerInt(value,-1,0,MAX_LEDGER_AMOUNT));
  if (values.some(value => value < 0)) return 'financial_ledger_corrupt';
  const [deposits,withdrawals,available,reserved,rewards] = values;
  const expectedLiability = deposits - withdrawals - rewards;
  if (expectedLiability < 0 || available + reserved !== expectedLiability) return 'financial_ledger_discrepancy';
  return '';
}
async function planMagicCoinRewardBudget(tx, store, uid, amount, safetyLimits, source, now = Date.now()) {
  const limits = normalizeSafetyLimits(safetyLimits);
  const {day,month} = utcPeriods(now);
  const baseDetails = {source,amountMagicCoins:amount};
  if (amount <= 0 || amount > limits.maxMagicCoinsPerReward || limits.maxMagicCoinsPerReward <= 0
      || limits.maxMagicCoinsPerUserDaily <= 0 || limits.dailyMagicCoinsRewardBudget <= 0
      || limits.monthlyMagicCoinsRewardBudget <= 0) {
    return recordSafetyBlock(tx,store,uid,source,'magic_coin_reward_limits_not_configured',baseDetails);
  }
  const userPath = `rewardBudgets/user_${uid}_day_${day}`;
  const dayPath = `rewardBudgets/global_day_${day}`;
  const monthPath = `rewardBudgets/global_month_${month}`;
  const [userRaw,dayRaw,monthRaw] = await Promise.all([tx.get(userPath),tx.get(dayPath),tx.get(monthPath)]);
  const count = (row,key,period) => {
    if (!row || row.periodKey !== period) return 0;
    return storedLedgerInt(row[key],-1,0,MAX_GAME_REWARD * 1_000_000);
  };
  const userTotal = count(userRaw,'amountMagicCoins',day);
  const dailyTotal = count(dayRaw,'amountMagicCoins',day);
  const monthlyTotal = count(monthRaw,'amountMagicCoins',month);
  if (userTotal < 0 || dailyTotal < 0 || monthlyTotal < 0) {
    return recordSafetyBlock(tx,store,uid,source,'magic_coin_reward_budget_discrepancy',baseDetails);
  }
  if (userTotal + amount > limits.maxMagicCoinsPerUserDaily) {
    return recordSafetyBlock(tx,store,uid,source,'magic_coin_user_daily_limit_reached',{
      ...baseDetails,limit:limits.maxMagicCoinsPerUserDaily,current:userTotal
    });
  }
  if (dailyTotal + amount > limits.dailyMagicCoinsRewardBudget) {
    return recordSafetyBlock(tx,store,uid,source,'magic_coin_daily_budget_exhausted',{
      ...baseDetails,limit:limits.dailyMagicCoinsRewardBudget,current:dailyTotal
    });
  }
  if (monthlyTotal + amount > limits.monthlyMagicCoinsRewardBudget) {
    return recordSafetyBlock(tx,store,uid,source,'magic_coin_monthly_budget_exhausted',{
      ...baseDetails,limit:limits.monthlyMagicCoinsRewardBudget,current:monthlyTotal
    });
  }
  return {
    userPath,dayPath,monthPath,day,month,
    userTotal:userTotal+amount,dailyTotal:dailyTotal+amount,monthlyTotal:monthlyTotal+amount
  };
}
function commitMagicCoinRewardBudget(tx, store, uid, plan, now = Date.now()) {
  const updatedAt = timestampValue(store);
  tx.set(plan.userPath,{userId:String(uid),periodKey:plan.day,amountMagicCoins:plan.userTotal,updatedAt,updatedAtMs:now},{merge:true});
  tx.set(plan.dayPath,{periodKey:plan.day,amountMagicCoins:plan.dailyTotal,updatedAt,updatedAtMs:now},{merge:true});
  tx.set(plan.monthPath,{periodKey:plan.month,amountMagicCoins:plan.monthlyTotal,updatedAt,updatedAtMs:now},{merge:true});
}
function appIdempotencyPath(uid, type, key) {
  if (typeof key !== 'string' || key.length < 16 || key.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(key)) throw new AppError(400, 'idempotency_key_required');
  return `idempotency/${sha256(`${uid}:${type}:${key}`)}`;
}
function validateAmount(amountMinor) {
  const amount = Number(amountMinor);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_LEDGER_AMOUNT) throw new AppError(400, 'invalid_amount_minor');
  return amount;
}
function validateEvidence(value) {
  const text = asString(value, 160);
  if (text.length < 6 || !/^[A-Za-z0-9._:/-]+$/.test(text)) throw new AppError(400, 'external_evidence_reference_required');
  return text;
}
function safePaymentDetails(raw, allowedMethods) {
  const method = asString(raw && raw.method, 32).toLowerCase();
  const destination = asString(raw && raw.destination, 256);
  const accountName = asString(raw && raw.accountName, 100);
  if (!allowedMethods.includes(method)) throw new AppError(400, 'unsupported_payment_method');
  if (destination.length < 4) throw new AppError(400, 'payout_destination_required');
  return { method, destination, ...(accountName ? { accountName } : {}) };
}
function maskDestination(value) {
  const text = String(value || '');
  if (text.length < 6) return '••••';
  return `${text.slice(0, 2)}••••${text.slice(-2)}`;
}
function maskWithdrawal(row) {
  const copy = { ...row };
  if (copy.payoutDetails) copy.payoutDetails = { method: copy.payoutDetails.method, destination: maskDestination(copy.payoutDetails.destination), ...(copy.payoutDetails.accountName ? { accountName: copy.payoutDetails.accountName } : {}) };
  if (copy.userReference) copy.userReference = maskDestination(copy.userReference);
  return copy;
}
function stableString(value) { return String(value || '').trim().toLowerCase().replace(/\s+/g, ' '); }
function safeSettingNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) return fallback;
  return number;
}
function validStringId(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value); }
function normalizeGameSettings(raw = {}) {
  const out = structuredClone(DEFAULT_GAME_SETTINGS);
  if (raw && typeof raw === 'object') {
    for (const key of ['mageCosts','mageCps','mageUpgradeBaseCosts']) {
      const input = cleanDoc(raw[key]);
      for (const id of MAGE_MAP.keys()) if (Object.hasOwn(input,id)) {
        const value = safeSettingNumber(input[id], out[key][id] ?? 0, 0, 1e12);
        out[key][id] = Math.round(value * 1000) / 1000;
      }
    }
    if (Array.isArray(raw.towerCosts) && raw.towerCosts.length === 14) out.towerCosts = raw.towerCosts.map((v,i) => Math.round(safeSettingNumber(v, DEFAULT_GAME_SETTINGS.towerCosts[i], 0, 1e15)));
    if (Array.isArray(raw.towerBonuses) && raw.towerBonuses.length === 14) out.towerBonuses = raw.towerBonuses.map((v,i) => Math.round(safeSettingNumber(v, DEFAULT_GAME_SETTINGS.towerBonuses[i], 0, 5) * 10000) / 10000);
    out.questRewardMultiplier = safeSettingNumber(raw.questRewardMultiplier, 1, 0.1, 5);
    out.achievementRewardMultiplier = safeSettingNumber(raw.achievementRewardMultiplier, 1, 0.1, 5);
    out.battleRewardMultiplier = safeSettingNumber(raw.battleRewardMultiplier, 1, 0.1, 5);
    out.offlineCapHours = safeSettingNumber(raw.offlineCapHours, 8, 1, 24);
    out.offlineEfficiency = safeSettingNumber(raw.offlineEfficiency, 0.55, 0.1, 1);
  }
  return out;
}
function normalizeAdSettings(raw = {}) {
  const src = cleanDoc(raw);
  const placements = cleanDoc(src.placements);
  const formats = cleanDoc(src.formats);
  const out = {
    ...structuredClone(DEFAULT_AD_SETTINGS),
    enabled: src.enabled === true,
    publisherId: /^[A-Za-z0-9_-]{1,64}$/.test(String(src.publisherId || '')) ? String(src.publisherId) : '',
    mainZoneId: /^\d{1,20}$/.test(String(src.mainZoneId || '')) ? String(src.mainZoneId) : '',
    placements: {
      interstitial: /^[A-Za-z0-9._-]{1,48}$/.test(String(placements.interstitial || '')) ? String(placements.interstitial) : 'stage_break',
      rewarded: /^[A-Za-z0-9._-]{1,48}$/.test(String(placements.rewarded || '')) ? String(placements.rewarded) : 'optional_bonus'
    },
    formats: {
      inAppInterstitial: formats.inAppInterstitial === true,
      rewardedInterstitial: formats.rewardedInterstitial === true,
      rewardedPopup: formats.rewardedPopup === true
    },
    interstitialFrequency: asInt(src.interstitialFrequency, 1, 1, 3),
    interstitialCappingHours: asInt(src.interstitialCappingHours, 1, 1, 24),
    interstitialIntervalSeconds: asInt(src.interstitialIntervalSeconds, 600, 300, 86400),
    interstitialTimeoutSeconds: asInt(src.interstitialTimeoutSeconds, 180, 60, 3600),
    rewardedMagicCoins: asInt(src.rewardedMagicCoins, 0, 0, MAX_GAME_REWARD)
  };
  return out;
}
function normalizeReferralSettings(raw = {}) {
  const src = cleanDoc(raw);
  return {
    enabled: src.enabled !== false,
    qualificationLevel: asInt(src.qualificationLevel, 5, 1, 100),
    qualificationHours: asInt(src.qualificationHours, 24, 0, 8760),
    rewardMagicCoins: asInt(src.rewardMagicCoins, 0, 0, MAX_GAME_REWARD)
  };
}
function normalizeEmergencySwitches(raw = {}) {
  const src = cleanDoc(raw);
  return Object.fromEntries(Object.keys(DEFAULT_EMERGENCY_SWITCHES).map(key => [
    key,
    Object.hasOwn(src,key) ? src[key] === true : DEFAULT_EMERGENCY_SWITCHES[key]
  ]));
}
function normalizeSafetyLimits(raw = {}) {
  const src = cleanDoc(raw);
  const out = { ...DEFAULT_SAFETY_LIMITS };
  for (const key of Object.keys(DEFAULT_SAFETY_LIMITS)) {
    const max = key.includes('MagicCoins') ? MAX_GAME_REWARD : MAX_LEDGER_AMOUNT;
    out[key] = asInt(src[key],DEFAULT_SAFETY_LIMITS[key],0,max);
  }
  return out;
}
function normalizeSystemSettings(raw = {}) {
  const src = cleanDoc(raw);
  const methods = Array.isArray(src.supportedPaymentMethods) ? src.supportedPaymentMethods.filter(m => typeof m === 'string' && /^[a-z0-9_-]{2,32}$/i.test(m)).slice(0,8) : [];
  return {
    maintenanceMode: src.maintenanceMode === true,
    announcement: asString(src.announcement, 500),
    realMoneyEnabled: src.realMoneyEnabled === true,
    rewardBudgetCapMinor: 0,
    emergencySwitches: normalizeEmergencySwitches(src.emergencySwitches),
    safetyLimits: normalizeSafetyLimits(src.safetyLimits),
    supportedPaymentMethods: methods
  };
}
function normalizePaymentSettings(raw = {}, config) {
  const src = cleanDoc(raw);
  const fallbackExponent = Number.isInteger(config.paymentCurrencyExponent) ? config.paymentCurrencyExponent : 2;
  const exponent = asInt(src.currencyExponent, fallbackExponent, 0, 4);
  const currency = (config.paymentCurrency || src.currency || '').toUpperCase();
  return {
    depositsEnabled: src.depositsEnabled === true,
    withdrawalsEnabled: src.withdrawalsEnabled === true,
    minimumDepositMinor: asInt(src.minimumDepositMinor, config.paymentMinDepositMinor, 0, MAX_LEDGER_AMOUNT),
    maximumDepositMinor: asInt(src.maximumDepositMinor, config.paymentMaxDepositMinor, 0, MAX_LEDGER_AMOUNT),
    minimumWithdrawalMinor: asInt(src.minimumWithdrawalMinor, config.paymentMinWithdrawalMinor, 0, MAX_LEDGER_AMOUNT),
    maximumWithdrawalMinor: asInt(src.maximumWithdrawalMinor, config.paymentMaxWithdrawalMinor, 0, MAX_LEDGER_AMOUNT),
    currency: /^[A-Z]{3}$/.test(currency) ? currency : '',
    currencyExponent: exponent
  };
}
async function getOperationalSettings(store, config) {
  const [systemRaw, gameRaw, adRaw, paymentRaw, referralRaw] = await Promise.all([
    store.get('systemSettings/public'), store.get('gameSettings/current'), store.get('adSettings/current'),
    store.get('paymentSettings/current'), store.get('referralSettings/current')
  ]);
  const system = normalizeSystemSettings(systemRaw);
  const game = normalizeGameSettings(gameRaw);
  const ads = normalizeAdSettings({ ...DEFAULT_AD_SETTINGS, ...cleanDoc(adRaw) });
  if (!ads.publisherId && config.monetagPublisherId) ads.publisherId = String(config.monetagPublisherId).slice(0,64);
  if (!ads.mainZoneId && config.monetagMainZoneId) ads.mainZoneId = String(config.monetagMainZoneId);
  if (config.monetagIntegrationVerified !== true) ads.enabled = false;
  const payment = normalizePaymentSettings(paymentRaw, config);
  const referrals = normalizeReferralSettings(referralRaw);
  const switches = system.emergencySwitches;
  const limits = system.safetyLimits;

  // No server-to-server payment/payout adapter is implemented or verified in this app.
  // Manual notes or a provider name are not proof of payment, so production workflows stay off.
  const paymentProviderConfigured = false;
  const payoutProviderConfigured = false;
  system.realMoneyEnabled = false;
  const depositsEnabled = !switches.depositsPaused && system.realMoneyEnabled && payment.depositsEnabled && paymentProviderConfigured;
  const withdrawalsEnabled = !switches.withdrawalsPaused && system.realMoneyEnabled && payment.withdrawalsEnabled && payoutProviderConfigured;
  const adsReady = !switches.monetizationPaused && ads.enabled && config.monetagIntegrationVerified === true
    && !!config.monetagSdkUrl && /^\d{1,20}$/.test(ads.mainZoneId);
  const magicCoinRewardBudgetsConfigured = limits.maxMagicCoinsPerReward > 0
    && limits.maxMagicCoinsPerUserDaily > 0
    && limits.dailyMagicCoinsRewardBudget > 0
    && limits.monthlyMagicCoinsRewardBudget > 0;
  if (switches.referralsPaused || switches.referralRewardsPaused || switches.magicCoinRewardsPaused) referrals.enabled = false;
  return {
    system, game, ads, payment, referrals,
    payments: {
      provider: 'not_configured',
      payoutProvider: 'not_configured',
      providerVerified: false,
      depositsEnabled,
      withdrawalsEnabled,
      currency: payment.currency,
      currencyExponent: payment.currencyExponent,
      minimumDepositMinor: payment.minimumDepositMinor || config.paymentMinDepositMinor,
      maximumDepositMinor: payment.maximumDepositMinor || config.paymentMaxDepositMinor,
      minimumWithdrawalMinor: payment.minimumWithdrawalMinor || config.paymentMinWithdrawalMinor,
      maximumWithdrawalMinor: payment.maximumWithdrawalMinor || config.paymentMaxWithdrawalMinor,
      methods: [],
      instructions: '',
      status: 'provider_not_implemented'
    },
    adsReady,
    rewardedReady: adsReady && !switches.adRewardsPaused && !switches.magicCoinRewardsPaused
      && ads.formats.rewardedInterstitial && !!config.monetagPostbackSecret && ads.rewardedMagicCoins > 0
      && magicCoinRewardBudgetsConfigured
  };
}

async function initializeSettings(store, config) {
  const now = Date.now();
  const seed = cleanDoc(config.systemSettingsSeed);
  const systemSeed = normalizeSystemSettings({ ...DEFAULT_SYSTEM_SETTINGS, ...cleanDoc(seed.system || seed) });
  systemSeed.realMoneyEnabled=false;
  systemSeed.rewardBudgetCapMinor=0;
  systemSeed.emergencySwitches={...systemSeed.emergencySwitches,depositsPaused:true,withdrawalsPaused:true,cashRewardsPaused:true,magicCoinRewardsPaused:true,referralRewardsPaused:true,monetizationPaused:true};
  const gameSeed = normalizeGameSettings({ ...DEFAULT_GAME_SETTINGS, ...cleanDoc(seed.game) });
  const adSeed = normalizeAdSettings({ ...DEFAULT_AD_SETTINGS, ...cleanDoc(seed.ads) });
  const paymentSeed = normalizePaymentSettings({
    ...DEFAULT_PAYMENT_SETTINGS,
    ...cleanDoc(seed.payments || seed.payment),
    currency: config.paymentCurrency || (seed.payments && seed.payments.currency) || ''
  },config);
  const referralSeed = normalizeReferralSettings({ ...DEFAULT_REFERRAL_SETTINGS, ...cleanDoc(seed.referrals) });
  const defaults = [
    ['systemSettings/public', systemSeed],
    ['gameSettings/current', gameSeed],
    ['adSettings/current', adSeed],
    ['paymentSettings/current', {
      ...paymentSeed,
      currency: config.paymentCurrency || paymentSeed.currency || '',
      currencyExponent: Number.isInteger(config.paymentCurrencyExponent) ? config.paymentCurrencyExponent : paymentSeed.currencyExponent,
      minimumDepositMinor: config.paymentMinDepositMinor || paymentSeed.minimumDepositMinor || 0,
      maximumDepositMinor: config.paymentMaxDepositMinor || paymentSeed.maximumDepositMinor || 0,
      minimumWithdrawalMinor: config.paymentMinWithdrawalMinor || paymentSeed.minimumWithdrawalMinor || 0,
      maximumWithdrawalMinor: config.paymentMaxWithdrawalMinor || paymentSeed.maximumWithdrawalMinor || 0
    }],
    ['referralSettings/current', referralSeed],
    ['systemStats/finance', { ...FINANCE_DEFAULT, updatedAtMs: now }]
  ];
  for (const [path, data] of defaults) {
    await store.runTransaction(async tx => {
      const current = await tx.get(path);
      if (!current) tx.create(path, { ...structuredClone(data), createdAt: timestampValue(store), updatedAt: timestampValue(store) });
    });
  }
}

function publicOperationalConfig(settings, config) {
  const formats = settings.ads.formats;
  return {
    maintenanceMode: settings.system.maintenanceMode,
    announcement: settings.system.announcement,
    game: settings.game,
    monetag: {
      enabled: settings.adsReady,
      publisherId: settings.adsReady ? settings.ads.publisherId : '',
      mainZoneId: settings.adsReady ? settings.ads.mainZoneId : '',
      sdkUrl: settings.adsReady ? config.monetagSdkUrl : '',
      formats: {
        inAppInterstitial: settings.adsReady && formats.inAppInterstitial,
        rewardedInterstitial: settings.rewardedReady,
        rewardedPopup: settings.adsReady && formats.rewardedPopup && !!config.monetagPostbackSecret
      },
      placements: settings.ads.placements,
      interstitialFrequency: settings.ads.interstitialFrequency,
      interstitialCappingHours: settings.ads.interstitialCappingHours,
      interstitialIntervalSeconds: settings.ads.interstitialIntervalSeconds,
      interstitialTimeoutSeconds: settings.ads.interstitialTimeoutSeconds
    },
    finance: {
      depositsEnabled: settings.payments.depositsEnabled,
      withdrawalsEnabled: settings.payments.withdrawalsEnabled,
      currency: settings.payments.currency || null,
      currencyExponent: settings.payments.currencyExponent,
      minimumDepositMinor: settings.payments.minimumDepositMinor,
      minimumWithdrawalMinor: settings.payments.minimumWithdrawalMinor,
      paymentMethods: settings.payments.methods
    }
  };
}

async function ensureTelegramUser(store, verified, config, settings = null) {
  const telegram = verified.user;
  const uid = String(telegram.id);
  const userPath = `users/${uid}`;
  const referralsPaused = settings && settings.system && settings.system.emergencySwitches && settings.system.emergencySwitches.referralsPaused === true;
  const referralParam = !referralsPaused && verified.startParam && verified.startParam.startsWith('ref_') ? verified.startParam.slice(4).toUpperCase() : '';
  const now = Date.now();
  const result = await store.runTransaction(async tx => {
    const old = await tx.get(userPath);
    let referralOwner = null;
    if (!old && referralParam && isValidCode(referralParam)) {
      const codeDoc = await tx.get(`referralCodes/${referralParam}`);
      if (codeDoc && String(codeDoc.ownerUid) !== uid) referralOwner = String(codeDoc.ownerUid);
    }
    const referrer = referralOwner ? await tx.get(`users/${referralOwner}`) : null;
    if (!referrer || referrer.accountStatus !== 'active') referralOwner = null;
    let code = old && isValidCode(old.referralCode) ? old.referralCode : '';
    let freeCodePath = '';
    if (!code) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = referralCode();
        const existingCode = await tx.get(`referralCodes/${candidate}`);
        if (!existingCode) { code = candidate; freeCodePath = `referralCodes/${candidate}`; break; }
      }
      if (!code) throw new AppError(503, 'referral_code_allocation_failed');
    }
    const balancePath = `balances/${uid}`;
    const balance = await tx.get(balancePath);
    const relationshipPath = `referrals/${uid}`;
    const relationship = !old && referralOwner ? await tx.get(relationshipPath) : null;
    const profile = {
      telegramId:uid,
      firstName:telegram.firstName,
      lastName:telegram.lastName || null,
      username:telegram.username || null,
      usernameLower:telegram.username ? telegram.username.toLowerCase() : '',
      photoUrl:telegram.photoUrl || null,
      languageCode:telegram.languageCode || null,
      isPremium:telegram.isPremium === true,
      accountStatus:old && ['active','suspended','banned'].includes(old.accountStatus) ? old.accountStatus : 'active',
      referralCode:code,
      referralCount:Number(old && old.referralCount) || 0,
      referredByUid:(old && old.referredByUid) || (referrer && referralOwner !== uid ? referralOwner : null),
      preferences:old && old.preferences ? old.preferences : { sound:true,motion:null,haptics:true },
      gameProgressId:uid,
      createdAt:old ? old.createdAt : timestampValue(store),
      createdAtMs:old ? (Number(old.createdAtMs) || now) : now,
      lastActivityAt:timestampValue(store),
      lastActivityAtMs:now,
      lastTelegramAuthAtMs:now
    };

    // Firestore requires every transaction read to happen before the first write.
    if (old) tx.set(userPath,profile,{merge:true});
    else tx.create(userPath,profile);
    if (!balance) tx.create(balancePath,{userId:uid,currency:config.paymentCurrency || null,availableMinor:0,reservedMinor:0,createdAt:timestampValue(store),updatedAt:timestampValue(store)});
    if (freeCodePath) tx.create(freeCodePath,{code,ownerUid:uid,createdAt:timestampValue(store),createdAtMs:now});
    if (!old && referrer && !relationship) {
      tx.create(relationshipPath,{
        refereeUid:uid,referrerUid:referralOwner,referralCode:referralParam,status:'pending',
        createdAt:timestampValue(store),createdAtMs:now,qualifiedAtMs:null,rewardedAtMs:null,
        rewardMagicCoins:0,reviewNote:null
      });
      tx.set(`users/${referralOwner}`,{
        referralCount:(Number(referrer.referralCount) || 0) + 1,
        lastReferralAt:timestampValue(store),lastReferralAtMs:now
      },{merge:true});
    }
    return {profile,created:!old};
  });

  if (result.profile.accountStatus !== 'active') throw new AppError(403,'account_not_active');
  return {user:publicProfile(result.profile),created:result.created};
}

async function getGameProgress(store, uid) {
  const row = await store.get(`gameProgress/${uid}`);
  if (!row || !row.state) return { exists:false, state:null, version:0, migrationStatus:null };
  const state = sanitizeSave(row.state, Date.now());
  if (state && Number.isFinite(row.lastSyncAtMs)) state.lastSeen = Math.max(state.lastSeen || 0, Math.min(Date.now(), Number(row.lastSyncAtMs)));
  return { exists:!!state, state, version:asInt(row.version,1,1,1e9), migrationStatus:row.migrationStatus || null, lastSyncAtMs:Number(row.lastSyncAtMs) || 0 };
}

async function initializeGameProgress(store, uid, raw, migration = false) {
  const now = Date.now();
  const candidate = migration ? sanitizeSave(raw, now, { migration:true }) : starterSave(now);
  if (!candidate) throw new AppError(400, 'invalid_legacy_game_save');
  if (migration) {
    const expectedCps = estimateCps(candidate);
    const reasonableLimit = Math.min(1e15, Math.max(25, expectedCps * 24 * 3600 * 2.1 + 1000));
    candidate.coins = Math.min(candidate.coins, reasonableLimit);
    candidate.earned.total = Math.max(candidate.coins, Math.min(candidate.earned.total, reasonableLimit));
    candidate.lastSeen = Math.min(candidate.lastSeen, now);
  } else {
    candidate.lastSeen = now;
  }
  const path = `gameProgress/${uid}`;
  const row = await store.runTransaction(async tx => {
    const existing = await tx.get(path);
    if (existing && existing.state) return existing;
    tx.set(path, {
      userId:uid,
      state:candidate,
      version:1,
      migrationStatus:migration ? 'legacy_unverified_once' : 'server_initialized',
      createdAt:timestampValue(store),
      updatedAt:timestampValue(store),
      lastSyncAt:timestampValue(store),
      lastSyncAtMs:now
    });
    return { state:candidate, version:1, migrationStatus:migration ? 'legacy_unverified_once' : 'server_initialized', lastSyncAtMs:now };
  });
  const canonical = sanitizeSave(row.state, now) || candidate;
  return { exists:true, state:canonical, version:asInt(row.version,1,1,1e9), migrationStatus:row.migrationStatus || null, lastSyncAtMs:Number(row.lastSyncAtMs) || now };
}

async function syncGameProgress(store, uid, raw, clientVersion, settings = {}, options = {}) {
  const now = Date.now();
  const path = `gameProgress/${uid}`;
  const gameSettings = settings.game || settings;
  const referralSettings = settings.referrals || DEFAULT_REFERRAL_SETTINGS;
  const result = await store.runTransaction(async tx => {
    const current = await tx.get(path);
    if (!current || !current.state) throw new AppError(409,'game_progress_not_initialized');
    const version = asInt(current.version,1,1,1e9);
    if (Number(clientVersion) !== version) return {conflict:true,version,state:current.state};
    const elapsed = Math.max(0,Math.min(24*3600,(now-(Number(current.lastSyncAtMs)||now))/1000));
    const validation = syncValidation(current.state,raw,elapsed,{version,now,gameSettings});
    if (!validation.ok) throw new AppError(422,validation.reason);
    if (validation.reset || options.backupCurrent === true) {
      const backupId = `${uid}_${now}_${crypto.randomBytes(3).toString('hex')}`;
      tx.create(`gameBackups/${backupId}`,{
        userId:uid,state:current.state,
        reason:validation.reset?'user_confirmed_reset':'user_confirmed_local_recovery',
        createdAt:timestampValue(store),createdAtMs:now
      });
    }
    tx.set(path,{
      userId:uid,state:validation.state,version:validation.version,
      migrationStatus:current.migrationStatus || 'server_validated_sync',
      updatedAt:timestampValue(store),lastSyncAt:timestampValue(store),lastSyncAtMs:now
    },{merge:true});
    return {conflict:false,version:validation.version,serverTime:now,allowance:validation.allowance || 0,state:validation.state};
  });
  if (!result.conflict) await refreshReferralEligibility(store,uid,referralSettings).catch(() => {});
  return result;
}

async function refreshReferralEligibility(store, refereeUid, referralSettings = DEFAULT_REFERRAL_SETTINGS) {
  const relationshipPath = `referrals/${refereeUid}`;
  const referral = await store.get(relationshipPath);
  if (!referral || referral.status !== 'pending') return false;
  const rules = normalizeReferralSettings(referralSettings);
  if (!rules.enabled || rules.rewardMagicCoins <= 0) return false;
  const now = Date.now();
  if (now - Number(referral.createdAtMs || now) < rules.qualificationHours * 3600000) return false;
  const progress = await store.get(`gameProgress/${refereeUid}`);
  const state = progress && sanitizeSave(progress.state, now);
  if (!state || state.xp < 0) return false;
  let level = 1, xp = state.xp;
  while (level < 100 && xp >= Math.ceil(70 * Math.pow(level, 1.55))) { xp -= Math.ceil(70 * Math.pow(level, 1.55)); level++; }
  if (level < rules.qualificationLevel) return false;
  await store.runTransaction(async tx => {
    const current = await tx.get(relationshipPath);
    if (!current || current.status !== 'pending') return;
    const inv = await tx.get(`users/${current.referrerUid}`);
    if (!inv || inv.accountStatus !== 'active' || String(current.referrerUid) === String(refereeUid)) return;
    tx.set(relationshipPath, { status:'eligible', qualifiedAt:timestampValue(store), qualifiedAtMs:now, rewardMagicCoins:rules.rewardMagicCoins }, { merge:true });
  });
  return true;
}

async function claimReferralReward(store, uid, referralId, settings = null) {
  if (!safeId(referralId) || referralId !== String(referralId)) throw new AppError(400, 'invalid_referral_id');
  const switches=settings&&settings.system&&settings.system.emergencySwitches||{};
  if (settings && (settings.system&&settings.system.maintenanceMode || settings.referrals && settings.referrals.enabled === false || switches.magicCoinRewardsPaused === true || switches.referralRewardsPaused === true)) throw new AppError(503,'referral_rewards_paused');
  const now = Date.now();
  const relationshipPath = `referrals/${referralId}`;
  const response = await store.runTransaction(async tx => {
    const relationship = await tx.get(relationshipPath);
    if (!relationship || String(relationship.referrerUid) !== String(uid)) throw new AppError(404, 'referral_not_found');
    if (relationship.status === 'rewarded') throw new AppError(409, 'referral_reward_already_claimed');
    if (relationship.status !== 'eligible') throw new AppError(409, 'referral_reward_not_eligible');
    const gamePath = `gameProgress/${uid}`;
    const progress = await tx.get(gamePath);
    if (!progress || !progress.state) throw new AppError(409, 'game_progress_not_initialized');
    const amount = asInt(relationship.rewardMagicCoins, 0, 1, MAX_GAME_REWARD);
    const state = sanitizeSave(progress.state, now);
    if (!state || state.coins + amount > 1e18) throw new AppError(409, 'game_reward_limit_reached');
    const version = asInt(progress.version,1,1,1e9) + 1;
    const ledgerPath = `gameLedger/referral_${referralId}`;
    const existingLedger = await tx.get(ledgerPath);
    if (existingLedger) throw new AppError(409, 'referral_reward_already_recorded');
    const budget = await planMagicCoinRewardBudget(
      tx,store,uid,amount,settings && settings.system && settings.system.safetyLimits,'referral',now
    );
    if (budget.blocked) return budget;
    state.coins += amount;
    state.earned.total += amount;
    state.earned.today += amount;
    state.lastSeen = now;
    state.lastSaved = now;
    tx.set(gamePath, { state, version, updatedAt:timestampValue(store), lastSyncAt:timestampValue(store), lastSyncAtMs:now }, { merge:true });
    tx.set(relationshipPath, { status:'rewarded', rewardedAt:timestampValue(store), rewardedAtMs:now }, { merge:true });
    tx.create(ledgerPath, { userId:uid, source:'referral', sourceId:referralId, currency:'MAGIC_COINS', amount, createdAt:timestampValue(store), createdAtMs:now });
    commitMagicCoinRewardBudget(tx,store,uid,budget,now);
    return { amount, state, version };
  });
  if (response && response.blocked) throw new AppError(409,response.code);
  return response;
}

function parseMoneyDecimalToMicros(value) {
  const raw = String(value || '').trim();
  if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,8})?$/.test(raw)) return null;
  const [whole, fraction = ''] = raw.split('.');
  const micros = BigInt(whole) * 1_000_000n + BigInt((fraction + '000000').slice(0,6));
  return micros <= 1_000_000_000_000_000n ? micros.toString() : null;
}
async function createAdRewardSession(store, uid, settings) {
  const switches=settings.system&&settings.system.emergencySwitches||{};
  if (settings.system && settings.system.maintenanceMode) throw new AppError(503,'maintenance_mode');
  if (switches.monetizationPaused===true||switches.adRewardsPaused===true||switches.magicCoinRewardsPaused===true
      ||!settings.rewardedReady||!settings.adsReady||settings.ads.rewardedMagicCoins<=0) throw new AppError(503,'rewarded_ads_not_configured');
  const now = Date.now();
  const profilePath = `users/${uid}`;
  const id = crypto.randomUUID();
  const result = await store.runTransaction(async tx => {
    const profile = await tx.get(profilePath);
    if (!profile || profile.accountStatus !== 'active') throw new AppError(403, 'account_not_active');
    if (now - (Number(profile.lastAdRewardAtMs) || 0) < 60_000) throw new AppError(429, 'rewarded_ad_cooldown');
    const row = {
      ymid:id, userId:uid, status:'pending', eventType:null, rewardEventType:null,
      zoneId:settings.ads.mainZoneId,
      requestVar:settings.ads.placements.rewarded,
      rewardMagicCoins:settings.ads.rewardedMagicCoins,
      estimatedPriceMicros:null,
      createdAt:timestampValue(store), createdAtMs:now,
      expiresAtMs:now + 30*60_000,
      claimedAtMs:null
    };
    tx.set(profilePath,{ lastAdRewardAtMs:now },{ merge:true });
    tx.create(`adRewards/${id}`,row);
    return row;
  });
  return result;
}

async function acceptMonetagPostback(store, query, config) {
  if (config.monetagIntegrationVerified !== true || !config.monetagPostbackSecret) throw new AppError(503, 'monetag_integration_not_verified');
  const secret = asString(query.secret, 256);
  const expected = Buffer.from(config.monetagPostbackSecret);
  const received = Buffer.from(secret);
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) throw new AppError(403, 'invalid_postback_secret');
  const ymid = asString(query.ymid, 128);
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(ymid)) throw new AppError(400, 'invalid_ad_event_id');
  const zone = asString(query.zone_id || query.zone, 32);
  const eventType = asString(query.event_type || query.event,32).toLowerCase().replace(/[ -]/g,'_');
  const rawRewardType = asString(query.reward_event_type || query.value,32).toLowerCase().replace(/[ -]/g,'_');
  const rewardType = rawRewardType === 'nonvalued' ? 'non_valued' : rawRewardType;
  if (!['impression','click'].includes(eventType) || !['valued','non_valued'].includes(rewardType)) throw new AppError(400,'invalid_postback_event');
  const estimatedMicros = parseMoneyDecimalToMicros(query.estimated_price || query.amount);
  const path = `adRewards/${ymid}`;
  const now = Date.now();
  return store.runTransaction(async tx => {
    const row = await tx.get(path);
    if (!row) throw new AppError(404, 'ad_reward_session_not_found');
    if (String(row.zoneId) !== zone) throw new AppError(403, 'ad_zone_mismatch');
    if (row.status === 'claimed' || row.status === 'ready') return { duplicate:true, status:row.status };
    if (Number(row.expiresAtMs) < now) {
      tx.set(path,{ status:'expired', lastPostbackAtMs:now },{ merge:true });
      return { duplicate:false, status:'expired' };
    }
    const ready = eventType === 'impression' && rewardType === 'valued';
    tx.set(path, {
      status:ready ? 'ready' : (rewardType === 'non_valued' ? 'unvalued' : row.status),
      eventType, rewardEventType:rewardType,
      estimatedPriceMicros:estimatedMicros,
      lastPostbackAt:timestampValue(store), lastPostbackAtMs:now
    }, { merge:true });
    return { duplicate:false, status:ready ? 'ready' : (rewardType === 'non_valued' ? 'unvalued' : row.status) };
  });
}

async function claimAdReward(store, uid, ymid, settings = null) {
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(String(ymid || ''))) throw new AppError(400, 'invalid_ad_event_id');
  const switches=settings&&settings.system&&settings.system.emergencySwitches||{};
  if (!settings || !settings.rewardedReady || settings.system&&settings.system.maintenanceMode
      ||switches.monetizationPaused===true||switches.adRewardsPaused===true||switches.magicCoinRewardsPaused===true) {
    throw new AppError(503,'rewarded_ads_not_configured');
  }
  const now = Date.now();
  const response = await store.runTransaction(async tx => {
    const adPath = `adRewards/${ymid}`;
    const ad = await tx.get(adPath);
    if (!ad || String(ad.userId) !== String(uid)) throw new AppError(404, 'ad_reward_not_found');
    if (ad.status === 'claimed') throw new AppError(409, 'ad_reward_already_claimed');
    if (ad.status !== 'ready' || ad.rewardEventType !== 'valued' || ad.eventType !== 'impression') throw new AppError(409, 'ad_reward_not_confirmed');
    if (Number(ad.expiresAtMs) < now) throw new AppError(409,'ad_reward_expired');
    const gamePath = `gameProgress/${uid}`;
    const progress = await tx.get(gamePath);
    if (!progress || !progress.state) throw new AppError(409, 'game_progress_not_initialized');
    const amount = asInt(ad.rewardMagicCoins, 0, 1, MAX_GAME_REWARD);
    const state = sanitizeSave(progress.state, now);
    if (!state || state.coins + amount > 1e18) throw new AppError(409, 'game_reward_limit_reached');
    const version = asInt(progress.version,1,1,1e9) + 1;
    const ledgerPath = `gameLedger/ad_${ymid}`;
    const ledger = await tx.get(ledgerPath);
    if (ledger) throw new AppError(409, 'ad_reward_already_recorded');
    const budget = await planMagicCoinRewardBudget(
      tx,store,uid,amount,settings.system && settings.system.safetyLimits,'ad_reward',now
    );
    if (budget.blocked) return budget;
    state.coins += amount;
    state.earned.total += amount;
    state.earned.today += amount;
    state.lastSeen = now;
    state.lastSaved = now;
    tx.set(gamePath, { state, version, updatedAt:timestampValue(store), lastSyncAt:timestampValue(store), lastSyncAtMs:now }, { merge:true });
    tx.set(adPath, { status:'claimed', claimedAt:timestampValue(store), claimedAtMs:now }, { merge:true });
    tx.create(ledgerPath,{ userId:uid, source:'monetag_rewarded_interstitial', sourceId:ymid, currency:'MAGIC_COINS', amount, createdAt:timestampValue(store), createdAtMs:now });
    commitMagicCoinRewardBudget(tx,store,uid,budget,now);
    return { amount, state, version };
  });
  if (response && response.blocked) throw new AppError(409,response.code);
  return response;
}

function updateFinanceStats(current, patch) {
  return { ...FINANCE_DEFAULT, ...cleanDoc(current), ...patch, updatedAtMs:Date.now(), updatedAt:new Date() };
}
async function getFinanceStats(store) {
  return { ...FINANCE_DEFAULT, ...cleanDoc(await store.get('systemStats/finance')) };
}

async function createDeposit(store, uid, input, settings, idempotencyKey) {
  const switches=settings.system&&settings.system.emergencySwitches||{};
  if (settings.system&&settings.system.maintenanceMode) throw new AppError(503,'maintenance_mode');
  if (switches.depositsPaused===true||!settings.system||settings.system.realMoneyEnabled!==true||!settings.payments.depositsEnabled) throw new AppError(503, 'deposits_not_configured');
  if (settings.payments.providerVerified !== true) throw new AppError(503,'deposit_provider_not_configured');
  const amount = validateAmount(input && input.amountMinor);
  const method = asString(input && input.method,32).toLowerCase();
  const reference = asString(input && input.transactionReference,128);
  if (!settings.payments.methods.includes(method)) throw new AppError(400, 'unsupported_payment_method');
  if (reference.length < 4 || !/^[A-Za-z0-9._:/-]+$/.test(reference)) throw new AppError(400, 'invalid_transaction_reference');
  if (settings.payments.minimumDepositMinor <= 0 || settings.payments.maximumDepositMinor <= 0
      || amount < settings.payments.minimumDepositMinor || amount > settings.payments.maximumDepositMinor) {
    throw new AppError(400, 'deposit_amount_out_of_range');
  }
  const safety = normalizeSafetyLimits(settings.system && settings.system.safetyLimits);
  const idemPath = appIdempotencyPath(uid,'deposit',idempotencyKey);
  const referenceHash = sha256(`${method}:${stableString(reference)}`);
  const refPath = `depositReferences/${referenceHash}`;
  const limitPath = `depositLimits/${uid}`;
  const id = crypto.randomUUID();
  const now = Date.now();
  const {day,month} = utcPeriods(now);
  const result = await store.runTransaction(async tx => {
    const [idem,ref,finance,limitDoc] = await Promise.all([
      tx.get(idemPath),tx.get(refPath),tx.get('systemStats/finance'),tx.get(limitPath)
    ]);
    if (idem) return { id:idem.resourceId,replayed:true };
    const ledgerError = financialLedgerError(finance);
    if (ledgerError) return recordSafetyBlock(tx,store,uid,'deposit_request',ledgerError,{amountMinor:amount});
    if (ref) return recordSafetyBlock(tx,store,uid,'deposit_request','deposit_reference_already_submitted',{amountMinor:amount});
    if (safety.maxPendingDepositsPerUser <= 0 || safety.maxDepositsPerUserDaily <= 0 || safety.maxDepositPerUserDailyMinor <= 0) {
      return recordSafetyBlock(tx,store,uid,'deposit_request','deposit_safety_limits_not_configured',{amountMinor:amount});
    }
    const pendingCount = limitDoc&&Object.hasOwn(limitDoc,'pendingCount')?storedLedgerInt(limitDoc.pendingCount,-1,0,MAX_LEDGER_AMOUNT):0;
    const dailyCount = limitDoc && limitDoc.dayKey === day ? storedLedgerInt(limitDoc.dailyCount,-1,0,MAX_LEDGER_AMOUNT) : 0;
    const dailyAmount = limitDoc && limitDoc.dayKey === day ? storedLedgerInt(limitDoc.dailyAmountMinor,-1,0,MAX_LEDGER_AMOUNT) : 0;
    if (pendingCount<0||dailyCount<0||dailyAmount<0) return recordSafetyBlock(tx,store,uid,'deposit_request','deposit_limit_counter_discrepancy',{amountMinor:amount});
    if (pendingCount + 1 > safety.maxPendingDepositsPerUser) {
      return recordSafetyBlock(tx,store,uid,'deposit_request','pending_deposit_user_limit_reached',{amountMinor:amount,limit:safety.maxPendingDepositsPerUser,current:pendingCount});
    }
    if (dailyCount + 1 > safety.maxDepositsPerUserDaily) {
      return recordSafetyBlock(tx,store,uid,'deposit_request','deposit_daily_count_limit_reached',{amountMinor:amount,limit:safety.maxDepositsPerUserDaily,current:dailyCount});
    }
    if (dailyAmount + amount > safety.maxDepositPerUserDailyMinor) {
      return recordSafetyBlock(tx,store,uid,'deposit_request','deposit_daily_amount_limit_reached',{amountMinor:amount,limit:safety.maxDepositPerUserDailyMinor,current:dailyAmount});
    }
    const row = {
      id,userId:uid,amountMinor:amount,currency:settings.payments.currency,currencyExponent:settings.payments.currencyExponent,
      method,userReference:reference,status:'pending',verificationMethod:'manual_external_review',
      verifiedAtMs:null,evidenceReference:null,reason:null,
      createdAt:timestampValue(store),createdAtMs:now,updatedAt:timestampValue(store),updatedAtMs:now
    };
    tx.create(`deposits/${id}`,row);
    tx.create(`transactions/deposit_request_${id}`,{
      id:`deposit_request_${id}`,userId:uid,type:'deposit_request',amountMinor:amount,currency:row.currency,currencyExponent:row.currencyExponent,status:'pending',reference,
      createdAt:timestampValue(store),createdAtMs:now,completedAtMs:null
    });
    tx.create(refPath,{depositId:id,userId:uid,createdAt:timestampValue(store),createdAtMs:now});
    tx.create(idemPath,{userId:uid,operation:'deposit',resourceId:id,createdAt:timestampValue(store),createdAtMs:now});
    tx.set(limitPath,{
      userId:uid,dayKey:day,dailyCount:dailyCount+1,dailyAmountMinor:dailyAmount+amount,monthKey:month,
      pendingCount:pendingCount+1,updatedAt:timestampValue(store),updatedAtMs:now
    },{merge:true});
    tx.set('systemStats/finance',updateFinanceStats(finance,{pendingDeposits:(Number(finance.pendingDeposits)||0)+1}),{merge:true});
    return {id,status:'pending',amountMinor:amount,currency:row.currency,manualReview:true};
  });
  if (result && result.blocked) throw new AppError(409,result.code);
  return result;
}

async function createWithdrawal(store, uid, input, settings, idempotencyKey) {
  const switches=settings.system&&settings.system.emergencySwitches||{};
  if (settings.system&&settings.system.maintenanceMode) throw new AppError(503,'maintenance_mode');
  if (switches.withdrawalsPaused===true||!settings.system||settings.system.realMoneyEnabled!==true||!settings.payments.withdrawalsEnabled) throw new AppError(503, 'withdrawals_not_configured');
  if (settings.payments.providerVerified !== true) throw new AppError(503,'payout_provider_not_configured');
  const amount = validateAmount(input && input.amountMinor);
  if (settings.payments.minimumWithdrawalMinor <= 0 || settings.payments.maximumWithdrawalMinor <= 0
      || amount < settings.payments.minimumWithdrawalMinor || amount > settings.payments.maximumWithdrawalMinor) {
    throw new AppError(400,'withdrawal_amount_out_of_range');
  }
  const payoutDetails = safePaymentDetails(input && input.payoutDetails,settings.payments.methods);
  const safety = normalizeSafetyLimits(settings.system && settings.system.safetyLimits);
  const idemPath = appIdempotencyPath(uid,'withdrawal',idempotencyKey);
  const balancePath = `balances/${uid}`;
  const limitPath = `withdrawalLimits/${uid}`;
  const id = crypto.randomUUID();
  const now = Date.now();
  const {day,month} = utcPeriods(now);
  const result = await store.runTransaction(async tx => {
    const [idem,balance,finance,limitDoc] = await Promise.all([
      tx.get(idemPath),tx.get(balancePath),tx.get('systemStats/finance'),tx.get(limitPath)
    ]);
    if (idem) return {id:idem.resourceId,replayed:true};
    const ledgerError = financialLedgerError(finance);
    if (ledgerError) return recordSafetyBlock(tx,store,uid,'withdrawal_request',ledgerError,{amountMinor:amount});
    if (safety.maxPendingWithdrawalLiabilityMinor <= 0 || safety.maxPendingWithdrawalPerUserMinor <= 0
        || safety.maxWithdrawalsPerUserDaily <= 0 || safety.maxWithdrawalPerUserDailyMinor <= 0) {
      return recordSafetyBlock(tx,store,uid,'withdrawal_request','withdrawal_safety_limits_not_configured',{amountMinor:amount});
    }
    const available = storedLedgerInt(balance && balance.availableMinor,-1,0,MAX_LEDGER_AMOUNT);
    const reserved = storedLedgerInt(balance && balance.reservedMinor,-1,0,MAX_LEDGER_AMOUNT);
    const globalReserved = storedLedgerInt(finance.reservedLiabilitiesMinor,-1,0,MAX_LEDGER_AMOUNT);
    const globalAvailable = storedLedgerInt(finance.availableLiabilitiesMinor,-1,0,MAX_LEDGER_AMOUNT);
    const dailyCount = limitDoc && limitDoc.dayKey === day ? storedLedgerInt(limitDoc.dailyCount,-1,0,MAX_LEDGER_AMOUNT) : 0;
    const dailyAmount = limitDoc && limitDoc.dayKey === day ? storedLedgerInt(limitDoc.dailyAmountMinor,-1,0,MAX_LEDGER_AMOUNT) : 0;
    if (available<0||reserved<0||globalReserved<0||globalAvailable<0||dailyCount<0||dailyAmount<0) {
      return recordSafetyBlock(tx,store,uid,'withdrawal_request','withdrawal_limit_counter_discrepancy',{amountMinor:amount});
    }
    if (available < amount) throw new AppError(409,'insufficient_available_balance');
    if (globalAvailable < amount || available + reserved > MAX_LEDGER_AMOUNT || reserved > MAX_LEDGER_AMOUNT - amount) {
      return recordSafetyBlock(tx,store,uid,'withdrawal_request','financial_ledger_discrepancy',{amountMinor:amount});
    }
    if (globalReserved + amount > safety.maxPendingWithdrawalLiabilityMinor) {
      return recordSafetyBlock(tx,store,uid,'withdrawal_request','pending_withdrawal_liability_limit_reached',{
        amountMinor:amount,limit:safety.maxPendingWithdrawalLiabilityMinor,current:globalReserved
      });
    }
    if (reserved + amount > safety.maxPendingWithdrawalPerUserMinor) {
      return recordSafetyBlock(tx,store,uid,'withdrawal_request','pending_withdrawal_user_limit_reached',{
        amountMinor:amount,limit:safety.maxPendingWithdrawalPerUserMinor,current:reserved
      });
    }
    if (dailyCount + 1 > safety.maxWithdrawalsPerUserDaily) {
      return recordSafetyBlock(tx,store,uid,'withdrawal_request','withdrawal_daily_count_limit_reached',{
        amountMinor:amount,limit:safety.maxWithdrawalsPerUserDaily,current:dailyCount
      });
    }
    if (dailyAmount + amount > safety.maxWithdrawalPerUserDailyMinor) {
      return recordSafetyBlock(tx,store,uid,'withdrawal_request','withdrawal_daily_amount_limit_reached',{
        amountMinor:amount,limit:safety.maxWithdrawalPerUserDailyMinor,current:dailyAmount
      });
    }
    const row = {
      id,userId:uid,amountMinor:amount,currency:settings.payments.currency,currencyExponent:settings.payments.currencyExponent,status:'pending',
      payoutDetails,payoutReference:null,verificationMethod:'manual_external_payout',
      reason:null,createdAt:timestampValue(store),createdAtMs:now,updatedAt:timestampValue(store),updatedAtMs:now,
      reservedAtMs:now,releasedAtMs:null,paidAtMs:null
    };
    tx.set(balancePath,{userId:uid,currency:settings.payments.currency,availableMinor:available-amount,reservedMinor:reserved+amount,updatedAt:timestampValue(store)},{merge:true});
    tx.create(`withdrawals/${id}`,row);
    tx.create(`transactions/withdrawal_reserve_${id}`,{
      id:`withdrawal_reserve_${id}`,userId:uid,type:'withdrawal_reserve',amountMinor:amount,currency:row.currency,currencyExponent:row.currencyExponent,status:'reserved',reference:id,
      createdAt:timestampValue(store),createdAtMs:now,completedAtMs:null
    });
    tx.create(idemPath,{userId:uid,operation:'withdrawal',resourceId:id,createdAt:timestampValue(store),createdAtMs:now});
    tx.set(limitPath,{userId:uid,dayKey:day,monthKey:month,dailyCount:dailyCount+1,dailyAmountMinor:dailyAmount+amount,updatedAt:timestampValue(store),updatedAtMs:now},{merge:true});
    tx.set('systemStats/finance',updateFinanceStats(finance,{
      pendingWithdrawals:(Number(finance.pendingWithdrawals)||0)+1,
      availableLiabilitiesMinor:globalAvailable-amount,
      reservedLiabilitiesMinor:globalReserved+amount
    }),{merge:true});
    return {id,status:'pending',amountMinor:amount,currency:row.currency,manualReview:true};
  });
  if (result && result.blocked) throw new AppError(409,result.code);
  return result;
}

async function decideDeposit(store, actorUid, depositId, input, config, settings) {
  const decision = asString(input && input.decision,16).toLowerCase();
  if (!['approve','reject'].includes(decision)) throw new AppError(400,'invalid_deposit_decision');
  const switches=settings.system&&settings.system.emergencySwitches||{};
  if (decision==='approve'&&settings.system&&settings.system.maintenanceMode) throw new AppError(503,'maintenance_mode');
  if (decision==='approve'&&(switches.depositsPaused===true||!settings.system||settings.system.realMoneyEnabled!==true||!settings.payments.depositsEnabled)) throw new AppError(503,'deposits_not_configured');
  if (decision==='approve'&&settings.payments.providerVerified!==true) throw new AppError(503,'deposit_provider_not_configured');
  const evidence = decision === 'approve' ? validateEvidence(input && input.evidenceReference) : null;
  const reason = asString(input && input.reason,500);
  if (decision === 'reject' && reason.length < 4) throw new AppError(400,'rejection_reason_required');
  const path = `deposits/${depositId}`;
  const now = Date.now();
  const result = await store.runTransaction(async tx => {
    const deposit = await tx.get(path);
    if (!deposit) throw new AppError(404,'deposit_not_found');
    if (deposit.status !== 'pending') throw new AppError(409,'deposit_not_pending');
    const userBalancePath = `balances/${deposit.userId}`;
    const limitPath = `depositLimits/${deposit.userId}`;
    const creditPath = `transactions/deposit_credit_${depositId}`;
    const [finance,balance,limitDoc] = await Promise.all([
      tx.get('systemStats/finance'),tx.get(userBalancePath),tx.get(limitPath)
    ]);
    const existingCredit = decision === 'approve' ? await tx.get(creditPath) : null;
    if (existingCredit) throw new AppError(409,'deposit_already_credited');
    const ledgerError = financialLedgerError(finance);
    if (ledgerError) return recordSafetyBlock(tx,store,deposit.userId,'deposit_decision',ledgerError,{actorUid:String(actorUid),amountMinor:storedLedgerInt(deposit.amountMinor,0,0,MAX_LEDGER_AMOUNT)});
    const amount = storedLedgerInt(deposit.amountMinor,-1,1,MAX_LEDGER_AMOUNT);
    const oldAvailable = storedLedgerInt(balance && balance.availableMinor,decision==='approve'?-1:0,0,MAX_LEDGER_AMOUNT);
    const globalAvailable=storedLedgerInt(finance.availableLiabilitiesMinor,-1,0,MAX_LEDGER_AMOUNT);
    const verifiedDeposits=storedLedgerInt(finance.verifiedDepositsMinor,-1,0,MAX_LEDGER_AMOUNT);
    if (amount < 0 || globalAvailable<0 || verifiedDeposits<0 || decision === 'approve'&&(oldAvailable<0||oldAvailable>MAX_LEDGER_AMOUNT-amount||globalAvailable>MAX_LEDGER_AMOUNT-amount||verifiedDeposits>MAX_LEDGER_AMOUNT-amount)) {
      return recordSafetyBlock(tx,store,deposit.userId,'deposit_decision','financial_ledger_discrepancy',{actorUid:String(actorUid),amountMinor:amount});
    }
    const pendingCount = limitDoc&&Object.hasOwn(limitDoc,'pendingCount')?storedLedgerInt(limitDoc.pendingCount,-1,0,MAX_LEDGER_AMOUNT):0;
    const globalPending=storedLedgerInt(finance.pendingDeposits,-1,0,MAX_LEDGER_AMOUNT);
    if(pendingCount<0||globalPending<1) return recordSafetyBlock(tx,store,deposit.userId,'deposit_decision','pending_deposit_counter_discrepancy',{actorUid:String(actorUid)});
    const newStatus = decision === 'approve' ? 'approved' : 'rejected';
    const updates = {
      status:newStatus,decisionBy:actorUid,decisionAt:timestampValue(store),decisionAtMs:now,
      verificationMethod:decision === 'approve' ? 'manual_external_review' : null,
      verifiedAtMs:decision === 'approve' ? now : null,
      evidenceReference:evidence,reason:decision === 'reject' ? reason : null,
      updatedAt:timestampValue(store),updatedAtMs:now
    };
    tx.set(path,updates,{merge:true});
    tx.set(`transactions/deposit_request_${depositId}`,{status:newStatus,completedAtMs:now,administrativeAction:decision},{merge:true});
    tx.set(limitPath,{pendingCount:Math.max(0,pendingCount-1),updatedAt:timestampValue(store),updatedAtMs:now},{merge:true});
    if (decision === 'approve') {
      tx.set(userBalancePath,{userId:deposit.userId,currency:deposit.currency,availableMinor:oldAvailable+amount,updatedAt:timestampValue(store)},{merge:true});
      tx.create(creditPath,{id:`deposit_credit_${depositId}`,userId:deposit.userId,type:'deposit_credit',amountMinor:amount,currency:deposit.currency,currencyExponent:deposit.currencyExponent,status:'completed',reference:depositId,providerReference:evidence,verificationMethod:'manual_external_review',createdAt:timestampValue(store),createdAtMs:now,completedAtMs:now});
      tx.set('systemStats/finance',updateFinanceStats(finance,{
        pendingDeposits:globalPending-1,
        verifiedDepositsMinor:verifiedDeposits+amount,
        availableLiabilitiesMinor:globalAvailable+amount
      }),{merge:true});
    } else {
      tx.set('systemStats/finance',updateFinanceStats(finance,{pendingDeposits:globalPending-1}),{merge:true});
    }
    const logId=crypto.randomUUID();
    tx.create(`adminLogs/${logId}`,{id:logId,actorUid,action:`deposit.${decision}`,targetUid:deposit.userId,targetId:depositId,details:{amountMinor:amount,currency:deposit.currency,evidenceReference:evidence,reason},createdAt:timestampValue(store),createdAtMs:now});
    return {id:depositId,status:newStatus,amountMinor:amount,currency:deposit.currency,manualReview:true};
  });
  if (result && result.blocked) throw new AppError(409,result.code);
  return result;
}

async function decideWithdrawal(store, actorUid, withdrawalId, input, config, settings) {
  const action = asString(input && input.action,16).toLowerCase();
  if (!['approve','processing','paid','reject','fail'].includes(action)) throw new AppError(400,'invalid_withdrawal_action');
  const isRelease=['reject','fail'].includes(action);
  const switches=settings.system&&settings.system.emergencySwitches||{};
  if(!isRelease&&settings.system&&settings.system.maintenanceMode) throw new AppError(503,'maintenance_mode');
  if(!isRelease&&(switches.withdrawalsPaused===true||!settings.system||settings.system.realMoneyEnabled!==true||!settings.payments.withdrawalsEnabled)) throw new AppError(503,'withdrawals_not_configured');
  if(!isRelease&&settings.payments.providerVerified!==true) throw new AppError(503,'payout_provider_not_configured');
  const path=`withdrawals/${withdrawalId}`;
  const now=Date.now();
  const reason=asString(input && input.reason,500);
  const evidence=['paid'].includes(action) ? validateEvidence(input && input.evidenceReference) : null;
  if (['reject','fail'].includes(action) && reason.length<4) throw new AppError(400,'decision_reason_required');
  const result=await store.runTransaction(async tx=>{
    const withdrawal=await tx.get(path);
    if(!withdrawal) throw new AppError(404,'withdrawal_not_found');
    const balancePath=`balances/${withdrawal.userId}`;
    const [balance,finance]=await Promise.all([tx.get(balancePath),tx.get('systemStats/finance')]);
    const ledgerError=financialLedgerError(finance);
    if(ledgerError) return recordSafetyBlock(tx,store,withdrawal.userId,'withdrawal_decision',ledgerError,{actorUid:String(actorUid)});
    const amount=storedLedgerInt(withdrawal.amountMinor,-1,1,MAX_LEDGER_AMOUNT);
    const available=storedLedgerInt(balance&&balance.availableMinor,-1,0,MAX_LEDGER_AMOUNT);
    const reserved=storedLedgerInt(balance&&balance.reservedMinor,-1,0,MAX_LEDGER_AMOUNT);
    const globalAvailable=storedLedgerInt(finance.availableLiabilitiesMinor,-1,0,MAX_LEDGER_AMOUNT);
    const globalReserved=storedLedgerInt(finance.reservedLiabilitiesMinor,-1,0,MAX_LEDGER_AMOUNT);
    if(amount<0||available<0||reserved<0||globalAvailable<0||globalReserved<0||available+reserved>MAX_LEDGER_AMOUNT) {
      return recordSafetyBlock(tx,store,withdrawal.userId,'withdrawal_decision','financial_ledger_discrepancy',{actorUid:String(actorUid)});
    }
    let status=withdrawal.status;
    let availableMinor=available, reservedMinor=reserved;
    const updates={updatedAt:timestampValue(store),updatedAtMs:now,decisionBy:actorUid,decisionAt:timestampValue(store),decisionAtMs:now};
    if(action==='approve'){
      if(withdrawal.status!=='pending') throw new AppError(409,'withdrawal_not_pending');
      status='approved';
    } else if(action==='processing'){
      if(withdrawal.status!=='approved') throw new AppError(409,'withdrawal_not_approved');
      status='processing';
    } else if(action==='paid'){
      if(withdrawal.status!=='processing') throw new AppError(409,'withdrawal_not_processing');
      const pendingCount=storedLedgerInt(finance.pendingWithdrawals,-1,0,MAX_LEDGER_AMOUNT);
      if(pendingCount<1) return recordSafetyBlock(tx,store,withdrawal.userId,'withdrawal_decision','pending_withdrawal_counter_discrepancy',{actorUid:String(actorUid)});
      if(reserved<amount||globalReserved<amount) return recordSafetyBlock(tx,store,withdrawal.userId,'withdrawal_decision','reserved_balance_mismatch',{actorUid:String(actorUid),amountMinor:amount,reservedMinor:reserved,globalReservedMinor:globalReserved});
      const verifiedWithdrawals=storedLedgerInt(finance.verifiedWithdrawalsMinor,-1,0,MAX_LEDGER_AMOUNT);
      if(verifiedWithdrawals<0||verifiedWithdrawals>MAX_LEDGER_AMOUNT-amount) return recordSafetyBlock(tx,store,withdrawal.userId,'withdrawal_decision','financial_ledger_discrepancy',{actorUid:String(actorUid),amountMinor:amount});
      const ledgerPath=`transactions/withdrawal_paid_${withdrawalId}`;
      if(await tx.get(ledgerPath)) throw new AppError(409,'withdrawal_already_paid');
      status='paid';
      reservedMinor=reserved-amount;
      updates.paidAt=timestampValue(store); updates.paidAtMs=now;
      updates.payoutReference=evidence; updates.verificationMethod='manual_external_payout';
      tx.create(ledgerPath,{ id:`withdrawal_paid_${withdrawalId}`,userId:withdrawal.userId,type:'withdrawal_paid',amountMinor:amount,currency:withdrawal.currency,currencyExponent:withdrawal.currencyExponent,status:'completed',reference:withdrawalId,providerReference:evidence,verificationMethod:'manual_external_payout',createdAt:timestampValue(store),createdAtMs:now,completedAtMs:now });
    } else {
      if(!['pending','approved','processing'].includes(withdrawal.status)) throw new AppError(409,'withdrawal_not_reversible');
      const pendingCount=storedLedgerInt(finance.pendingWithdrawals,-1,0,MAX_LEDGER_AMOUNT);
      if(pendingCount<1) return recordSafetyBlock(tx,store,withdrawal.userId,'withdrawal_decision','pending_withdrawal_counter_discrepancy',{actorUid:String(actorUid)});
      if(reserved<amount||globalReserved<amount) return recordSafetyBlock(tx,store,withdrawal.userId,'withdrawal_decision','reserved_balance_mismatch',{actorUid:String(actorUid),amountMinor:amount,reservedMinor:reserved,globalReservedMinor:globalReserved});
      if(available > MAX_LEDGER_AMOUNT-amount||globalAvailable>MAX_LEDGER_AMOUNT-amount) return recordSafetyBlock(tx,store,withdrawal.userId,'withdrawal_decision','financial_ledger_discrepancy',{actorUid:String(actorUid),amountMinor:amount});
      const releasePath=`transactions/withdrawal_release_${withdrawalId}`;
      if(await tx.get(releasePath)) throw new AppError(409,'withdrawal_funds_already_released');
      status=action==='reject'?'rejected':'failed';
      availableMinor=available+amount;
      reservedMinor=reserved-amount;
      updates.reason=reason; updates.releasedAt=timestampValue(store); updates.releasedAtMs=now;
      tx.create(releasePath,{ id:`withdrawal_release_${withdrawalId}`,userId:withdrawal.userId,type:'withdrawal_release',amountMinor:amount,currency:withdrawal.currency,currencyExponent:withdrawal.currencyExponent,status:'completed',reference:withdrawalId,reason,createdAt:timestampValue(store),createdAtMs:now,completedAtMs:now });
    }
    updates.status=status;
    tx.set(path,updates,{merge:true});
    tx.set(balancePath,{availableMinor,reservedMinor,updatedAt:timestampValue(store)},{merge:true});
    const prevPending=storedLedgerInt(finance.pendingWithdrawals,-1,0,MAX_LEDGER_AMOUNT);
    const financePatch={reservedLiabilitiesMinor:globalReserved+(reservedMinor-reserved)};
    if(status==='paid'){
      financePatch.pendingWithdrawals=prevPending-1;
      financePatch.verifiedWithdrawalsMinor=storedLedgerInt(finance.verifiedWithdrawalsMinor,0,0,MAX_LEDGER_AMOUNT)+amount;
    } else if(status==='rejected'||status==='failed'){
      financePatch.pendingWithdrawals=prevPending-1;
      financePatch.availableLiabilitiesMinor=globalAvailable+amount;
    }
    tx.set('systemStats/finance',updateFinanceStats(finance,financePatch),{merge:true});
    const logId=crypto.randomUUID();
    tx.create(`adminLogs/${logId}`,{id:logId,actorUid,action:`withdrawal.${action}`,targetUid:withdrawal.userId,targetId:withdrawalId,details:{amountMinor:amount,currency:withdrawal.currency,evidenceReference:evidence,reason},createdAt:timestampValue(store),createdAtMs:now});
    return {id:withdrawalId,status,amountMinor:amount,currency:withdrawal.currency,manualReview:true};
  });
  if (result && result.blocked) throw new AppError(409,result.code);
  return result;
}

async function getUserFinance(store, uid, settings) {
  const [balance,txRows,depositRows,withdrawalRows] = await Promise.all([
    store.get(`balances/${uid}`),
    store.list('transactions',{where:{userId:uid},orderBy:'createdAtMs',direction:'desc',limit:30}),
    store.list('deposits',{where:{userId:uid},orderBy:'createdAtMs',direction:'desc',limit:20}),
    store.list('withdrawals',{where:{userId:uid},orderBy:'createdAtMs',direction:'desc',limit:20})
  ]);
  return {
    configured:settings.payments.depositsEnabled||settings.payments.withdrawalsEnabled,
    status:settings.payments.status,
    currency:settings.payments.currency||null,
    currencyExponent:settings.payments.currencyExponent,
    availableMinor:asInt(balance&&balance.availableMinor,0,0,MAX_LEDGER_AMOUNT),
    reservedMinor:asInt(balance&&balance.reservedMinor,0,0,MAX_LEDGER_AMOUNT),
    deposits:{enabled:settings.payments.depositsEnabled,minimumMinor:settings.payments.minimumDepositMinor,maximumMinor:settings.payments.maximumDepositMinor||null,methods:settings.payments.methods,instructions:settings.payments.instructions,history:depositRows.map(r=>r.data)},
    withdrawals:{enabled:settings.payments.withdrawalsEnabled,minimumMinor:settings.payments.minimumWithdrawalMinor,maximumMinor:settings.payments.maximumWithdrawalMinor||null,methods:settings.payments.methods,history:withdrawalRows.map(r=>maskWithdrawal(r.data))},
    transactions:txRows.map(r=>r.data)
  };
}

async function referralSummary(store, uid, config) {
  const user=await store.get(`users/${uid}`);
  if(!user) throw new AppError(404,'user_not_found');
  const rows=await store.list('referrals',{where:{referrerUid:String(uid)},orderBy:'createdAtMs',direction:'desc',limit:100});
  const statuses={pending:0,eligible:0,rewarded:0,review:0,suspended:0};
  for(const row of rows) statuses[row.data.status]=(statuses[row.data.status]||0)+1;
  let link=null;
  if(config.telegramBotUsername){
    const bot=config.telegramBotUsername.replace(/^@/,'');
    const param=`ref_${user.referralCode}`;
    link=config.miniAppShortName?`https://t.me/${bot}/${encodeURIComponent(config.miniAppShortName)}?startapp=${param}`:`https://t.me/${bot}?startapp=${param}`;
  }
  return {code:user.referralCode,link,counts:statuses,total:Number(user.referralCount)||rows.length,history:rows.map(r=>({id:r.id,status:r.data.status,createdAtMs:r.data.createdAtMs,qualifiedAtMs:r.data.qualifiedAtMs||null,rewardedAtMs:r.data.rewardedAtMs||null,rewardMagicCoins:r.data.rewardMagicCoins||0,refereeUid:r.id}))};
}

async function profileEnvelope(store, uid, settings, config) {
  const [user,progress,balance] = await Promise.all([store.get(`users/${uid}`),store.get(`gameProgress/${uid}`),store.get(`balances/${uid}`)]);
  if(!user) throw new AppError(404,'user_not_found');
  return {
    profile:publicProfile(user),
    game:{coins:progress&&progress.state?Number(progress.state.coins)||0:0,version:progress&&Number(progress.version)||0},
    realMoney:{enabled:settings.system.realMoneyEnabled && (settings.payments.depositsEnabled||settings.payments.withdrawalsEnabled),...safeClientBalance(balance,settings.payments)},
    referral:await referralSummary(store,uid,config),
    financeStatus:settings.payments.status
  };
}

async function updateProfilePreferences(store, uid, preferences) {
  const input=cleanDoc(preferences);
  const safe={
    sound:input.sound!==false,
    motion:input.motion===true||input.motion===false?input.motion:null,
    haptics:input.haptics!==false
  };
  await store.runTransaction(async tx=>{
    const old=await tx.get(`users/${uid}`);
    if(!old) throw new AppError(404,'user_not_found');
    tx.set(`users/${uid}`,{preferences:safe,updatedAt:timestampValue(store)},{merge:true});
  });
  return safe;
}

async function adminSummary(store, settings = {}, options = {}) {
  const now=Date.now();
  const includeFinance=options.includeFinance!==false;
  const [totalUsers,newUsers,activeUsers,financeRaw,logs,pendingDeposits,pendingWithdrawals] = await Promise.all([
    store.count('users'),
    store.count('users',{where:{createdAtMs:{op:'>=',value:now-24*3600_000}}}),
    store.count('users',{where:{lastActivityAtMs:{op:'>=',value:now-24*3600_000}}}),
    includeFinance?store.get('systemStats/finance'):Promise.resolve(null),
    store.list('adminLogs',{orderBy:'createdAtMs',direction:'desc',limit:10}),
    includeFinance?store.list('deposits',{where:{status:'pending'},orderBy:'createdAtMs',direction:'desc',limit:50}):Promise.resolve([]),
    includeFinance?store.list('withdrawals',{where:{status:['pending','approved','processing']},orderBy:'createdAtMs',direction:'desc',limit:50}):Promise.resolve([])
  ]);
  const finance={...FINANCE_DEFAULT,...cleanDoc(financeRaw)};
  const warnings=['Verified settled advertising revenue is unavailable; estimated ad values are not treated as cash.'];
  if(includeFinance&&!finance.updatedAtMs) warnings.push('Financial ledger counters have not yet been initialized.');
  if(!includeFinance) warnings.push(options.lockReason==='totp_not_configured'?'Finance metrics are locked because administrator TOTP is not configured.':'Finance metrics are hidden until administrator MFA is verified.');
  const financeSummary=includeFinance?{
    locked:false,
    verifiedDepositsMinor:Number(finance.verifiedDepositsMinor)||0,
    verifiedWithdrawalsMinor:Number(finance.verifiedWithdrawalsMinor)||0,
    pendingDeposits:pendingDeposits.length,
    pendingWithdrawals:pendingWithdrawals.length,
    pendingDepositsTruncated:pendingDeposits.length>=50,
    pendingWithdrawalsTruncated:pendingWithdrawals.length>=50,
    availableLiabilitiesMinor:Number(finance.availableLiabilitiesMinor)||0,
    reservedLiabilitiesMinor:Number(finance.reservedLiabilitiesMinor)||0,
    rewardExpensesMinor:Number(finance.rewardExpensesMinor)||0,
    paymentFeesMinor:null,
    verifiedAdvertisingRevenueMinor:null,
    estimatedAdvertisingRevenueStatus:'unavailable_unverified',
    availableRewardBudgetMinor:0,
    rewardBudgetStatus:'paused_no_verified_revenue',
    currency:settings.payments&&settings.payments.currency||null,
    currencyExponent:settings.payments&&Number.isInteger(settings.payments.currencyExponent)?settings.payments.currencyExponent:2
  }:{
    locked:true,
    lockReason:options.lockReason==='totp_not_configured'?'totp_not_configured':'mfa_required',
    verifiedDepositsMinor:null,verifiedWithdrawalsMinor:null,pendingDeposits:null,pendingWithdrawals:null,
    pendingDepositsTruncated:null,pendingWithdrawalsTruncated:null,availableLiabilitiesMinor:null,reservedLiabilitiesMinor:null,
    rewardExpensesMinor:null,paymentFeesMinor:null,verifiedAdvertisingRevenueMinor:null,
    estimatedAdvertisingRevenueStatus:'unavailable_unverified',availableRewardBudgetMinor:null,
    rewardBudgetStatus:'paused_no_verified_revenue',currency:null,currencyExponent:null
  };
  const recentActions=logs.map(({data})=>({
    id:data.id||null,action:data.action||'action',actorUid:data.actorUid||null,
    targetUid:data.targetUid||null,targetId:data.targetId||null,createdAtMs:Number(data.createdAtMs)||0
  }));
  return {
    activityWindowHours:24,
    users:{total:totalUsers,new24h:newUsers,active24h:activeUsers},
    finance:financeSummary,
    recentActions,
    warnings
  };
}

function applySettingsPatch(current, patch, config) {
  const raw=cleanDoc(patch);
  const system=normalizeSystemSettings(current.system);
  const game=normalizeGameSettings(current.game);
  const ads=normalizeAdSettings(current.ads);
  const payment=normalizePaymentSettings(current.payment,config);
  const referrals=normalizeReferralSettings(current.referrals);
  if (Object.hasOwn(raw,'system')) {
    const input=cleanDoc(raw.system);
    if (Object.hasOwn(input,'maintenanceMode')) system.maintenanceMode=input.maintenanceMode===true;
    if (Object.hasOwn(input,'announcement')) system.announcement=asString(input.announcement,500);
    if (Object.hasOwn(input,'realMoneyEnabled')) {
      if (input.realMoneyEnabled===true) throw new AppError(400,'payment_provider_not_configured');
      system.realMoneyEnabled=false;
    }
    if (Object.hasOwn(input,'rewardBudgetCapMinor') && asInt(input.rewardBudgetCapMinor,0,0,MAX_LEDGER_AMOUNT)>0) throw new AppError(400,'verified_revenue_source_not_configured');
    system.rewardBudgetCapMinor=0;
    if (Object.hasOwn(input,'emergencySwitches')) {
      system.emergencySwitches=normalizeEmergencySwitches({...system.emergencySwitches,...cleanDoc(input.emergencySwitches)});
    }
    if (Object.hasOwn(input,'safetyLimits')) {
      system.safetyLimits=normalizeSafetyLimits({...system.safetyLimits,...cleanDoc(input.safetyLimits)});
    }
    if (Object.hasOwn(input,'supportedPaymentMethods')) system.supportedPaymentMethods=Array.isArray(input.supportedPaymentMethods)?input.supportedPaymentMethods.filter(x=>typeof x==='string'&&/^[a-z0-9_-]{2,32}$/i.test(x)).slice(0,8):[];
  }
  if(Object.hasOwn(raw,'game')) {
    const input=cleanDoc(raw.game);
    const merged={...game,...input};
    for(const key of ['mageCosts','mageCps','mageUpgradeBaseCosts']) merged[key]={...game[key],...cleanDoc(input[key])};
    game.towerCosts=Array.isArray(input.towerCosts)?input.towerCosts:game.towerCosts;
    game.towerBonuses=Array.isArray(input.towerBonuses)?input.towerBonuses:game.towerBonuses;
    Object.assign(game,normalizeGameSettings(merged));
  }
  if(Object.hasOwn(raw,'ads')) {
    const input=cleanDoc(raw.ads);
    Object.assign(ads,normalizeAdSettings({...ads,...input,placements:{...ads.placements,...cleanDoc(input.placements)},formats:{...ads.formats,...cleanDoc(input.formats)}}));
    if(ads.enabled && config.monetagIntegrationVerified!==true) throw new AppError(400,'monetag_integration_not_verified');
    if(ads.enabled && (!config.monetagSdkUrl || !/^\d{1,20}$/.test(ads.mainZoneId))) throw new AppError(400,'monetag_sdk_or_zone_not_configured');
    if(ads.enabled && ads.formats.rewardedInterstitial && !config.monetagPostbackSecret) throw new AppError(400,'monetag_postback_secret_not_configured');
  }
  if(Object.hasOwn(raw,'payments')) {
    const input=cleanDoc(raw.payments);
    Object.assign(payment,normalizePaymentSettings({...payment,...input},config));
    if(input.depositsEnabled===true && (config.paymentProvider==='disabled'||!config.manualPaymentInstructions||config.manualPaymentMethods.length===0)) throw new AppError(400,'deposit_provider_not_configured');
    if(input.withdrawalsEnabled===true && (config.payoutProvider==='disabled'||config.manualPaymentMethods.length===0)) throw new AppError(400,'payout_provider_not_configured');
    if(Object.hasOwn(input,'depositsEnabled')) payment.depositsEnabled=input.depositsEnabled===true;
    if(Object.hasOwn(input,'withdrawalsEnabled')) payment.withdrawalsEnabled=input.withdrawalsEnabled===true;
  }
  if(Object.hasOwn(raw,'referrals')) {
    Object.assign(referrals,normalizeReferralSettings({...referrals,...cleanDoc(raw.referrals)}));
  }
  return {system,game,ads,payment,referrals};
}

async function saveAdminSettings(store, actorUid, patch, config) {
  const now=Date.now();
  const result=await store.runTransaction(async tx=>{
    const [system,game,ads,payment,referrals]=await Promise.all([
      tx.get('systemSettings/public'),tx.get('gameSettings/current'),tx.get('adSettings/current'),tx.get('paymentSettings/current'),tx.get('referralSettings/current')
    ]);
    const next=applySettingsPatch({system,game,ads,payment,referrals},patch,config);
    if(Object.hasOwn(patch,'system')) tx.set('systemSettings/public',{...next.system,updatedAt:timestampValue(store),updatedAtMs:now,updatedBy:actorUid},{merge:true});
    if(Object.hasOwn(patch,'game')) tx.set('gameSettings/current',{...next.game,updatedAt:timestampValue(store),updatedAtMs:now,updatedBy:actorUid},{merge:true});
    if(Object.hasOwn(patch,'ads')) tx.set('adSettings/current',{...next.ads,updatedAt:timestampValue(store),updatedAtMs:now,updatedBy:actorUid},{merge:true});
    if(Object.hasOwn(patch,'payments')) tx.set('paymentSettings/current',{...next.payment,updatedAt:timestampValue(store),updatedAtMs:now,updatedBy:actorUid},{merge:true});
    if(Object.hasOwn(patch,'referrals')) tx.set('referralSettings/current',{...next.referrals,updatedAt:timestampValue(store),updatedAtMs:now,updatedBy:actorUid},{merge:true});
    const id=crypto.randomUUID();
    const changedKeys=Object.keys(patch).filter(k=>['system','game','ads','payments','referrals'].includes(k));
    const changedFields=[];
    const addPaths=(value,prefix,depth=0)=>{
      if(changedFields.length>=100) return;
      if(!value||typeof value!=='object'||Array.isArray(value)||depth>=2){changedFields.push(prefix);return;}
      for(const [key,child] of Object.entries(value)) addPaths(child,`${prefix}.${key}`,depth+1);
    };
    for(const section of changedKeys) addPaths(cleanDoc(patch[section]),section);
    tx.create(`adminLogs/${id}`,{id,actorUid,action:'settings.update',targetId:'operational-settings',details:{changedSections:changedKeys,changedFields:changedFields.slice(0,100)},createdAt:timestampValue(store),createdAtMs:now});
    return next;
  });
  return result;
}

async function adminUserDetail(store, uid, config = {}) {
  uid=safeTelegramId(uid);
  const [user,progress,balance,transactions,referrals,notes]=await Promise.all([
    store.get(`users/${uid}`),store.get(`gameProgress/${uid}`),store.get(`balances/${uid}`),
    store.list('transactions',{where:{userId:String(uid)},orderBy:'createdAtMs',direction:'desc',limit:50}),
    store.list('referrals',{where:{referrerUid:String(uid)},orderBy:'createdAtMs',direction:'desc',limit:50}),
    store.list('adminNotes',{where:{targetUid:String(uid)},orderBy:'createdAtMs',direction:'desc',limit:30})
  ]);
  if(!user) throw new AppError(404,'user_not_found');
  const state=progress&&progress.state?sanitizeSave(progress.state):null;
  return {
    profile:{...publicProfile(user),createdAt:user.createdAt||null,lastActivityAt:user.lastActivityAt||null,security:{lastTelegramAuthAtMs:user.lastTelegramAuthAtMs||null}},
    gameProgress:state?{coins:state.coins,earnedTotal:state.earned.total,level:xpLevel(state),xp:state.xp,tower:state.tower,stage:state.battle.stage,bestStage:state.battle.best,mages:Object.keys(state.mages).length,version:progress.version||1,updatedAtMs:progress.lastSyncAtMs||0}:null,
    balance:balance?{currency:balance.currency||null,currencyExponent:Number.isInteger(config.paymentCurrencyExponent)?config.paymentCurrencyExponent:2,availableMinor:balance.availableMinor||0,reservedMinor:balance.reservedMinor||0}:null,
    transactions:transactions.map(x=>x.data),
    referralActivity:referrals.map(x=>x.data),
    notes:notes.map(x=>x.data)
  };
}

async function setUserStatus(store, actorUid, targetUid, status, config, note = '') {
  actorUid=safeTelegramId(actorUid);targetUid=safeTelegramId(targetUid);
  if(!['active','suspended','banned'].includes(status)) throw new AppError(400,'invalid_account_status');
  if(String(targetUid)===String(config.telegramAdminId)) throw new AppError(400,'cannot_change_admin_account_status');
  const path=`users/${targetUid}`;
  const now=Date.now();
  await store.runTransaction(async tx=>{
    const user=await tx.get(path);
    if(!user) throw new AppError(404,'user_not_found');
    tx.set(path,{accountStatus:status,statusUpdatedAt:timestampValue(store),statusUpdatedAtMs:now},{merge:true});
    const logId=crypto.randomUUID();
    tx.create(`adminLogs/${logId}`,{id:logId,actorUid,action:`user.status.${status}`,targetUid:String(targetUid),details:{note:asString(note,500)},createdAt:timestampValue(store),createdAtMs:now});
  });
  return {uid:String(targetUid),status};
}
async function addAdminNote(store, actorUid, targetUid, note) {
  actorUid=safeTelegramId(actorUid);targetUid=safeTelegramId(targetUid);
  const text=asString(note,1000);
  if(text.length<2) throw new AppError(400,'note_required');
  const now=Date.now();
  const path=`users/${targetUid}`;
  const user=await store.get(path);
  if(!user) throw new AppError(404,'user_not_found');
  const id=crypto.randomUUID();
  await store.runTransaction(async tx=>{
    tx.create(`adminNotes/${id}`,{id,targetUid:String(targetUid),actorUid,text,createdAt:timestampValue(store),createdAtMs:now});
    const logId=crypto.randomUUID();
    tx.create(`adminLogs/${logId}`,{id:logId,actorUid,action:'user.note.add',targetUid:String(targetUid),targetId:id,details:{noteLength:text.length},createdAt:timestampValue(store),createdAtMs:now});
  });
  return {id,text,createdAtMs:now};
}

async function listAdminRequests(store, collection, status, limit = 50) {
  const rows = await store.list(collection,{where:status?{status}:undefined,orderBy:'createdAtMs',direction:'desc',limit});
  return rows.map(row=>row.data);
}
async function listAdminReferrals(store, status, limit=100) {
  const rows=await store.list('referrals',{where:status?{status}:undefined,orderBy:'createdAtMs',direction:'desc',limit});
  return rows.map(row=>row.data);
}
async function reviewReferral(store, actorUid, refereeUid, action, note) {
  actorUid=safeTelegramId(actorUid);refereeUid=safeTelegramId(refereeUid);
  if(!['review','suspend','restore'].includes(action)) throw new AppError(400,'invalid_referral_review_action');
  const path=`referrals/${refereeUid}`;
  const now=Date.now();
  return store.runTransaction(async tx=>{
    const row=await tx.get(path);
    if(!row) throw new AppError(404,'referral_not_found');
    if(row.status==='rewarded' && action!=='review') throw new AppError(409,'rewarded_referral_cannot_be_reversed');
    const status=action==='suspend'?'suspended':action==='restore'?'pending':'review';
    tx.set(path,{status,reviewNote:asString(note,500),reviewedBy:actorUid,reviewedAt:timestampValue(store),reviewedAtMs:now},{merge:true});
    const id=crypto.randomUUID();
    tx.create(`adminLogs/${id}`,{id,actorUid,action:`referral.${action}`,targetUid:row.referrerUid,targetId:refereeUid,details:{note:asString(note,500)},createdAt:timestampValue(store),createdAtMs:now});
    return {refereeUid,status};
  });
}

async function getAdminTransactions(store, status, limit=100) {
  const rows=await store.list('transactions',{where:status?{status}:undefined,orderBy:'createdAtMs',direction:'desc',limit});
  return rows.map(x=>x.data);
}

module.exports={
  AppError,DEFAULT_GAME_SETTINGS,DEFAULT_AD_SETTINGS,DEFAULT_REFERRAL_SETTINGS,DEFAULT_SYSTEM_SETTINGS,DEFAULT_PAYMENT_SETTINGS,FINANCE_DEFAULT,
  normalizeGameSettings,normalizeAdSettings,normalizeReferralSettings,normalizeSystemSettings,normalizePaymentSettings,
  getOperationalSettings,publicOperationalConfig,initializeSettings,ensureTelegramUser,getGameProgress,initializeGameProgress,syncGameProgress,
  refreshReferralEligibility,claimReferralReward,createAdRewardSession,acceptMonetagPostback,claimAdReward,parseMoneyDecimalToMicros,
  createDeposit,createWithdrawal,decideDeposit,decideWithdrawal,getUserFinance,referralSummary,profileEnvelope,updateProfilePreferences,
  adminSummary,saveAdminSettings,adminUserDetail,setUserStatus,addAdminNote,listAdminRequests,listAdminReferrals,reviewReferral,getAdminTransactions,
  publicProfile,maskWithdrawal,asInt,asString,cleanDoc
};
