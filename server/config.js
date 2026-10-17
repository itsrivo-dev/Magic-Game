'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

const ROOT = path.resolve(__dirname, '..');
const PLACEHOLDER = /^(?:__[^\n]*__|your[_ -].*|replace[_ -].*|placeholder|changeme|todo)$/i;

function clean(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return !trimmed || PLACEHOLDER.test(trimmed) ? undefined : trimmed;
}

function readPrivateFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw new Error('CONFIG_FILE_INVALID: all_details.txt must contain valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('CONFIG_FILE_INVALID: all_details.txt must contain a JSON object.');
  }
  return parsed;
}

function envOrFile(envName, fileValue) {
  return clean(process.env[envName]) || clean(fileValue);
}

function numberOr(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

function loadConfig(options = {}) {
  if (options.loadDotenv !== false) {
    // Railway injects process.env directly; .env is a local-development convenience only.
    dotenv.config({ path: options.envFile || path.join(ROOT, '.env'), quiet: true });
  }
  const filePath = options.filePath || process.env.ALL_DETAILS_FILE || path.join(ROOT, 'all_details.txt');
  const file = options.file || readPrivateFile(filePath);
  const telegram = file.telegram || {};
  const firebase = file.firebase || {};
  const monetag = file.monetag || {};
  const session = file.session || {};
  const payments = file.payments || {};
  const publicSettings = file.public || {};

  let serviceAccount = null;
  const accountJson = envOrFile('FIREBASE_SERVICE_ACCOUNT_JSON', firebase.serviceAccountJson);
  if (accountJson) {
    try {
      serviceAccount = JSON.parse(accountJson);
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON_INVALID: set valid JSON without logging the value.');
    }
  } else if (firebase.serviceAccount && typeof firebase.serviceAccount === 'object') {
    const candidate = firebase.serviceAccount;
    if (clean(candidate.project_id) && clean(candidate.client_email) && clean(candidate.private_key)) {
      serviceAccount = candidate;
    }
  }

  let manualPaymentMethods = payments.manualPaymentMethods;
  if (!Array.isArray(manualPaymentMethods)) manualPaymentMethods = [];
  manualPaymentMethods = manualPaymentMethods
    .filter(v => typeof v === 'string' && /^[a-z0-9_-]{2,32}$/i.test(v))
    .slice(0, 8);

  const appUrl = envOrFile('PUBLIC_APP_URL', publicSettings.appUrl || telegram.webAppUrl);
  const monetagSdkUrl = envOrFile('MONETAG_SDK_URL', monetag.sdkUrl);
  const monetagMainZoneId = envOrFile('MONETAG_MAIN_ZONE_ID',monetag.mainZoneId || monetag.zoneId);
  let sdkUrl = null;
  if (monetagSdkUrl) {
    try {
      const candidateUrl = monetagSdkUrl.startsWith('//') ? `https:${monetagSdkUrl}` : monetagSdkUrl;
      const parsed = new URL(candidateUrl);
      if (parsed.protocol === 'https:' && !parsed.username && !parsed.password && parsed.hostname && !['localhost', '127.0.0.1'].includes(parsed.hostname)) {
        sdkUrl = parsed.toString();
      }
    } catch {
      // A malformed ad URL is treated as unconfigured and is never sent to the browser.
    }
  }

  return Object.freeze({
    nodeEnv: process.env.NODE_ENV || 'development',
    isProduction: process.env.NODE_ENV === 'production',
    port: numberOr(process.env.PORT, 3000, 1, 65535),
    host: '0.0.0.0',
    root: ROOT,
    configFilePath: filePath,
    sessionSecret: envOrFile('SESSION_SECRET', session.secret),
    telegramBotToken: envOrFile('TELEGRAM_BOT_TOKEN', telegram.botToken),
    telegramAdminId: envOrFile('ADMIN_TELEGRAM_ID', telegram.adminTelegramId),
    telegramBotUsername: envOrFile('TELEGRAM_BOT_USERNAME', publicSettings.botUsername || telegram.botUsername),
    miniAppShortName: envOrFile('TELEGRAM_MINI_APP_SHORT_NAME', publicSettings.miniAppShortName || telegram.miniAppShortName),
    publicAppUrl: appUrl,
    firebaseProjectId: envOrFile('FIREBASE_PROJECT_ID', firebase.projectId || (serviceAccount && serviceAccount.project_id)),
    firebaseServiceAccount: serviceAccount,
    firebaseCredentialsPath: envOrFile('GOOGLE_APPLICATION_CREDENTIALS', firebase.credentialsPath),
    firebaseDatabaseUrl: envOrFile('FIREBASE_DATABASE_URL', firebase.databaseURL),
    monetagPublisherId: envOrFile('MONETAG_PUBLISHER_ID',monetag.publisherId),
    monetagMainZoneId: /^\d{1,20}$/.test(String(monetagMainZoneId||''))?String(monetagMainZoneId):'',
    monetagSdkUrl: sdkUrl,
    monetagPostbackSecret: envOrFile('MONETAG_POSTBACK_SECRET',monetag.postbackSecret),
    paymentProvider: (envOrFile('PAYMENT_PROVIDER', payments.provider) || 'disabled').toLowerCase(),
    payoutProvider: (envOrFile('PAYOUT_PROVIDER', payments.payoutProvider) || 'disabled').toLowerCase(),
    paymentCurrency: (envOrFile('PAYMENT_CURRENCY', payments.currency) || '').toUpperCase(),
    paymentCurrencyExponent: numberOr(envOrFile('PAYMENT_CURRENCY_EXPONENT', payments.currencyExponent === undefined ? '2' : String(payments.currencyExponent)), 2, 0, 4),
    manualPaymentMethods,
    manualPaymentInstructions: envOrFile('MANUAL_PAYMENT_INSTRUCTIONS', payments.manualInstructions),
    paymentMinDepositMinor: numberOr(envOrFile('PAYMENT_MIN_DEPOSIT_MINOR', String(payments.minimumDepositMinor || '')), 0, 0, 1e12),
    paymentMaxDepositMinor: numberOr(envOrFile('PAYMENT_MAX_DEPOSIT_MINOR', String(payments.maximumDepositMinor || '')), 0, 0, 1e12),
    paymentMinWithdrawalMinor: numberOr(envOrFile('PAYMENT_MIN_WITHDRAWAL_MINOR', String(payments.minimumWithdrawalMinor || '')), 0, 0, 1e12),
    paymentMaxWithdrawalMinor: numberOr(envOrFile('PAYMENT_MAX_WITHDRAWAL_MINOR', String(payments.maximumWithdrawalMinor || '')), 0, 0, 1e12),
    adminTotpSecret: envOrFile('ADMIN_TOTP_SECRET', file.admin && file.admin.totpSecret),
    adminTotpRequiredForFinance: process.env.NODE_ENV === 'production' || (process.env.ADMIN_TOTP_REQUIRED_FOR_FINANCE || 'true').toLowerCase() !== 'false',
    systemSettingsSeed: file.defaults && typeof file.defaults === 'object' ? file.defaults : {},
    trustProxyHops: numberOr(process.env.TRUST_PROXY_HOPS, 1, 0, 8)
  });
}

function getMissingRequired(config) {
  const missing = [];
  if (!config.telegramBotToken) missing.push('TELEGRAM_BOT_TOKEN');
  if (!config.sessionSecret || Buffer.byteLength(config.sessionSecret, 'utf8') < 32) missing.push('SESSION_SECRET (at least 32 bytes)');
  if (!config.firebaseServiceAccount && !config.firebaseCredentialsPath) missing.push('FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS');
  if (!config.firebaseProjectId && !(config.firebaseServiceAccount && config.firebaseServiceAccount.project_id)) missing.push('FIREBASE_PROJECT_ID');
  return missing;
}

module.exports = { ROOT, clean, loadConfig, getMissingRequired };
