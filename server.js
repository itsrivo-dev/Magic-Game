'use strict';

const { loadConfig } = require('./server/config');
const { makeFirebaseStore } = require('./server/store');
const { createApp } = require('./server/app');

let config;
try {
  config = loadConfig();
} catch (error) {
  const code = String(error && error.message || 'CONFIG_LOAD_FAILED').split(':')[0];
  process.stderr.write(`[mag-ia] configuration error (${code})\n`);
  process.exit(1);
}

const firebase = makeFirebaseStore(config);
const app = createApp({ config, store: firebase.store, storeReason: firebase.reason });
const port = Number(process.env.PORT) || config.port || 3000;
const host = '0.0.0.0';
const server = app.listen(port, host, () => {
  process.stdout.write(`[mag-ia] listening on ${host}:${port}; firebase=${firebase.store ? 'configured' : 'not_configured'}\n`);
});

function stop(signal) {
  process.stdout.write(`[mag-ia] ${signal} received; shutting down\n`);
  server.close(() => {
    if (firebase.admin && firebase.admin.apps) {
      Promise.all(firebase.admin.apps.map(item => item.delete().catch(() => {}))).finally(() => process.exit(0));
    } else process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
