'use strict';

const crypto = require('node:crypto');

class TelegramAuthError extends Error {
  constructor(code, status = 401) {
    super(code);
    this.name = 'TelegramAuthError';
    this.code = code;
    this.status = status;
  }
}

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !/^[a-f0-9]{64}$/i.test(a) || !/^[a-f0-9]{64}$/i.test(b)) return false;
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function parseUser(value) {
  let user;
  try { user = JSON.parse(value); } catch { throw new TelegramAuthError('telegram_user_invalid', 400); }
  if (!user || typeof user !== 'object' || Array.isArray(user)) throw new TelegramAuthError('telegram_user_invalid', 400);
  const id = String(user.id ?? '');
  if (!/^\d{1,20}$/.test(id) || BigInt(id) <= 0n) throw new TelegramAuthError('telegram_user_id_invalid', 400);
  const firstName = typeof user.first_name === 'string' ? user.first_name.trim().slice(0, 128) : '';
  if (!firstName) throw new TelegramAuthError('telegram_user_name_missing', 400);
  const lastName = typeof user.last_name === 'string' ? user.last_name.trim().slice(0, 128) : undefined;
  const username = typeof user.username === 'string' && /^[a-zA-Z0-9_]{1,64}$/.test(user.username) ? user.username : undefined;
  const photoUrl = typeof user.photo_url === 'string' && /^https:\/\//i.test(user.photo_url) ? user.photo_url.slice(0, 2048) : undefined;
  const languageCode = typeof user.language_code === 'string' && /^[a-zA-Z-]{2,16}$/.test(user.language_code) ? user.language_code : undefined;
  return {
    id,
    firstName,
    ...(lastName ? { lastName } : {}),
    ...(username ? { username } : {}),
    ...(photoUrl ? { photoUrl } : {}),
    ...(languageCode ? { languageCode } : {}),
    ...(user.is_premium === true ? { isPremium: true } : {}),
    ...(user.allows_write_to_pm === true ? { allowsWriteToPm: true } : {})
  };
}

function verifyTelegramInitData(raw, botToken, options = {}) {
  if (!botToken) throw new TelegramAuthError('telegram_auth_not_configured', 503);
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > (options.maxBytes || 16384)) {
    throw new TelegramAuthError('telegram_init_data_missing_or_too_large', 400);
  }
  let params;
  try { params = new URLSearchParams(raw); } catch { throw new TelegramAuthError('telegram_init_data_malformed', 400); }
  const keys = [...params.keys()];
  if (keys.length > 64 || new Set(keys).size !== keys.length) throw new TelegramAuthError('telegram_init_data_malformed', 400);
  const receivedHash = params.get('hash');
  if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) throw new TelegramAuthError('telegram_signature_missing', 401);
  const pairs = [];
  for (const [key, value] of params.entries()) if (key !== 'hash') pairs.push(`${key}=${value}`);
  pairs.sort((a, b) => a.localeCompare(b));
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expectedHash = crypto.createHmac('sha256', secretKey).update(pairs.join('\n')).digest('hex');
  if (!safeEqualHex(receivedHash, expectedHash)) throw new TelegramAuthError('telegram_signature_invalid', 403);

  const authDate = Number(params.get('auth_date'));
  if (!Number.isSafeInteger(authDate) || authDate <= 0) throw new TelegramAuthError('telegram_auth_date_invalid', 401);
  const nowSeconds = Math.floor((options.now ? options.now() : Date.now()) / 1000);
  const maxAge = options.maxAgeSeconds ?? 86400;
  if (authDate > nowSeconds + 60 || nowSeconds - authDate > maxAge) throw new TelegramAuthError('telegram_init_data_expired', 401);

  const userValue = params.get('user');
  if (!userValue) throw new TelegramAuthError('telegram_user_missing', 400);
  const user = parseUser(userValue);
  const startParam = params.get('start_param');
  return {
    user,
    authDate,
    ...(startParam && /^[A-Za-z0-9_-]{1,64}$/.test(startParam) ? { startParam } : {}),
    queryId: params.get('query_id') || undefined,
    chatType: params.get('chat_type') || undefined
  };
}

module.exports = { TelegramAuthError, verifyTelegramInitData };
