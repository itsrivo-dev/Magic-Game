'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { railwayPayload, localEnvContent, redactedSummary, nextSteps } = require('../scripts/configure-from-details');
const { applyMenuButton } = require('../server/telegram-menu');
const { loadConfig, getConfigReport, parseDetailsText } = require('../server/config');

const botToken = `123456:${'a'.repeat(35)}`;

test('railway payload round-trips through the same parser the server uses', () => {
  const details = [
    'bot token : ' + botToken,
    'admin id : 8502686983',
    "monetag : <script src='//libtl.com/sdk.js' data-zone='12051648'></script>"
  ].join('\n');
  const payload = railwayPayload(details);
  assert.match(payload, /^ALL_DETAILS_TEXT=/);
  const roundTripped = parseDetailsText(payload.slice('ALL_DETAILS_TEXT='.length), 'ALL_DETAILS_TEXT');
  assert.equal(roundTripped.telegram.botToken, botToken);
  assert.equal(roundTripped.telegram.adminTelegramId, '8502686983');
  assert.equal(roundTripped.monetag.mainZoneId, '12051648');
});

test('local env pointer contains no secrets', () => {
  const content = localEnvContent('/private/all_details.txt');
  assert.match(content, /ALL_DETAILS_FILE=\/private\/all_details\.txt/);
  assert.equal(content.includes(botToken), false);
});

test('redacted summary and next steps never include secret values', () => {
  const privateValues = {
    telegram: { botToken, adminTelegramId: '900000001' },
    session: { secret: 'S'.repeat(48) },
    firebase: { projectId: 'magia-test-123' },
    monetag: { sdkUrl: 'https://example.invalid/sdk.js', mainZoneId: '123456' }
  };
  const config = loadConfig({ file: privateValues, env: {}, loadDotenv: false });
  const report = getConfigReport(config);
  const summary = redactedSummary(report).join('\n');
  const steps = nextSteps(config, report).join('\n');
  for (const secret of [botToken, privateValues.session.secret, 'magia-test-123']) {
    assert.equal(summary.includes(secret), false, 'summary leaks a secret');
    assert.equal(steps.includes(secret), false, 'steps leak a secret');
  }
  assert.equal(report.telegramBotToken, 'valid_format');
});

test('menu button helper fails closed without URL or token', async () => {
  const noToken = await applyMenuButton({ telegramBotToken: '', publicAppUrl: 'https://example.com' });
  assert.equal(noToken.ok, false);
  assert.equal(noToken.code, 'telegram_bot_token_not_configured');
  const noUrl = await applyMenuButton({ telegramBotToken: botToken, publicAppUrl: '' });
  assert.equal(noUrl.ok, false);
  assert.equal(noUrl.code, 'public_app_url_not_configured');
  const httpUrl = await applyMenuButton({ telegramBotToken: botToken, publicAppUrl: 'http://example.com' });
  assert.equal(httpUrl.ok, false);
  assert.equal(httpUrl.code, 'public_app_url_not_https');
});

test('configure script writes a git-ignored local pointer and never the secrets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magia-configure-'));
  try {
    const detailsPath = path.join(dir, 'all_details.txt');
    fs.writeFileSync(detailsPath, `bot token : ${botToken}\nadmin id : 8502686983\n`, { mode: 0o600 });
    const envPath = path.join(dir, '.env');
    fs.writeFileSync(envPath, localEnvContent(detailsPath), { mode: 0o600 });
    const written = fs.readFileSync(envPath, 'utf8');
    assert.equal(written.includes(botToken), false);
    assert.match(written, new RegExp(`ALL_DETAILS_FILE=${detailsPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
