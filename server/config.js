'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

const ROOT = path.resolve(__dirname, '..');
const PLACEHOLDER = /^(?:__[^\n]*__|your[_ -].*|replace[_ -].*|placeholder|changeme|todo|null|undefined)$/i;
const FIREBASE_WEB_KEYS = ['apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId', 'measurementId'];

function clean(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return !trimmed || PLACEHOLDER.test(trimmed) ? undefined : trimmed;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function safeJsonObject(text, context) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${context}_INVALID: configuration must contain valid JSON.`);
  }
  if (!isPlainObject(value)) throw new Error(`${context}_INVALID: configuration must be a JSON object.`);
  return value;
}

function readJsString(quote, body) {
  if (quote === '"') {
    try { return JSON.parse(`"${body}"`); } catch { return null; }
  }
  let result = '';
  const escape = String.fromCharCode(92);
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== escape || index + 1 >= body.length) { result += char; continue; }
    const next = body[++index];
    result += ({ n: '\n', r: '\r', t: '\t' })[next] ?? next;
  }
  return result;
}

function jsObjectBlock(text, variableName) {
  const assignment = new RegExp(`(?:const|let|var)\\s+${variableName}\\s*=\\s*\\{`, 'i').exec(text);
  if (!assignment) return '';
  const open = text.indexOf('{', assignment.index);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '{') depth += 1;
    if (char === '}' && --depth === 0) return text.slice(open + 1, index);
  }
  return '';
}

function parseJsStringProperties(block, allowedKeys) {
  const result = {};
  const property = /(?:^|,)\s*([A-Za-z_$][\w$]*)\s*:\s*("((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')\s*(?=,|$)/gs;
  for (const match of block.matchAll(property)) {
    const key = match[1];
    if (!allowedKeys.includes(key)) continue;
    const quote = match[2][0];
    const body = quote === '"' ? match[3] : match[4];
    const value = readJsString(quote, body);
    if (typeof value === 'string' && value.trim()) result[key] = value.trim();
  }
  return result;
}

function parseJsNumberProperties(block, allowedKeys) {
  const result = {};
  const property = /(?:^|,)\s*([A-Za-z_$][\w$]*)\s*:\s*(\d+)\s*(?=,|$)/gs;
  for (const match of block.matchAll(property)) {
    if (!allowedKeys.includes(match[1])) continue;
    const value = Number(match[2]);
    if (Number.isSafeInteger(value)) result[match[1]] = value;
  }
  return result;
}

function labelValue(text, aliases) {
  const label = new RegExp(`^\\s*(?:${aliases})\\s*[:=]\\s*(.*?)\\s*$`, 'im');
  const match = label.exec(text);
  if (!match) return undefined;
  return clean(match[1].replace(/^(["'])(.*)\1$/, '$2'));
}

function tagAttribute(tag, name) {
  const matcher = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = matcher.exec(tag);
  return clean(match && (match[1] ?? match[2] ?? match[3]));
}

function mapEnvFile(values) {
  const pick = (...keys) => {
    for (const key of keys) if (clean(values[key]) !== undefined) return clean(values[key]);
    return undefined;
  };
  const output = {
    public: {
      appUrl: pick('PUBLIC_APP_URL', 'TELEGRAM_MINI_APP_URL'),
      botUsername: pick('TELEGRAM_BOT_USERNAME'),
      miniAppShortName: pick('TELEGRAM_MINI_APP_SHORT_NAME')
    },
    telegram: {
      botToken: pick('TELEGRAM_BOT_TOKEN'),
      adminTelegramId: pick('ADMIN_TELEGRAM_ID', 'TELEGRAM_ADMIN_ID'),
      botUsername: pick('TELEGRAM_BOT_USERNAME'),
      miniAppShortName: pick('TELEGRAM_MINI_APP_SHORT_NAME'),
      initDataMaxAgeSeconds: pick('TELEGRAM_INIT_DATA_MAX_AGE_SECONDS')
    },
    session: { secret: pick('SESSION_SECRET') },
    firebase: {
      projectId: pick('FIREBASE_PROJECT_ID'),
      serviceAccountJson: pick('FIREBASE_SERVICE_ACCOUNT_JSON'),
      credentialsPath: pick('GOOGLE_APPLICATION_CREDENTIALS'),
      databaseURL: pick('FIREBASE_DATABASE_URL')
    },
    monetag: {
      publisherId: pick('MONETAG_PUBLISHER_ID'),
      mainZoneId: pick('MONETAG_MAIN_ZONE_ID'),
      sdkUrl: pick('MONETAG_SDK_URL'),
      postbackSecret: pick('MONETAG_POSTBACK_SECRET'),
      policyReviewed: pick('MONETAG_POLICY_REVIEWED')
    },
    payments: {
      provider: pick('PAYMENT_PROVIDER'),
      payoutProvider: pick('PAYOUT_PROVIDER'),
      currency: pick('PAYMENT_CURRENCY'),
      currencyExponent: pick('PAYMENT_CURRENCY_EXPONENT'),
      minimumDepositMinor: pick('PAYMENT_MIN_DEPOSIT_MINOR'),
      maximumDepositMinor: pick('PAYMENT_MAX_DEPOSIT_MINOR'),
      minimumWithdrawalMinor: pick('PAYMENT_MIN_WITHDRAWAL_MINOR'),
      maximumWithdrawalMinor: pick('PAYMENT_MAX_WITHDRAWAL_MINOR')
    },
    admin: { totpSecret: pick('ADMIN_TOTP_SECRET') },
    defaults: {}
  };
  return output;
}

function parseLegacyText(text) {
  const output = {
    public: {}, telegram: {}, session: {}, firebase: {}, monetag: {}, payments: {}, admin: {}
  };
  let recognized = 0;
  const firebaseBlock = jsObjectBlock(text, 'firebaseConfig');
  if (firebaseBlock) {
    const web = parseJsStringProperties(firebaseBlock, FIREBASE_WEB_KEYS);
    if (Object.keys(web).length) {
      output.firebase.webConfig = web;
      if (web.projectId) output.firebase.projectId = web.projectId;
      recognized += 1;
    }
  }

  const botToken = labelValue(text, '(?:telegram\\s+)?bot\\s+token');
  if (botToken) { output.telegram.botToken = botToken; recognized += 1; }
  const adminId = labelValue(text, '(?:telegram\\s+)?admin(?:istrator)?\\s+(?:user\\s+)?id');
  if (adminId) { output.telegram.adminTelegramId = adminId; recognized += 1; }
  const appUrl = labelValue(text, '(?:telegram\\s+)?(?:mini\\s+app|web\\s+app|application)\\s+url');
  if (appUrl) { output.public.appUrl = appUrl; recognized += 1; }
  const botUsername = labelValue(text, '(?:telegram\\s+)?bot\\s+username');
  if (botUsername) { output.telegram.botUsername = botUsername.replace(/^@/, ''); recognized += 1; }
  const sessionSecret = labelValue(text, '(?:session\\s+)?secret|session\\s+signing\\s+secret');
  if (sessionSecret) { output.session.secret = sessionSecret; recognized += 1; }
  const totpSecret = labelValue(text, '(?:admin\\s+)?(?:totp|authenticator)\\s+secret');
  if (totpSecret) { output.admin.totpSecret = totpSecret; recognized += 1; }

  const scriptTag = text.match(/<script[^>]*>/i);
  if (scriptTag) {
    const sdkUrl = tagAttribute(scriptTag[0], 'src');
    const zone = tagAttribute(scriptTag[0], 'data-zone');
    const publisherId = tagAttribute(scriptTag[0], 'data-publisher-id');
    if (sdkUrl) { output.monetag.sdkUrl = sdkUrl; recognized += 1; }
    if (zone) output.monetag.mainZoneId = zone;
    if (publisherId) output.monetag.publisherId = publisherId;
  }
  const publisherId = labelValue(text, 'monetag\\s+publisher\\s+(?:id|identifier)');
  const zoneId = labelValue(text, 'monetag\\s+(?:main\\s+)?zone\\s+(?:id|identifier)');
  const sdk = labelValue(text, 'monetag\\s+(?:sdk\\s+)?url');
  const postbackSecret = labelValue(text, 'monetag\\s+postback\\s+secret');
  if (publisherId) output.monetag.publisherId = publisherId;
  if (zoneId) output.monetag.mainZoneId = zoneId;
  if (sdk) output.monetag.sdkUrl = sdk;
  if (postbackSecret) output.monetag.postbackSecret = postbackSecret;

  const paymentProvider = labelValue(text, '(?:payment|deposit)\\s+provider');
  const payoutProvider = labelValue(text, '(?:payout|withdrawal)\\s+provider');
  const currency = labelValue(text, 'payment\\s+currency');
  if (paymentProvider) output.payments.provider = paymentProvider;
  if (payoutProvider) output.payments.payoutProvider = payoutProvider;
  if (currency) output.payments.currency = currency;

  const safetyBlock = jsObjectBlock(text, 'financialSafety');
  if (safetyBlock) {
    output.financialSafety = parseJsNumberProperties(safetyBlock,[
      'maxPendingWithdrawalLiabilityMinor','maxPendingWithdrawalPerUserMinor','maxWithdrawalsPerUserDaily',
      'maxWithdrawalPerUserDailyMinor','maxPendingDepositsPerUser','maxDepositsPerUserDaily',
      'maxDepositPerUserDailyMinor','maxMagicCoinsPerReward','maxMagicCoinsPerUserDaily',
      'dailyMagicCoinsRewardBudget','monthlyMagicCoinsRewardBudget','maxCashRewardPerUserMinor',
      'dailyCashRewardBudgetMinor','monthlyCashRewardBudgetMinor','maxTotalCashRewardLiabilityMinor'
    ]);
    recognized += 1;
  }
  if (!recognized) throw new Error('CONFIG_FILE_UNRECOGNIZED: all_details.txt format is not supported. Use the documented JSON or key/value format.');
  return output;
}

function parseDetailsText(text, context = 'CONFIG_FILE') {
  const source = String(text || '').trim();
  if (!source) throw new Error(`${context}_INVALID: configuration file is empty.`);
  if (source.startsWith('{') || source.startsWith('[')) return safeJsonObject(source, context);

  const envEntries = dotenv.parse(source);
  if (Object.keys(envEntries).length && Object.keys(envEntries).some(key => /^[A-Z][A-Z0-9_]*$/.test(key))) {
    return mapEnvFile(envEntries);
  }
  return parseLegacyText(source);
}

function readDetails(options, env) {
  if (isPlainObject(options.file)) return { data: options.file, source: 'provided_object', format: 'object' };
  const inlineJson = clean(env.ALL_DETAILS_JSON);
  if (inlineJson) return { data: safeJsonObject(inlineJson, 'ALL_DETAILS_JSON'), source: 'environment_json', format: 'json' };
  const inlineText = clean(env.ALL_DETAILS_TEXT);
  if (inlineText) return { data: parseDetailsText(inlineText, 'ALL_DETAILS_TEXT'), source: 'environment_text', format: 'text' };

  const configuredPath = options.filePath || env.ALL_DETAILS_FILE;
  const envPath = clean(configuredPath);
  const candidates = envPath
    ? [path.isAbsolute(envPath) ? envPath : path.resolve(options.root || ROOT, envPath)]
    : [path.join(options.root || ROOT, 'all_details.txt'), path.join(options.root || ROOT, 'all details.txt')];
  const filePath = candidates.find(candidate => fs.existsSync(candidate)) || candidates[0];
  if (!fs.existsSync(filePath)) return { data: {}, source: 'missing', format: null, filePath };
  let stat;
  let text;
  try {
    stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > 256 * 1024) throw new Error('CONFIG_FILE_INVALID: all_details.txt must be a regular file no larger than 256 KB.');
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (String(error && error.message || '').startsWith('CONFIG_FILE_INVALID:')) throw error;
    throw new Error('CONFIG_FILE_READ_FAILED: all_details.txt could not be read. Check its path and permissions.');
  }
  const first = text.trimStart()[0];
  const data = parseDetailsText(text, 'CONFIG_FILE');
  const format = first === '{' || first === '[' ? 'json' : dotenv.parse(text).length ? 'text' : 'legacy_text';
  return { data, source: 'file', format, filePath, mode: process.platform === 'win32' ? null : (stat.mode & 0o777).toString(8) };
}

function envOrFile(env, envName, fileValue) {
  return clean(env[envName]) ?? clean(fileValue);
}

function numberOr(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

function positiveTelegramId(value) {
  const text = String(value ?? '');
  if (!text || text.length > 20 || Array.from(text).some(char => char < '0' || char > '9')) return '';
  try { return BigInt(text) > 0n ? text : ''; } catch { return ''; }
}

function validTelegramToken(value) {
  if (typeof value !== 'string') return false;
  const separator = value.indexOf(':');
  if (separator < 1 || separator !== value.lastIndexOf(':')) return false;
  const id = value.slice(0, separator);
  const secret = value.slice(separator + 1);
  if (id.length > 20 || Array.from(id).some(char => char < '0' || char > '9')) return false;
  if (secret.length < 25 || Array.from(secret).some(char => !(/[A-Za-z0-9_-]/).test(char))) return false;
  return true;
}

function validProjectId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{4,28}[a-z0-9]$/.test(value);
}

function validServiceAccount(value) {
  if (!isPlainObject(value) || !validProjectId(clean(value.project_id))) return false;
  const email = clean(value.client_email);
  const parts = typeof email === 'string' ? email.split('@') : [];
  if (parts.length !== 2 || !parts[0] || !parts[1].toLowerCase().endsWith('.iam.gserviceaccount.com')) return false;
  if (Array.from(email).some(char => char <= ' ')) return false;
  const privateKey = clean(value.private_key);
  return typeof privateKey === 'string'
    && privateKey.startsWith('-----BEGIN PRIVATE KEY-----')
    && privateKey.trimEnd().endsWith('-----END PRIVATE KEY-----');
}

function parseServiceAccount(raw, invalidValues) {
  if (!raw) return null;
  let candidate = raw;
  if (typeof raw === 'string') {
    try { candidate = JSON.parse(raw); } catch {
      invalidValues.push('FIREBASE_SERVICE_ACCOUNT_JSON');
      return null;
    }
  }
  if (!validServiceAccount(candidate)) {
    invalidValues.push('FIREBASE_SERVICE_ACCOUNT_JSON');
    return null;
  }
  return candidate;
}

function validHttpsUrl(value, { allowLoopbackHttp = false } = {}) {
  if (!value) return null;
  try {
    const candidate = value.startsWith('//') ? `https:${value}` : value;
    const parsed = new URL(candidate);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (!parsed.hostname || parsed.username || parsed.password) return null;
    if (parsed.protocol !== 'https:' && !(allowLoopbackHttp && loopback && parsed.protocol === 'http:')) return null;
    if (/(?:^|[?&])(token|secret|api[_-]?key|auth)=/i.test(parsed.search)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function deriveSessionSecret(botToken) {
  if (!validTelegramToken(botToken)) return '';
  return Buffer.from(crypto.hkdfSync(
    'sha256',
    Buffer.from(botToken, 'utf8'),
    Buffer.from('mag-ia-runtime-keys-v1', 'utf8'),
    Buffer.from('session-signing-key', 'utf8'),
    32
  )).toString('base64url');
}

function normalizeFinancialSafety(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const limits = {};
  const keys = [
    'maxPendingWithdrawalLiabilityMinor',
    'maxPendingWithdrawalPerUserMinor',
    'maxWithdrawalsPerUserDaily',
    'maxWithdrawalPerUserDailyMinor',
    'maxPendingDepositsPerUser',
    'maxDepositsPerUserDaily',
    'maxDepositPerUserDailyMinor',
    'maxMagicCoinsPerReward',
    'maxMagicCoinsPerUserDaily',
    'dailyMagicCoinsRewardBudget',
    'monthlyMagicCoinsRewardBudget',
    'maxCashRewardPerUserMinor',
    'dailyCashRewardBudgetMinor',
    'monthlyCashRewardBudgetMinor',
    'maxTotalCashRewardLiabilityMinor'
  ];
  for (const key of keys) {
    const max = key.includes('MagicCoins') ? 100_000_000 : 1_000_000_000_000;
    const value = source[key];
    const n = Number(value);
    limits[key] = Number.isSafeInteger(n) && n >= 0 && n <= max ? n : 0;
  }
  return limits;
}

function loadConfig(options = {}) {
  if (options.loadDotenv !== false && !options.env) {
    // Railway injects variables into the running service; .env is only a local convenience.
    dotenv.config({ path: options.envFile || path.join(ROOT, '.env'), quiet: true });
  }
  const env = options.env || process.env;
  const details = readDetails(options, env);
  const file = details.data || {};
  const telegram = isPlainObject(file.telegram) ? file.telegram : {};
  const firebase = isPlainObject(file.firebase) ? file.firebase : {};
  const monetag = isPlainObject(file.monetag) ? file.monetag : {};
  const session = isPlainObject(file.session) ? file.session : {};
  const payments = isPlainObject(file.payments) ? file.payments : {};
  const publicSettings = isPlainObject(file.public) ? file.public : {};
  const admin = isPlainObject(file.admin) ? file.admin : {};
  const invalidValues = [];
  const warnings = [];

  const rawTelegramToken = envOrFile(env, 'TELEGRAM_BOT_TOKEN', telegram.botToken);
  const telegramBotToken = validTelegramToken(rawTelegramToken) ? rawTelegramToken : '';
  if (rawTelegramToken && !telegramBotToken) invalidValues.push('TELEGRAM_BOT_TOKEN');

  const rawAdminId = envOrFile(env, 'ADMIN_TELEGRAM_ID', telegram.adminTelegramId || file.telegramAdminId || file.adminTelegramId);
  const telegramAdminId = positiveTelegramId(rawAdminId);
  if (rawAdminId && !telegramAdminId) invalidValues.push('ADMIN_TELEGRAM_ID');

  let firebaseServiceAccount = parseServiceAccount(
    envOrFile(env, 'FIREBASE_SERVICE_ACCOUNT_JSON', firebase.serviceAccountJson)
      || firebase.serviceAccount,
    invalidValues
  );
  let firebaseCredentialsPath = envOrFile(env, 'GOOGLE_APPLICATION_CREDENTIALS', firebase.credentialsPath);
  if (firebaseCredentialsPath) {
    const resolved = path.isAbsolute(firebaseCredentialsPath)
      ? firebaseCredentialsPath
      : path.resolve(ROOT, firebaseCredentialsPath);
    try {
      if (!fs.statSync(resolved).isFile()) throw new Error('not a file');
      const pathAccount = parseServiceAccount(fs.readFileSync(resolved, 'utf8'), invalidValues);
      if (!firebaseServiceAccount && pathAccount) firebaseServiceAccount = pathAccount;
      if (pathAccount) firebaseCredentialsPath = resolved;
      else firebaseCredentialsPath = '';
    } catch {
      if (!invalidValues.includes('GOOGLE_APPLICATION_CREDENTIALS')) invalidValues.push('GOOGLE_APPLICATION_CREDENTIALS');
      firebaseCredentialsPath = '';
    }
  }

  let firebaseProjectId = envOrFile(env, 'FIREBASE_PROJECT_ID', firebase.projectId || (firebaseServiceAccount && firebaseServiceAccount.project_id));
  if (firebaseProjectId && !validProjectId(firebaseProjectId)) {
    invalidValues.push('FIREBASE_PROJECT_ID');
    firebaseProjectId = '';
  }
  if (firebaseServiceAccount && firebaseProjectId && firebaseServiceAccount.project_id !== firebaseProjectId) {
    invalidValues.push('FIREBASE_PROJECT_ID_MISMATCH');
    firebaseServiceAccount = null;
    firebaseCredentialsPath = '';
  }
  if (!firebaseProjectId && firebaseServiceAccount) firebaseProjectId = firebaseServiceAccount.project_id;

  let sessionSecret = envOrFile(env, 'SESSION_SECRET', session.secret);
  let sessionSecretSource = sessionSecret && Buffer.byteLength(sessionSecret, 'utf8') >= 32 ? 'explicit' : '';
  if (sessionSecret && !sessionSecretSource) {
    invalidValues.push('SESSION_SECRET');
    sessionSecret = '';
  }
  if (!sessionSecret && telegramBotToken) {
    sessionSecret = deriveSessionSecret(telegramBotToken);
    sessionSecretSource = 'derived_from_telegram_bot_token';
  }

  const appUrlRaw = envOrFile(env, 'PUBLIC_APP_URL', publicSettings.appUrl || telegram.webAppUrl || telegram.miniAppUrl);
  const publicAppUrl = validHttpsUrl(appUrlRaw, { allowLoopbackHttp: true }) || '';
  if (appUrlRaw && !publicAppUrl) invalidValues.push('PUBLIC_APP_URL');

  const botUsernameRaw = envOrFile(env, 'TELEGRAM_BOT_USERNAME', publicSettings.botUsername || telegram.botUsername);
  const telegramBotUsername = botUsernameRaw ? botUsernameRaw.replace(/^@/, '') : '';
  const validBotUsername = !telegramBotUsername || /^[A-Za-z0-9_]{5,32}$/.test(telegramBotUsername);
  if (!validBotUsername) invalidValues.push('TELEGRAM_BOT_USERNAME');

  const miniAppShortNameRaw = envOrFile(env, 'TELEGRAM_MINI_APP_SHORT_NAME', publicSettings.miniAppShortName || telegram.miniAppShortName);
  const miniAppShortName = miniAppShortNameRaw && /^[A-Za-z0-9_-]{1,64}$/.test(miniAppShortNameRaw) ? miniAppShortNameRaw : '';
  if (miniAppShortNameRaw && !miniAppShortName) invalidValues.push('TELEGRAM_MINI_APP_SHORT_NAME');

  const rawMonetagSdkUrl = envOrFile(env, 'MONETAG_SDK_URL', monetag.sdkUrl || monetag.scriptUrl);
  const monetagSdkUrl = validHttpsUrl(rawMonetagSdkUrl);
  if (rawMonetagSdkUrl && !monetagSdkUrl) invalidValues.push('MONETAG_SDK_URL');
  const rawMonetagZoneId = envOrFile(env, 'MONETAG_MAIN_ZONE_ID', monetag.mainZoneId || monetag.zoneId);
  const monetagMainZoneId = /^\d{1,20}$/.test(String(rawMonetagZoneId || '')) ? String(rawMonetagZoneId) : '';
  if (rawMonetagZoneId && !monetagMainZoneId) invalidValues.push('MONETAG_MAIN_ZONE_ID');
  const rawPublisher = envOrFile(env, 'MONETAG_PUBLISHER_ID', monetag.publisherId);
  const publisherText = typeof rawPublisher === 'string' ? rawPublisher : String(rawPublisher || '');
  const monetagPublisherId = /^[A-Za-z0-9_-]{1,64}$/.test(publisherText) ? publisherText : '';
  if (rawPublisher && !monetagPublisherId) invalidValues.push('MONETAG_PUBLISHER_ID');
  const rawPostbackSecret = envOrFile(env, 'MONETAG_POSTBACK_SECRET', monetag.postbackSecret);
  const monetagPostbackSecret = typeof rawPostbackSecret === 'string' ? rawPostbackSecret : '';
  if (rawPostbackSecret && !monetagPostbackSecret) invalidValues.push('MONETAG_POSTBACK_SECRET');
  const policyReviewedRaw = envOrFile(env, 'MONETAG_POLICY_REVIEWED', monetag.policyReviewed);
  const policyReviewed = policyReviewedRaw === true || String(policyReviewedRaw || '').toLowerCase() === 'true';
  // Configuration presence and a policy checkbox do not verify provider callback semantics.
  // Keep the adapter fail-closed until it is implemented and exercised against official docs.
  const monetagIntegrationVerified = false;
  if (monetagSdkUrl || monetagMainZoneId || monetagPublisherId || monetagPostbackSecret || policyReviewed) {
    warnings.push('Monetag is not enabled: SDK/postback behavior has not been verified against the provider; configuration values alone are insufficient.');
  }

  const rawTotpSecret = envOrFile(env, 'ADMIN_TOTP_SECRET', admin.totpSecret);
  const compactTotpSecret = rawTotpSecret ? rawTotpSecret.replace(/[ =]/g, '').toUpperCase() : '';
  const adminTotpSecret = compactTotpSecret.length >= 16 && compactTotpSecret.length <= 128
    && Array.from(compactTotpSecret).every(char => (char >= 'A' && char <= 'Z') || (char >= '2' && char <= '7'))
    ? compactTotpSecret
    : '';
  if (rawTotpSecret && !adminTotpSecret) invalidValues.push('ADMIN_TOTP_SECRET');

  const paymentCurrencyRaw = envOrFile(env, 'PAYMENT_CURRENCY', payments.currency) || '';
  const paymentCurrency = /^[A-Za-z]{3}$/.test(paymentCurrencyRaw) ? paymentCurrencyRaw.toUpperCase() : '';
  if (paymentCurrencyRaw && !paymentCurrency) invalidValues.push('PAYMENT_CURRENCY');
  const requestedPaymentProvider = String(envOrFile(env, 'PAYMENT_PROVIDER', payments.provider) || 'disabled').toLowerCase();
  const requestedPayoutProvider = String(envOrFile(env, 'PAYOUT_PROVIDER', payments.payoutProvider) || 'disabled').toLowerCase();
  // There is no verified provider adapter in this application. Do not turn a label such
  // as "manual", "stripe" or "bkash" into a working integration.
  const paymentProvider = 'disabled';
  const payoutProvider = 'disabled';
  if (requestedPaymentProvider !== 'disabled') warnings.push('A payment provider was named in configuration, but no verified adapter is implemented; deposits remain disabled.');
  if (requestedPayoutProvider !== 'disabled') warnings.push('A payout provider was named in configuration, but no verified adapter is implemented; withdrawals remain disabled.');

  const methodsRaw = payments.manualPaymentMethods;
  const manualPaymentMethods = Array.isArray(methodsRaw)
    ? methodsRaw.filter(value => typeof value === 'string' && /^[a-z0-9_-]{2,32}$/i.test(value)).slice(0, 8)
    : [];

  const initDataAgeRaw = envOrFile(env, 'TELEGRAM_INIT_DATA_MAX_AGE_SECONDS', telegram.initDataMaxAgeSeconds);
  const telegramInitDataMaxAgeSeconds = numberOr(initDataAgeRaw, 3600, 60, 86400);
  const trustProxyHops = numberOr(env.TRUST_PROXY_HOPS, env.NODE_ENV === 'production' ? 1 : 0, 0, 8);
  const financialSafety = normalizeFinancialSafety(file.financialSafety || file.safety);
  const systemSettingsSeed = isPlainObject(file.defaults) ? structuredClone(file.defaults) : {};
  if (isPlainObject(file.financialSafety || file.safety)) {
    const systemSeed = isPlainObject(systemSettingsSeed.system) ? systemSettingsSeed.system : {};
    systemSettingsSeed.system = {
      ...systemSeed,
      safetyLimits: { ...(isPlainObject(systemSeed.safetyLimits) ? systemSeed.safetyLimits : {}), ...financialSafety }
    };
  }

  if (details.source === 'file' && details.mode && (parseInt(details.mode, 8) & 0o077) !== 0) {
    warnings.push('all_details.txt has group/world-readable permissions; restrict it to the server owner (for example chmod 600).');
  }
  if (details.source === 'missing') warnings.push('Private configuration is missing. Supply all_details.txt at the project root, set ALL_DETAILS_FILE, or set ALL_DETAILS_JSON at runtime.');
  if (!telegramBotToken) warnings.push('Telegram authentication is disabled until a syntactically valid TELEGRAM_BOT_TOKEN is supplied.');
  if (!telegramAdminId) warnings.push('Admin operations are unavailable until a valid ADMIN_TELEGRAM_ID is supplied.');
  if (!firebaseServiceAccount && !firebaseCredentialsPath) warnings.push('Firebase Cloud Firestore is disabled until Firebase Admin service-account credentials are supplied; Firebase Web SDK settings are not server credentials.');
  if (!adminTotpSecret) warnings.push('Administrator finance MFA is not configured; finance administration remains locked.');
  if (!monetagIntegrationVerified) warnings.push('Monetag is disabled until its SDK, zone, private postback verification and policy review are all configured.');
  if (requestedPaymentProvider !== 'disabled' || requestedPayoutProvider !== 'disabled') {
    // The specific provider name is deliberately not echoed into logs or responses.
  }

  return Object.freeze({
    nodeEnv: env.NODE_ENV || 'development',
    isProduction: env.NODE_ENV === 'production',
    port: numberOr(env.PORT, 3000, 1, 65535),
    host: '0.0.0.0',
    root: options.root || ROOT,
    configFilePath: details.filePath || '',
    detailsSource: details.source,
    detailsFormat: details.format,
    detailsFileLoaded: ['file', 'environment_json', 'environment_text', 'provided_object'].includes(details.source),
    sessionSecret,
    sessionSecretSource,
    telegramBotToken,
    telegramBotTokenValid: !!telegramBotToken,
    telegramAdminId,
    telegramAdminIdValid: !!telegramAdminId,
    telegramBotUsername: validBotUsername ? telegramBotUsername : '',
    miniAppShortName,
    publicAppUrl,
    telegramInitDataMaxAgeSeconds,
    firebaseProjectId: firebaseProjectId || '',
    firebaseServiceAccount,
    firebaseCredentialsPath: firebaseCredentialsPath || '',
    firebaseDatabaseUrl: envOrFile(env, 'FIREBASE_DATABASE_URL', firebase.databaseURL) || '',
    firebaseWebConfig: isPlainObject(firebase.webConfig) ? firebase.webConfig : null,
    firebaseAdminConfigured: !!(firebaseServiceAccount || firebaseCredentialsPath),
    monetagPublisherId,
    monetagMainZoneId,
    monetagSdkUrl,
    monetagPostbackSecret,
    monetagPolicyReviewed: policyReviewed,
    monetagIntegrationVerified,
    paymentProvider,
    payoutProvider,
    paymentProviderRequested: requestedPaymentProvider,
    payoutProviderRequested: requestedPayoutProvider,
    paymentCurrency,
    paymentCurrencyExponent: numberOr(envOrFile(env, 'PAYMENT_CURRENCY_EXPONENT', payments.currencyExponent === undefined ? '2' : String(payments.currencyExponent)), 2, 0, 4),
    manualPaymentMethods,
    manualPaymentInstructions: envOrFile(env, 'MANUAL_PAYMENT_INSTRUCTIONS', payments.manualInstructions) || '',
    paymentMinDepositMinor: numberOr(envOrFile(env, 'PAYMENT_MIN_DEPOSIT_MINOR', payments.minimumDepositMinor === undefined ? '' : String(payments.minimumDepositMinor)), 0, 0, 1e12),
    paymentMaxDepositMinor: numberOr(envOrFile(env, 'PAYMENT_MAX_DEPOSIT_MINOR', payments.maximumDepositMinor === undefined ? '' : String(payments.maximumDepositMinor)), 0, 0, 1e12),
    paymentMinWithdrawalMinor: numberOr(envOrFile(env, 'PAYMENT_MIN_WITHDRAWAL_MINOR', payments.minimumWithdrawalMinor === undefined ? '' : String(payments.minimumWithdrawalMinor)), 0, 0, 1e12),
    paymentMaxWithdrawalMinor: numberOr(envOrFile(env, 'PAYMENT_MAX_WITHDRAWAL_MINOR', payments.maximumWithdrawalMinor === undefined ? '' : String(payments.maximumWithdrawalMinor)), 0, 0, 1e12),
    adminTotpSecret,
    adminTotpRequiredForFinance: env.NODE_ENV === 'production' || (env.ADMIN_TOTP_REQUIRED_FOR_FINANCE || 'true').toLowerCase() !== 'false',
    financialSafety,
    systemSettingsSeed,
    trustProxyHops,
    invalidValues: [...new Set(invalidValues)],
    configWarnings: [...new Set(warnings)]
  });
}

function getMissingRequired(config) {
  const missing = [];
  if (!config.telegramBotToken || config.telegramBotTokenValid === false) missing.push('TELEGRAM_BOT_TOKEN');
  if (!config.telegramAdminId || config.telegramAdminIdValid === false) missing.push('ADMIN_TELEGRAM_ID');
  if (!config.sessionSecret || Buffer.byteLength(config.sessionSecret, 'utf8') < 32) missing.push('SESSION_SECRET (or a valid TELEGRAM_BOT_TOKEN to derive one)');
  if (!config.firebaseServiceAccount && !config.firebaseCredentialsPath) missing.push('FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS');
  if (!config.firebaseProjectId && !(config.firebaseServiceAccount && config.firebaseServiceAccount.project_id)) missing.push('FIREBASE_PROJECT_ID');
  return missing;
}

function getConfigReport(config) {
  return {
    source: config.detailsSource || 'missing',
    format: config.detailsFormat || null,
    detailsFileLoaded: config.detailsFileLoaded === true,
    telegramBotToken: config.telegramBotTokenValid ? 'valid_format' : (config.invalidValues || []).includes('TELEGRAM_BOT_TOKEN') ? 'invalid' : 'missing',
    adminTelegramId: config.telegramAdminIdValid ? 'valid_format' : (config.invalidValues || []).includes('ADMIN_TELEGRAM_ID') ? 'invalid' : 'missing',
    sessionSecret: config.sessionSecret ? config.sessionSecretSource || 'configured' : 'missing',
    firebaseProjectId: config.firebaseProjectId ? 'present' : (config.invalidValues || []).includes('FIREBASE_PROJECT_ID') ? 'invalid' : 'missing',
    firebaseWebConfig: config.firebaseWebConfig ? 'present_public_web_config_only' : 'missing',
    firebaseAdminCredentials: config.firebaseAdminConfigured ? 'present' : (config.invalidValues || []).some(key => key.startsWith('FIREBASE') || key.startsWith('GOOGLE')) ? 'invalid_or_unavailable' : 'missing',
    monetag: {
      sdkUrl: !!config.monetagSdkUrl,
      zoneId: !!config.monetagMainZoneId,
      publisherId: !!config.monetagPublisherId,
      postbackSecret: !!config.monetagPostbackSecret,
      policyReviewed: config.monetagPolicyReviewed === true,
      enabled: config.monetagIntegrationVerified === true
    },
    payments: { depositsEnabled: false, withdrawalsEnabled: false, providerAdapter: 'not_implemented' },
    adminTotp: config.adminTotpSecret ? 'configured' : (config.invalidValues || []).includes('ADMIN_TOTP_SECRET') ? 'invalid' : 'missing',
    requiredMissing: getMissingRequired(config),
    invalidValues: [...(config.invalidValues || [])],
    warnings: [...(config.configWarnings || [])]
  };
}

module.exports = {
  ROOT,
  clean,
  parseDetailsText,
  loadConfig,
  getMissingRequired,
  getConfigReport,
  validTelegramToken,
  validProjectId,
  deriveSessionSecret
};
