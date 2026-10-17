'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { verifyTelegramInitData, TelegramAuthError } = require('./telegram');
const { signSession, verifySession, signAdminMfa, verifyAdminMfa, verifyTotp } = require('./session');
const {
  AppError, initializeSettings, ensureTelegramUser, getOperationalSettings, publicOperationalConfig,
  getGameProgress, initializeGameProgress, syncGameProgress, claimReferralReward, createAdRewardSession,
  acceptMonetagPostback, claimAdReward, createDeposit, createWithdrawal, decideDeposit, decideWithdrawal,
  getUserFinance, referralSummary, profileEnvelope, updateProfilePreferences, adminSummary, saveAdminSettings,
  adminUserDetail, setUserStatus, addAdminNote, listAdminRequests, listAdminReferrals, reviewReferral,
  getAdminTransactions, publicProfile, asString, asInt
} = require('./services');
const { sanitizeSave } = require('./game-state');
const { sha256 } = require('./store');
const { getMissingRequired } = require('./config');

const SESSION_COOKIE = 'magia_session';
const MFA_COOKIE = 'magia_admin_mfa';

function parseCookies(header = '') {
  const out = Object.create(null);
  for (const item of header.split(';')) {
    const i = item.indexOf('=');
    if (i < 0) continue;
    const key = item.slice(0,i).trim();
    try { out[key] = decodeURIComponent(item.slice(i+1).trim()); } catch { out[key] = ''; }
  }
  return out;
}
function cookieOptions(config, maxAge) {
  return {
    httpOnly:true,
    secure:config.isProduction,
    sameSite:'strict',
    path:'/',
    maxAge
  };
}
function safeStatus(error) {
  if (error instanceof AppError || error instanceof TelegramAuthError) return error.status;
  if (error && Number.isInteger(error.status) && error.status >= 400 && error.status < 600) return error.status;
  return 500;
}
function safeCode(error) {
  if (error instanceof AppError || error instanceof TelegramAuthError) return error.code;
  return 'internal_error';
}
function asyncRoute(handler) {
  return (req,res,next) => Promise.resolve(handler(req,res,next)).catch(next);
}
function requestOriginAllowed(req, config) {
  const origin=req.get('origin');
  if(!origin) return true;
  let parsed;
  try { parsed=new URL(origin); } catch { return false; }
  const expected=[];
  if(config.publicAppUrl){
    try { expected.push(new URL(config.publicAppUrl).origin); } catch {}
  }
  const protocol=req.protocol || 'http';
  expected.push(`${protocol}://${req.get('host')}`);
  return expected.includes(parsed.origin);
}
function makeLimiter(windowMs, limit) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders:'draft-8',
    legacyHeaders:false,
    skipSuccessfulRequests:false,
    handler:(_req,res)=>res.status(429).json({error:'rate_limited',message:'Please wait before trying again.'})
  });
}
function safeAdStatus(row) {
  if(!row) return null;
  return {ymid:row.ymid,status:row.status,createdAtMs:row.createdAtMs,expiresAtMs:row.expiresAtMs,rewardMagicCoins:row.rewardMagicCoins};
}
function safeAdminSettings(settings,config) {
  return {
    system:settings.system,
    game:settings.game,
    ads:settings.ads,
    payments:{...settings.payment,provider:config.paymentProvider,payoutProvider:config.payoutProvider,methods:config.manualPaymentMethods,instructionsConfigured:!!config.manualPaymentInstructions,currency:config.paymentCurrency||settings.payment.currency||''},
    referrals:settings.referrals,
    secretStatus:{
      telegramBotTokenConfigured:!!config.telegramBotToken,
      firebaseAdminConfigured:!!(config.firebaseServiceAccount||config.firebaseCredentialsPath),
      sessionSecretConfigured:!!(config.sessionSecret&&Buffer.byteLength(config.sessionSecret)>=32),
      monetagSdkUrlConfigured:!!config.monetagSdkUrl,
      monetagPostbackSecretConfigured:!!config.monetagPostbackSecret,
      adminTelegramIdConfigured:/^\d{1,20}$/.test(String(config.telegramAdminId||'')),
      adminTotpConfigured:!!config.adminTotpSecret,
      paymentProviderConfigured:settings.payments.provider!=='not_configured'||settings.payments.payoutProvider!=='not_configured',
      revenueReporting:'unavailable_unverified'
    }
  };
}

function createApp(options = {}) {
  const config=options.config || {};
  const store=options.store || null;
  const storeReason=options.storeReason || (store?'configured':'firebase_credentials_missing');
  const app=express();
  app.disable('x-powered-by');
  if(Number.isInteger(config.trustProxyHops)&&config.trustProxyHops>0) app.set('trust proxy',config.trustProxyHops);
  const monetagOrigin=config.monetagSdkUrl ? (()=>{try{return new URL(config.monetagSdkUrl).origin;}catch{return null;}})() : null;
  const scriptSrc=["'self'","'unsafe-inline'",'https://telegram.org','https://t.me'];
  if(monetagOrigin) scriptSrc.push(monetagOrigin);
  app.use(helmet({
    contentSecurityPolicy:{directives:{
      defaultSrc:["'self'"],
      scriptSrc,
      styleSrc:["'self'","'unsafe-inline'"],
      imgSrc:["'self'",'data:','https:'],
      connectSrc:["'self'",...(monetagOrigin?[monetagOrigin]:[])],
      frameSrc:["'self'",'https:', 'https://web.telegram.org','https://*.telegram.org'],
      fontSrc:["'self'",'data:'],
      objectSrc:["'none'"],
      baseUri:["'self'"],
      formAction:["'self'"],
      frameAncestors:["'self'",'https://web.telegram.org','https://*.telegram.org']
    }},
    crossOriginEmbedderPolicy:false,
    xFrameOptions:false,
    referrerPolicy:{policy:'no-referrer'}
  }));
  app.use(express.json({limit:'160kb',strict:true}));
  app.use((req,res,next)=>{
    if(req.path.startsWith('/api/')) res.setHeader('Cache-Control','no-store, max-age=0');
    next();
  });

  const authLimiter=makeLimiter(5*60*1000,12);
  const sensitiveLimiter=makeLimiter(60*1000,30);
  const adminLimiter=makeLimiter(60*1000,90);
  const gameLimiter=makeLimiter(60*1000,90);
  app.use('/api/admin',adminLimiter);

  function requireStore(req,res,next){
    if(!store){
      const missing=getMissingRequired(config);
      return res.status(503).json({error:'backend_not_configured',message:'Trusted backend storage is not configured.',missing:missing.includes('FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS')?['FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS']:[]});
    }
    const ready=app.locals.initialization;
    if(ready) return ready.then(()=>{
      if(app.locals.initializationError) return res.status(503).json({error:'storage_initialization_failed',message:'Trusted storage is unavailable or could not be initialized.'});
      next();
    }).catch(next);
    next();
  }
  function requireOrigin(req,res,next){
    if(!requestOriginAllowed(req,config)) return res.status(403).json({error:'origin_not_allowed'});
    if(req.get('sec-fetch-site')==='cross-site') return res.status(403).json({error:'cross_site_request_rejected'});
    if(!req.get('x-magia-request')) return res.status(403).json({error:'request_header_required'});
    next();
  }
  const requireSession=asyncRoute(async(req,res,next)=>{
    const token=parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const session=verifySession(token,config.sessionSecret);
    if(!session) throw new AppError(401,'telegram_session_required','Open Mag IA from the configured Telegram bot.');
    const user=await store.get(`users/${session.uid}`);
    if(!user) throw new AppError(401,'telegram_session_invalid');
    if(user.accountStatus && user.accountStatus!=='active') throw new AppError(403,'account_not_active');
    req.auth={uid:session.uid,user};
    next();
  });
  const requireAdmin=asyncRoute(async(req,res,next)=>{
    const adminId=String(config.telegramAdminId||'');
    if(!/^\d{1,20}$/.test(adminId)) throw new AppError(503,'admin_identity_not_configured');
    if(!req.auth || String(req.auth.uid)!==adminId) {
      if(store) {
        const id=crypto.randomUUID();
        const ipDigest=crypto.createHmac('sha256',config.sessionSecret||'magia-security-event').update(String(req.ip||'unknown')).digest('hex');
        await store.set(`securityEvents/${id}`,{id,event:'unauthorized_admin_route',uid:req.auth?req.auth.uid:null,ipHash:ipDigest,createdAt:store.timestamp(),createdAtMs:Date.now()});
      }
      throw new AppError(403,'admin_access_denied');
    }
    req.isAdmin=true;
    next();
  });
  const requireFinanceMfa=(req,res,next)=>{
    if(config.adminTotpRequiredForFinance!==false){
      if(!config.adminTotpSecret) return res.status(503).json({error:'admin_totp_not_configured',message:'Configure ADMIN_TOTP_SECRET before processing deposits or withdrawals.'});
      const mfa=parseCookies(req.headers.cookie)[MFA_COOKIE];
      if(!verifyAdminMfa(mfa,req.auth.uid,config.sessionSecret)) return res.status(403).json({error:'admin_mfa_required',message:'Verify the administrator authenticator code to continue.'});
    }
    next();
  };
  const settingsForRequest=async()=>getOperationalSettings(store,config);

  app.get('/health',(req,res)=>res.status(200).json({status:'ok',service:'mag-ia',storage:store?'configured':'not_configured',storageReason:store?null:storeReason,telegramConfigured:!!config.telegramBotToken,version:'1.1.0'}));
  app.get('/api/health',(req,res)=>res.status(200).json({status:'ok',storage:store?'configured':'not_configured',telegramConfigured:!!config.telegramBotToken}));
  app.get('/api/public/config',asyncRoute(async(req,res)=>{
    if(!store) return res.json({maintenanceMode:false,announcement:'',game:null,monetag:{enabled:false},finance:{depositsEnabled:false,withdrawalsEnabled:false}});
    if(app.locals.initialization) await app.locals.initialization;
    if(app.locals.initializationError) return res.json({maintenanceMode:false,announcement:'Cloud settings are temporarily unavailable.',game:null,monetag:{enabled:false},finance:{depositsEnabled:false,withdrawalsEnabled:false}});
    const settings=await settingsForRequest();
    res.json(publicOperationalConfig(settings,config));
  }));

  app.post('/api/auth/telegram',authLimiter,requireOrigin,requireStore,asyncRoute(async(req,res)=>{
    if(!config.sessionSecret||Buffer.byteLength(config.sessionSecret,'utf8')<32) throw new AppError(503,'session_secret_not_configured');
    if(!config.telegramBotToken) throw new AppError(503,'telegram_bot_token_not_configured');
    let verified;
    try {
      verified=verifyTelegramInitData(req.body&&req.body.initData,config.telegramBotToken,{maxAgeSeconds:86400});
    } catch(error) {
      const failId=crypto.randomUUID();
      const ipDigest=crypto.createHmac('sha256',config.sessionSecret).update(String(req.ip||'unknown')).digest('hex');
      await store.set(`securityEvents/${failId}`,{id:failId,event:'telegram_auth_failed',errorCode:error.code||'invalid',ipHash:ipDigest,createdAt:store.timestamp(),createdAtMs:Date.now()}).catch(()=>{});
      throw error;
    }
    const result=await ensureTelegramUser(store,verified,config);
    const token=signSession(result.user.telegramId,config.sessionSecret);
    res.cookie(SESSION_COOKIE,token,cookieOptions(config,7*24*60*60*1000));
    res.clearCookie(MFA_COOKIE,{path:'/',httpOnly:true,secure:config.isProduction,sameSite:'strict'});
    if(String(result.user.telegramId)===String(config.telegramAdminId||'')) {
      const id=crypto.randomUUID();
      await store.set(`adminLogs/${id}`,{id,actorUid:result.user.telegramId,action:'admin.login',targetUid:result.user.telegramId,details:{method:'verified_telegram_init_data'},createdAt:store.timestamp(),createdAtMs:Date.now()});
    }
    const settings=await settingsForRequest();
    const envelope=await profileEnvelope(store,result.user.telegramId,settings,config);
    const progress=await getGameProgress(store,result.user.telegramId);
    res.json({authenticated:true,created:result.created,profile:envelope.profile,game:{coins:envelope.game.coins,version:progress.version,hasProgress:progress.exists,state:progress.state,migrationStatus:progress.migrationStatus},realMoney:envelope.realMoney});
  }));
  app.post('/api/auth/logout',requireOrigin,(req,res)=>{
    res.clearCookie(SESSION_COOKIE,{path:'/',httpOnly:true,secure:config.isProduction,sameSite:'strict'});
    res.clearCookie(MFA_COOKIE,{path:'/',httpOnly:true,secure:config.isProduction,sameSite:'strict'});
    res.status(200).json({ok:true});
  });

  app.get('/api/me',requireStore,requireSession,asyncRoute(async(req,res)=>{
    const settings=await settingsForRequest();
    const envelope=await profileEnvelope(store,req.auth.uid,settings,config);
    const finance=await getUserFinance(store,req.auth.uid,settings);
    res.json({...envelope,finance:{configured:finance.configured,status:finance.status,currency:finance.currency,currencyExponent:finance.currencyExponent,availableMinor:finance.availableMinor,reservedMinor:finance.reservedMinor}});
  }));
  app.patch('/api/me/preferences',requireStore,requireOrigin,requireSession,sensitiveLimiter,asyncRoute(async(req,res)=>{
    const preferences=await updateProfilePreferences(store,req.auth.uid,req.body&&req.body.preferences);
    res.json({preferences});
  }));

  app.get('/api/game',requireStore,requireSession,asyncRoute(async(req,res)=>{
    const progress=await getGameProgress(store,req.auth.uid);
    res.json(progress);
  }));
  app.post('/api/game/initialize',requireStore,requireOrigin,requireSession,gameLimiter,asyncRoute(async(req,res)=>{
    const progress=await initializeGameProgress(store,req.auth.uid,null,false);
    res.status(200).json(progress);
  }));
  app.post('/api/game/migrate',requireStore,requireOrigin,requireSession,gameLimiter,asyncRoute(async(req,res)=>{
    if(!req.body||!req.body.state) throw new AppError(400,'migration_state_required');
    const existing=await getGameProgress(store,req.auth.uid);
    if(existing.exists) return res.status(200).json({...existing,migrationIgnored:true});
    const progress=await initializeGameProgress(store,req.auth.uid,req.body.state,true);
    res.status(200).json({...progress,migrated:true,trust:'legacy_unverified_limited'});
  }));
  app.post('/api/game/sync',requireStore,requireOrigin,requireSession,gameLimiter,asyncRoute(async(req,res)=>{
    const state=req.body&&req.body.state;
    if(!state) throw new AppError(400,'game_state_required');
    const settings=await settingsForRequest();
    if(settings.system.maintenanceMode) throw new AppError(503,'maintenance_mode');
    const result=await syncGameProgress(store,req.auth.uid,state,req.body.version,settings);
    if(result.conflict) return res.status(409).json({error:'game_sync_conflict',version:result.version,state:result.state});
    res.json({accepted:true,version:result.version,serverTime:result.serverTime,allowance:result.allowance});
  }));
  app.post('/api/game/recover',requireStore,requireOrigin,requireSession,gameLimiter,asyncRoute(async(req,res)=>{
    const state=req.body&&req.body.state;
    if(!state) throw new AppError(400,'game_state_required');
    const settings=await settingsForRequest();
    if(settings.system.maintenanceMode) throw new AppError(503,'maintenance_mode');
    const result=await syncGameProgress(store,req.auth.uid,state,req.body.version,settings,{backupCurrent:true});
    if(result.conflict) return res.status(409).json({error:'game_sync_conflict',version:result.version,state:result.state});
    res.json({accepted:true,version:result.version,serverTime:result.serverTime,allowance:result.allowance,backupCreated:true,state:result.state});
  }));
  app.get('/api/account/referrals',requireStore,requireSession,asyncRoute(async(req,res)=>res.json(await referralSummary(store,req.auth.uid,config))));
  app.post('/api/referrals/:referralId/claim',requireStore,requireOrigin,requireSession,sensitiveLimiter,asyncRoute(async(req,res)=>{
    const result=await claimReferralReward(store,req.auth.uid,req.params.referralId);
    res.json({claimed:true,amountMagicCoins:result.amount,version:result.version,state:result.state});
  }));
  app.get('/api/account/finance',requireStore,requireSession,asyncRoute(async(req,res)=>{
    const settings=await settingsForRequest();
    res.json(await getUserFinance(store,req.auth.uid,settings));
  }));
  app.post('/api/deposits',requireStore,requireOrigin,requireSession,sensitiveLimiter,asyncRoute(async(req,res)=>{
    const settings=await settingsForRequest();
    const result=await createDeposit(store,req.auth.uid,req.body,settings,req.get('idempotency-key'));
    res.status(result.replayed?200:201).json(result);
  }));
  app.post('/api/withdrawals',requireStore,requireOrigin,requireSession,sensitiveLimiter,asyncRoute(async(req,res)=>{
    const settings=await settingsForRequest();
    const result=await createWithdrawal(store,req.auth.uid,req.body,settings,req.get('idempotency-key'));
    res.status(result.replayed?200:201).json(result);
  }));
  app.post('/api/ads/reward-session',requireStore,requireOrigin,requireSession,sensitiveLimiter,asyncRoute(async(req,res)=>{
    const settings=await settingsForRequest();
    const row=await createAdRewardSession(store,req.auth.uid,settings);
    res.status(201).json({ymid:row.ymid,status:row.status,zoneId:settings.ads.mainZoneId,requestVar:settings.ads.placements.rewarded,rewardMagicCoins:row.rewardMagicCoins});
  }));
  app.get('/api/ads/:ymid/status',requireStore,requireSession,asyncRoute(async(req,res)=>{
    const row=await store.get(`adRewards/${req.params.ymid}`);
    if(!row||String(row.userId)!==String(req.auth.uid)) throw new AppError(404,'ad_reward_not_found');
    res.json(safeAdStatus(row));
  }));
  app.post('/api/ads/:ymid/claim',requireStore,requireOrigin,requireSession,sensitiveLimiter,asyncRoute(async(req,res)=>{
    const result=await claimAdReward(store,req.auth.uid,req.params.ymid);
    res.json({claimed:true,amountMagicCoins:result.amount,version:result.version,state:result.state});
  }));
  app.get('/api/monetag/postback',makeLimiter(60*1000,240),requireStore,asyncRoute(async(req,res)=>{
    const result=await acceptMonetagPostback(store,req.query,config);
    res.status(200).type('text/plain').send('ok');
  }));

  app.get('/api/admin/me',requireStore,requireSession,requireAdmin,asyncRoute(async(req,res)=>{
    const mfaToken=parseCookies(req.headers.cookie)[MFA_COOKIE];
    const mfaVerified=verifyAdminMfa(mfaToken,req.auth.uid,config.sessionSecret);
    res.json({authorized:true,profile:publicProfile(req.auth.user),mfaRequired:config.adminTotpRequiredForFinance!==false,mfaConfigured:!!config.adminTotpSecret,mfaVerified});
  }));
  app.post('/api/admin/mfa',requireStore,requireOrigin,requireSession,requireAdmin,makeLimiter(5*60*1000,8),asyncRoute(async(req,res)=>{
    if(!config.adminTotpSecret) throw new AppError(503,'admin_totp_not_configured');
    if(!verifyTotp(config.adminTotpSecret,req.body&&req.body.code)) throw new AppError(401,'admin_mfa_code_invalid');
    const token=signAdminMfa(req.auth.uid,config.sessionSecret);
    res.cookie(MFA_COOKIE,token,cookieOptions(config,15*60*1000));
    const id=crypto.randomUUID();
    await store.set(`adminLogs/${id}`,{id,actorUid:req.auth.uid,action:'admin.mfa.verified',targetUid:req.auth.uid,details:{factor:'totp'},createdAt:store.timestamp(),createdAtMs:Date.now()});
    res.json({verified:true,expiresInSeconds:900});
  }));
  app.get('/api/admin/summary',requireStore,requireSession,requireAdmin,asyncRoute(async(req,res)=>{
    const settings=await settingsForRequest();
    const verified=verifyAdminMfa(parseCookies(req.headers.cookie)[MFA_COOKIE],req.auth.uid,config.sessionSecret);
    const includeFinance=config.adminTotpRequiredForFinance===false||verified;
    const lockReason=config.adminTotpSecret?'mfa_required':'totp_not_configured';
    res.json(await adminSummary(store,settings,{includeFinance,lockReason}));
  }));
  app.get('/api/admin/users',requireStore,requireSession,requireAdmin,asyncRoute(async(req,res)=>{
    const q=asString(req.query.q,100);
    const rows=await store.findUsers(q,{limit:25});
    res.json({users:rows.map(row=>publicProfile(row.data))});
  }));
  app.get('/api/admin/users/:uid',requireStore,requireSession,requireAdmin,requireFinanceMfa,asyncRoute(async(req,res)=>res.json(await adminUserDetail(store,req.params.uid,config))));
  app.post('/api/admin/users/:uid/status',requireStore,requireOrigin,requireSession,requireAdmin,sensitiveLimiter,asyncRoute(async(req,res)=>{
    const result=await setUserStatus(store,req.auth.uid,req.params.uid,req.body&&req.body.status,config,req.body&&req.body.note);
    res.json(result);
  }));
  app.post('/api/admin/users/:uid/notes',requireStore,requireOrigin,requireSession,requireAdmin,sensitiveLimiter,asyncRoute(async(req,res)=>{
    const result=await addAdminNote(store,req.auth.uid,req.params.uid,req.body&&req.body.note);
    res.status(201).json(result);
  }));
  app.get('/api/admin/settings',requireStore,requireSession,requireAdmin,asyncRoute(async(req,res)=>{
    const settings=await settingsForRequest();
    res.json(safeAdminSettings(settings,config));
  }));
  app.patch('/api/admin/settings',requireStore,requireOrigin,requireSession,requireAdmin,sensitiveLimiter,asyncRoute(async(req,res)=>{
    const patch=req.body&&req.body.settings;
    if(!patch||typeof patch!=='object'||Array.isArray(patch)) throw new AppError(400,'settings_object_required');
    const currentSettings=await settingsForRequest();
    const financeFields=['depositsEnabled','withdrawalsEnabled','minimumDepositMinor','maximumDepositMinor','minimumWithdrawalMinor','maximumWithdrawalMinor','currency','currencyExponent'];
    const paymentPatch=patch.payments&&typeof patch.payments==='object'&&!Array.isArray(patch.payments)?patch.payments:{};
    const financeSettingsChanged=financeFields.some(key=>{
      if(!Object.hasOwn(paymentPatch,key)) return false;
      const incoming=paymentPatch[key],current=currentSettings.payment[key];
      if(typeof current==='number') return Number(incoming)!==current;
      if(typeof current==='boolean') return incoming!==current;
      return String(incoming??'').toUpperCase()!==String(current??'').toUpperCase();
    })||(patch.system&&Object.hasOwn(patch.system,'realMoneyEnabled')&&patch.system.realMoneyEnabled!==currentSettings.system.realMoneyEnabled);
    if(financeSettingsChanged&&config.adminTotpRequiredForFinance!==false) {
      if(!config.adminTotpSecret) throw new AppError(503,'admin_totp_not_configured');
      if(!verifyAdminMfa(parseCookies(req.headers.cookie)[MFA_COOKIE],req.auth.uid,config.sessionSecret)) throw new AppError(403,'admin_mfa_required');
    }
    const result=await saveAdminSettings(store,req.auth.uid,patch,config);
    const settings=await settingsForRequest();
    res.json({saved:true,settings:safeAdminSettings(settings,config)});
  }));
  app.get('/api/admin/deposits',requireStore,requireSession,requireAdmin,requireFinanceMfa,asyncRoute(async(req,res)=>{
    const status=asString(req.query.status,24);
    res.json({deposits:await listAdminRequests(store,'deposits',status||null,100)});
  }));
  app.post('/api/admin/deposits/:id/decision',requireStore,requireOrigin,requireSession,requireAdmin,requireFinanceMfa,sensitiveLimiter,asyncRoute(async(req,res)=>{
    const settings=await settingsForRequest();
    const result=await decideDeposit(store,req.auth.uid,req.params.id,req.body,config,settings);
    res.json(result);
  }));
  app.get('/api/admin/withdrawals',requireStore,requireSession,requireAdmin,requireFinanceMfa,asyncRoute(async(req,res)=>{
    const status=asString(req.query.status,24);
    res.json({withdrawals:await listAdminRequests(store,'withdrawals',status||null,100)});
  }));
  app.post('/api/admin/withdrawals/:id/action',requireStore,requireOrigin,requireSession,requireAdmin,requireFinanceMfa,sensitiveLimiter,asyncRoute(async(req,res)=>{
    const settings=await settingsForRequest();
    const result=await decideWithdrawal(store,req.auth.uid,req.params.id,req.body,config,settings);
    res.json(result);
  }));
  app.get('/api/admin/referrals',requireStore,requireSession,requireAdmin,asyncRoute(async(req,res)=>{
    const status=asString(req.query.status,24);
    res.json({referrals:await listAdminReferrals(store,status||null,200)});
  }));
  app.post('/api/admin/referrals/:id/review',requireStore,requireOrigin,requireSession,requireAdmin,sensitiveLimiter,asyncRoute(async(req,res)=>{
    const result=await reviewReferral(store,req.auth.uid,req.params.id,req.body&&req.body.action,req.body&&req.body.note);
    res.json(result);
  }));
  app.get('/api/admin/transactions',requireStore,requireSession,requireAdmin,requireFinanceMfa,asyncRoute(async(req,res)=>{
    const status=asString(req.query.status,24);
    res.json({transactions:await getAdminTransactions(store,status||null,200)});
  }));
  app.get('/api/admin/logs',requireStore,requireSession,requireAdmin,requireFinanceMfa,asyncRoute(async(req,res)=>{
    const rows=await store.list('adminLogs',{orderBy:'createdAtMs',direction:'desc',limit:100});
    res.json({logs:rows.map(x=>x.data)});
  }));

  const root=config.root || path.resolve(__dirname,'..');
  const sendIndex=(req,res)=>res.sendFile(path.join(root,'index.html'));
  app.get('/',sendIndex);
  app.get('/index.html',sendIndex);
  app.get('/client.js',(req,res)=>res.sendFile(path.join(root,'client.js')));
  app.get('/admin',(req,res)=>res.sendFile(path.join(root,'admin.html')));
  app.get('/admin.html',(req,res)=>res.sendFile(path.join(root,'admin.html')));
  app.get('/admin.js',(req,res)=>res.sendFile(path.join(root,'admin.js')));

  app.use((req,res)=>res.status(404).json({error:'not_found'}));
  app.use((error,req,res,_next)=>{
    const status=safeStatus(error);
    const code=safeCode(error);
    if(status>=500) {
      // Never log request bodies, initData, cookies, query secrets, or raw error messages.
      process.stderr.write(`[mag-ia] request failed (${code}; ${error&&error.name||'Error'})\n`);
    }
    if(error instanceof SyntaxError && error.status===400) return res.status(400).json({error:'invalid_json'});
    const message=error instanceof AppError||error instanceof TelegramAuthError
      ? (error.message||code)
      : status>=500?'The server is unavailable or not fully configured.':'The request could not be completed.';
    res.status(status).json({error:code,message});
  });

  if(store && options.initialize !== false) {
    app.locals.initialization=initializeSettings(store,config).catch(error=>{
      // Log a non-sensitive code only. An existing Firestore outage will surface as degraded API responses.
      process.stderr.write(`[mag-ia] initialization failed (${error&&error.code||error&&error.name||'Error'})\n`);
      app.locals.initializationError=true;
    });
  } else app.locals.initialization=Promise.resolve();

  app.locals.store=store;
  app.locals.config=config;
  return app;
}

module.exports={createApp,SESSION_COOKIE,MFA_COOKIE,parseCookies,requestOriginAllowed};
