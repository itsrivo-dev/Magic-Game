'use strict';

const { loadConfig, getMissingRequired } = require('../server/config');
const { makeFirebaseStore } = require('../server/store');
const { initializeSettings } = require('../server/services');

async function main() {
  let config;
  try { config = loadConfig(); }
  catch (error) {
    const code=String(error&&error.message||'CONFIG_LOAD_FAILED').split(':')[0];
    console.error(`Configuration error (${code}).`);
    process.exitCode=1;
    return;
  }
  const missing=getMissingRequired(config).filter(item=>item.startsWith('FIREBASE')||item.startsWith('GOOGLE'));
  if(missing.length) {
    console.error(`Firestore initialization blocked. Missing: ${missing.join(', ')}.`);
    process.exitCode=1;
    return;
  }
  const result=makeFirebaseStore(config);
  if(!result.store) {
    console.error(`Firebase Admin initialization failed (${result.reason||'unknown'}). No data was changed.`);
    process.exitCode=1;
    return;
  }
  await initializeSettings(result.store,config);
  console.log('Firestore defaults initialized only where documents were absent. Existing documents were preserved.');
  await Promise.all(result.admin.apps.map(app=>app.delete().catch(()=>{})));
}
main().catch(error=>{
  console.error(`Firestore initialization failed (${error&&error.code||error&&error.name||'unknown'}). No secret values were logged.`);
  process.exitCode=1;
});
