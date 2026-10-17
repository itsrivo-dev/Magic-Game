'use strict';

(function MagIACloudClient() {
  const SAVE_KEY = 'magia.save.v1';
  const bridge = {
    mode:'starting',
    version:0,
    profile:null,
    publicConfig:null,
    finance:null,
    referrals:null,
    lastError:'',
    syncTimer:null,
    syncInFlight:null,
    queuedState:null,
    adScriptPromise:null,
    adSession:null,
    adBusy:false,
    bootstrapDone:false,
    readyForSync:false
  };

  function tg() { return window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null; }
  function isInTelegram() { return !!(tg() && typeof tg().initData === 'string' && tg().initData.length > 0); }
  function setStatus(text, kind = 'info') {
    const el=document.getElementById('cloud-status');
    if(el){ el.textContent=text; el.dataset.kind=kind; }
    const state=document.getElementById('acc-sync-state');
    if(state){ state.textContent=text; state.dataset.kind=kind; }
  }
  function apiError(code, message, status) {
    const error=new Error(message||code||'request_failed');
    error.code=code||'request_failed';
    error.status=status||0;
    return error;
  }
  async function request(path, options = {}) {
    const headers={'Accept':'application/json','X-MagIA-Request':'1',...(options.headers||{})};
    const init={method:options.method||'GET',credentials:'same-origin',headers,signal:options.signal};
    if(options.body!==undefined){ headers['Content-Type']='application/json'; init.body=JSON.stringify(options.body); }
    let response;
    try { response=await fetch(path,init); }
    catch { throw apiError('network_unavailable','The server could not be reached.'); }
    let body={};
    const text=await response.text();
    if(text){ try { body=JSON.parse(text); } catch { body={}; } }
    if(!response.ok) throw apiError(body.error||'request_failed',body.message||'The request could not be completed.',response.status);
    return body;
  }
  function normalizeInitData() {
    const app=tg();
    if(!app||!app.initData) return '';
    try { app.ready(); app.expand(); } catch {}
    try { if(app.setHeaderColor) app.setHeaderColor('#0a0718'); } catch {}
    try { if(app.setBackgroundColor) app.setBackgroundColor('#0a0718'); } catch {}
    return String(app.initData);
  }
  function publicConfigRequest() {
    return request('/api/public/config',{signal:AbortSignal.timeout(5000)}).catch(()=>null);
  }
  async function bootstrap(localState, hasLocalSave) {
    if(bridge.bootstrapDone) return {mode:bridge.mode,state:null,config:bridge.publicConfig};
    bridge.bootstrapDone=true;
    const app=tg();
    if(app){ try { app.ready(); app.expand(); } catch {} }
    const config=await publicConfigRequest();
    if(config){ bridge.publicConfig=config; applyPublicConfig(config); }
    const initData=normalizeInitData();
    if(!initData){
      bridge.mode='standalone';
      setStatus(app?'Telegram identity unavailable — playing locally. Open from the bot to sync.':'Local mode — Telegram cloud saves are available inside the bot.','info');
      renderAccount();
      return {mode:'standalone',state:null,config};
    }
    try {
      const auth=await request('/api/auth/telegram',{method:'POST',body:{initData},signal:AbortSignal.timeout(9000)});
      bridge.profile=auth.profile||null;
      bridge.version=Number(auth.game&&auth.game.version)||0;
      let state=auth.game&&auth.game.hasProgress?auth.game.state:null;
      if(!state){
        const latestLocal=gameSnapshot()||localState;
        const init=await request('/api/game/migrate',{method:'POST',body:{state:latestLocal},signal:AbortSignal.timeout(9000)});
        state=init.state||null;
        bridge.version=Number(init.version)||bridge.version;
      }
      if(!state){
        const current=await request('/api/game',{signal:AbortSignal.timeout(9000)});
        state=current.state||null;
        bridge.version=Number(current.version)||bridge.version;
      }
      if(!state||!bridge.version) throw apiError('game_progress_unavailable','Cloud game progress could not be initialized.');
      if(config) bridge.publicConfig=config;
      bridge.mode='cloud';
      bridge.lastError='';
      setStatus('Telegram verified · cloud save connected.','good');
      await refreshAccount().catch(()=>{});
      loadMonetag(config);
      renderAccount();
      if(hasLocalSave&&state) {
        try {
          const latestLocal=gameSnapshot()||localState;
          localStorage.setItem(SAVE_KEY+'.pre-cloud-backup',JSON.stringify({savedAt:Date.now(),state:latestLocal}));
        } catch {}
      }
      return {mode:'cloud',state,profile:bridge.profile,config};
    } catch(error) {
      bridge.mode='unverified';
      bridge.lastError=error.code||'auth_failed';
      const message=error.code==='telegram_init_data_expired'||error.code==='telegram_signature_invalid'||error.code==='telegram_user_missing'
        ? 'Telegram could not verify this launch. Cloud and financial services are disabled.'
        : error.code==='backend_not_configured'||error.code==='session_secret_not_configured'||error.code==='telegram_bot_token_not_configured'
          ? 'Telegram cloud services are not configured yet. Local play is still available.'
          : error.code==='network_unavailable'
            ? 'Network unavailable — playing from the recoverable local save.'
            : 'Cloud sign-in failed safely. Local progress has been kept.';
      setStatus(message,'bad');
      renderAccount();
      return {mode:'unverified',state:null,error:error.code,config};
    }
  }

  function applyPublicConfig(config) {
    if(!config) return;
    if(window.MagIA&&typeof window.MagIA.applyOperationalConfig==='function') {
      try { window.MagIA.applyOperationalConfig(config); } catch { setStatus('Operational settings could not be applied.','bad'); }
    }
    const banner=document.getElementById('maintenance-banner');
    if(banner) {
      const active=config.maintenanceMode===true;
      banner.hidden=!active&&!config.announcement;
      banner.textContent=active?'Mag IA is in maintenance. Progress will remain saved.':String(config.announcement||'');
      banner.dataset.kind=active?'bad':'info';
      const app=document.getElementById('app');
      if(app&&active){ app.setAttribute('inert',''); app.setAttribute('aria-hidden','true'); }
      else if(app){ app.removeAttribute('inert'); app.setAttribute('aria-hidden','false'); }
    }
  }

  function gameSnapshot() {
    try { return window.MagIA&&window.MagIA.snapshot; } catch { return null; }
  }
  function queueSave(state) {
    if(bridge.mode!=='cloud'||!bridge.readyForSync||!state) return;
    bridge.queuedState=state;
    if(bridge.syncTimer) clearTimeout(bridge.syncTimer);
    bridge.syncTimer=setTimeout(()=>{bridge.syncTimer=null;flush().catch(()=>{});},1800);
  }
  async function syncPayload(snapshot) {
    if(bridge.mode!=='cloud'||!bridge.readyForSync||!bridge.version||!snapshot) return false;
    if(bridge.syncInFlight) {
      bridge.queuedState=snapshot;
      await bridge.syncInFlight;
      if(bridge.queuedState) return syncPayload(bridge.queuedState);
      return true;
    }
    const payload=snapshot;
    bridge.syncInFlight=(async()=>{
      try {
        const result=await request('/api/game/sync',{method:'POST',body:{state:payload,version:bridge.version},signal:AbortSignal.timeout(10000)});
        bridge.version=Number(result.version)||bridge.version;
        setStatus('Telegram verified · cloud save connected.','good');
        return true;
      } catch(error) {
        if(error.status===409){
          bridge.mode='conflict';
          bridge.lastError='game_sync_conflict';
          try { localStorage.setItem(SAVE_KEY+'.conflict',JSON.stringify(payload)); } catch {}
          setStatus('Cloud save conflict — your local copy is preserved; reopen to reconcile.','bad');
        } else if(error.status===422){
          bridge.mode='review';
          bridge.lastError=error.code;
          setStatus('Cloud sync paused by server-side game validation. Local progress is preserved.','bad');
        } else {
          bridge.lastError=error.code||'sync_failed';
          setStatus('Cloud sync unavailable — local progress is still saved on this device.','info');
        }
        return false;
      } finally { bridge.syncInFlight=null; }
    })();
    const ok=await bridge.syncInFlight;
    if(bridge.queuedState&&bridge.mode==='cloud') {
      const queued=bridge.queuedState;
      bridge.queuedState=null;
      return syncPayload(queued);
    }
    return ok;
  }
  async function flush() {
    if(bridge.syncTimer){clearTimeout(bridge.syncTimer);bridge.syncTimer=null;}
    if(bridge.mode!=='cloud'||!bridge.readyForSync) return false;
    const state=bridge.queuedState||gameSnapshot();
    if(!state) return false;
    bridge.queuedState=null;
    return syncPayload(state);
  }
  async function refreshAccount() {
    if(bridge.mode!=='cloud') return null;
    const [me,finance,referrals]=await Promise.all([
      request('/api/me',{signal:AbortSignal.timeout(8000)}),
      request('/api/account/finance',{signal:AbortSignal.timeout(8000)}),
      request('/api/account/referrals',{signal:AbortSignal.timeout(8000)})
    ]);
    bridge.profile=me.profile||bridge.profile;
    bridge.finance=finance;
    bridge.referrals=referrals;
    renderAccount();
    return me;
  }
  function addText(parent,tag,text,className) {
    const el=document.createElement(tag);
    if(className) el.className=className;
    el.textContent=text==null?'':String(text);
    parent.appendChild(el);
    return el;
  }
  function makeButton(parent,label,act,className='btn sm ghost') {
    const b=addText(parent,'button',label,className);
    b.type='button';
    b.dataset.cloudAct=act;
    return b;
  }
  function toMinorUnits(value, exponent) {
    const raw=String(value||'').trim();
    if(!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,4})?$/.test(raw)) return null;
    const [whole,fraction='']=raw.split('.');
    if(fraction.length>exponent) return null;
    const multiplier=10n**BigInt(exponent);
    const padded=(fraction+'0'.repeat(exponent)).slice(0,exponent);
    const minor=BigInt(whole)*multiplier+BigInt(padded||'0');
    return minor<=BigInt(Number.MAX_SAFE_INTEGER)?Number(minor):null;
  }
  function formatMinor(amount, exponent, currency) {
    const n=Number(amount||0);
    if(!Number.isSafeInteger(n)) return 'Unavailable';
    const scale=10**exponent;
    const value=(n/scale).toFixed(exponent);
    return `${currency?currency+' ':''}${value}`;
  }
  function clearChildren(el) { while(el&&el.firstChild) el.removeChild(el.firstChild); }
  function readLocalRecovery() {
    for(const key of [SAVE_KEY+'.conflict',SAVE_KEY+'.pre-cloud-backup']) {
      try {
        const raw=localStorage.getItem(key);
        if(!raw) continue;
        const parsed=JSON.parse(raw);
        const state=parsed&&parsed.state&&typeof parsed.state==='object'?parsed.state:parsed;
        if(state&&typeof state==='object'&&!Array.isArray(state)) return {key,state,savedAt:Number(parsed&&parsed.savedAt)||0};
      } catch {}
    }
    return null;
  }
  function renderAccount() {
    const root=document.getElementById('account-panel');
    if(!root) return;
    const profile=bridge.profile;
    const mode=bridge.mode;
    const recovery=readLocalRecovery();
    const recoveryTag=document.getElementById('local-backup-tag');
    const recoveryStatus=document.getElementById('local-backup-status');
    const recoveryButton=document.querySelector('[data-cloud-act="restore-local"]');
    if(recoveryTag) recoveryTag.textContent=recovery?'available':'not created';
    if(recoveryStatus) recoveryStatus.textContent=recovery
      ? `A recovery copy is saved on this device${recovery.savedAt?` · ${new Date(recovery.savedAt).toLocaleString()}`:''}. The current cloud save will be backed up before restore.`
      : 'No cloud-migration recovery copy exists on this device. Use Settings → Export to create a portable backup.';
    if(recoveryButton) recoveryButton.disabled=!recovery||!['cloud','conflict','review'].includes(mode);
    const name=document.getElementById('acc-name');
    const username=document.getElementById('acc-username');
    const refCode=document.getElementById('acc-referral-code');
    const refLink=document.getElementById('acc-referral-link');
    const financeStatus=document.getElementById('acc-finance-status');
    if(name) name.textContent=profile?`${profile.firstName||'Telegram user'}${profile.lastName?' '+profile.lastName:''}`:'Not connected';
    if(username) username.textContent=profile?(profile.username?'@'+profile.username:`Telegram ID ${profile.telegramId}`):'Open Mag IA from the configured Telegram bot to sync progress.';
    if(refCode) refCode.textContent=bridge.referrals&&bridge.referrals.code?bridge.referrals.code:'—';
    if(refLink) refLink.textContent=bridge.referrals&&bridge.referrals.link?bridge.referrals.link:'Referral link appears after Telegram verification and bot URL configuration.';
    const depositsAvailable=!!(bridge.finance&&bridge.finance.deposits&&bridge.finance.deposits.enabled);
    const withdrawalsAvailable=!!(bridge.finance&&bridge.finance.withdrawals&&bridge.finance.withdrawals.enabled);
    if(financeStatus) {
      const enabled=depositsAvailable||withdrawalsAvailable;
      financeStatus.textContent=enabled?'Provider workflows are enabled for manual external review. Requests remain pending until separately verified; submission is not payment confirmation.':'Unavailable — no payment/payout provider is configured and enabled.';
    }
    const depositTag=document.getElementById('deposit-status-tag');
    const withdrawalTag=document.getElementById('withdrawal-status-tag');
    if(depositTag) depositTag.textContent=depositsAvailable?'manual review':'unavailable';
    if(withdrawalTag) withdrawalTag.textContent=withdrawalsAvailable?'manual review':'unavailable';
    const balance=document.getElementById('acc-real-balance');
    if(balance){
      if(bridge.finance&&bridge.finance.currency) balance.textContent=`Available: ${formatMinor(bridge.finance.availableMinor,bridge.finance.currencyExponent,bridge.finance.currency)} · Reserved: ${formatMinor(bridge.finance.reservedMinor,bridge.finance.currencyExponent,bridge.finance.currency)}`;
      else balance.textContent='Not configured';
    }
    const claimArea=document.getElementById('acc-referrals');
    if(claimArea){
      clearChildren(claimArea);
      const counts=bridge.referrals&&bridge.referrals.counts||{};
      if(!profile) addText(claimArea,'p','Referral stats are available after Telegram verification.','hint');
      else {
        addText(claimArea,'p',`Invited: ${bridge.referrals&&bridge.referrals.total||0} · Pending: ${counts.pending||0} · Eligible: ${counts.eligible||0} · Rewarded: ${counts.rewarded||0}`,'small muted');
        const rows=bridge.referrals&&bridge.referrals.history||[];
        if(!rows.length) addText(claimArea,'p','No referrals yet. Share your code; rewards are granted only when an eligible rule is configured.','hint');
        rows.forEach(row=>{
          const item=document.createElement('div'); item.className='tile';
          const detail=document.createElement('div'); detail.className='tile-main';
          addText(detail,'div',`Telegram user ${String(row.refereeUid).slice(-4)}`,'tile-title');
          addText(detail,'div',`${row.status}${row.rewardMagicCoins?` · ${Number(row.rewardMagicCoins).toLocaleString()} Magic Coins`:''}`,'tile-sub');
          item.appendChild(detail);
          if(row.status==='eligible') {
            const button=makeButton(item,'Claim Magic Coins','claim-referral','btn sm green');
            button.dataset.referralId=row.id;
          }
          claimArea.appendChild(item);
        });
      }
    }
    const financePanel=document.getElementById('acc-finance-history');
    if(financePanel){
      clearChildren(financePanel);
      if(!bridge.finance) addText(financePanel,'p','No transaction records.','hint');
      else {
        const history=[...(bridge.finance.deposits.history||[]),...(bridge.finance.withdrawals.history||[])].sort((a,b)=>(b.createdAtMs||0)-(a.createdAtMs||0)).slice(0,10);
        if(!history.length) addText(financePanel,'p','No deposits or withdrawals have been submitted.','hint');
        history.forEach(row=>{
          const item=document.createElement('div'); item.className='tile';
          const detail=document.createElement('div'); detail.className='tile-main';
          const type=row.amountMinor!=null?(row.payoutDetails?'Withdrawal':'Deposit'):'Transaction';
          addText(detail,'div',`${type} · ${formatMinor(row.amountMinor,(Number.isInteger(row.currencyExponent)?row.currencyExponent:bridge.finance.currencyExponent),row.currency||bridge.finance.currency||'')}`,'tile-title');
          addText(detail,'div',`${row.status||'unknown'}${row.verificationMethod==='manual_external_review'?' · manual external review':''}`,'tile-sub');
          item.appendChild(detail); financePanel.appendChild(item);
        });
      }
    }
    const payments=bridge.finance;
    const depositForm=document.getElementById('deposit-form');
    const withdrawalForm=document.getElementById('withdrawal-form');
    if(depositForm){
      const enabled=!!(payments&&payments.deposits.enabled);
      const inputs=depositForm.querySelectorAll('input,select,button');
      inputs.forEach(input=>input.disabled=!enabled);
      const instructions=document.getElementById('deposit-instructions');
      if(instructions) instructions.textContent=enabled?(payments.deposits.instructions||'Manual review is configured. Wait for status updates; a reference alone is not proof of payment.'):'Unavailable — no verified deposit provider/instructions are configured.';
      const method=depositForm.querySelector('[name="method"]');
      if(method&&payments){
        const selected=method.value; clearChildren(method);
        (payments.deposits.methods||[]).forEach(key=>{const option=document.createElement('option');option.value=key;option.textContent=key;method.appendChild(option);});
        if([...method.options].some(o=>o.value===selected)) method.value=selected;
      }
      const amount=depositForm.querySelector('[name="amount"]');
      if(amount&&payments&&payments.deposits.minimumMinor) amount.placeholder=`Minimum ${formatMinor(payments.deposits.minimumMinor,payments.currencyExponent,payments.currency)}`;
    }
    if(withdrawalForm){
      const enabled=!!(payments&&payments.withdrawals.enabled);
      withdrawalForm.querySelectorAll('input,select,button').forEach(input=>input.disabled=!enabled);
      const method=withdrawalForm.querySelector('[name="method"]');
      if(method&&payments){
        const selected=method.value; clearChildren(method);
        (payments.withdrawals.methods||[]).forEach(key=>{const option=document.createElement('option');option.value=key;option.textContent=key;method.appendChild(option);});
        if([...method.options].some(o=>o.value===selected)) method.value=selected;
      }
    }
    const adPanel=document.getElementById('acc-ad-panel');
    if(adPanel){
      const enabled=!!(bridge.publicConfig&&bridge.publicConfig.monetag&&bridge.publicConfig.monetag.formats&&bridge.publicConfig.monetag.formats.rewardedInterstitial&&mode==='cloud');
      adPanel.hidden=!enabled;
      const button=document.getElementById('btn-rewarded-ad');
      if(button) button.disabled=!enabled||bridge.adBusy||!bridge.adSession;
      const status=document.getElementById('ad-reward-status');
      if(status) status.textContent=enabled?(bridge.adSession?'Optional rewarded ad · no reward until Monetag confirms a valued impression.':'Preparing the optional rewarded placement…'):'Rewarded advertising is not configured.';
    }
  }

  function loadMonetag(config) {
    if(!config||!config.monetag||!config.monetag.enabled||!isInTelegram()) return Promise.resolve(false);
    if(bridge.adScriptPromise) return bridge.adScriptPromise;
    const ads=config.monetag;
    if(!ads.sdkUrl||!/^\d{1,20}$/.test(String(ads.mainZoneId||''))) return Promise.resolve(false);
    bridge.adScriptPromise=new Promise(resolve=>{
      const script=document.createElement('script');
      script.async=true;
      script.src=ads.sdkUrl;
      script.dataset.zone=String(ads.mainZoneId);
      script.dataset.sdk=`show_${ads.mainZoneId}`;
      script.onload=()=>{
        const fn=window[`show_${ads.mainZoneId}`];
        if(typeof fn!=='function'){ setStatus('Monetag SDK loaded without a usable zone handler. Ads remain unavailable.','bad'); resolve(false); return; }
        bridge.monetagShow=fn;
        if(ads.formats&&ads.formats.inAppInterstitial){
          try {
            Promise.resolve(fn({type:'inApp',inAppSettings:{frequency:ads.interstitialFrequency||1,capping:ads.interstitialCappingHours||1,interval:ads.interstitialIntervalSeconds||600,timeout:ads.interstitialTimeoutSeconds||180,everyPage:false}})).catch(()=>{});
          } catch {}
        }
        prepareAdSession().catch(()=>{});
        resolve(true);
      };
      script.onerror=()=>{ bridge.adScriptPromise=null; setStatus('Monetag SDK could not be loaded. No ad or reward was recorded.','bad'); resolve(false); };
      document.head.appendChild(script);
    });
    return bridge.adScriptPromise;
  }
  async function prepareAdSession() {
    const formats=bridge.publicConfig&&bridge.publicConfig.monetag&&bridge.publicConfig.monetag.formats;
    if(bridge.mode!=='cloud'||!formats||!formats.rewardedInterstitial||!bridge.monetagShow||bridge.adBusy) return false;
    try {
      const synced=await flush();
      if(!synced) return false;
      const session=await request('/api/ads/reward-session',{method:'POST',body:{}});
      bridge.adSession=session;
      renderAccount();
      return true;
    } catch(error) {
      bridge.adSession=null;
      renderAccount();
      return false;
    }
  }
  async function pollAdStatus(ymid) {
    const deadline=Date.now()+25000;
    while(Date.now()<deadline){
      try {
        const status=await request(`/api/ads/${encodeURIComponent(ymid)}/status`,{signal:AbortSignal.timeout(7000)});
        if(status.status==='ready') return status;
        if(['unvalued','expired','claimed'].includes(status.status)) return status;
      } catch {}
      await new Promise(resolve=>setTimeout(resolve,1800));
    }
    return null;
  }
  async function startRewardedAd() {
    if(bridge.adBusy||!bridge.adSession||typeof bridge.monetagShow!=='function') return;
    const session=bridge.adSession;
    bridge.adBusy=true;
    renderAccount();
    const runtime=window.MagIA&&window.MagIA.runtime?window.MagIA.runtime():null;
    if(runtime&&runtime.Loop) runtime.Loop.stop();
    let shown;
    try {
      // This is an optional, user-initiated rewarded interstitial. A frontend callback never grants value.
      shown=bridge.monetagShow({type:'end',ymid:session.ymid,requestVar:session.requestVar});
    } catch {
      shown=Promise.reject(new Error('ad_unavailable'));
    }
    try {
      await Promise.resolve(shown);
      const confirmed=await pollAdStatus(session.ymid);
      if(confirmed&&confirmed.status==='ready'){
        const grant=await request(`/api/ads/${encodeURIComponent(session.ymid)}/claim`,{method:'POST',body:{}});
        if(window.MagIA&&window.MagIA.load&&grant.state){
          window.MagIA.load(grant.state);
          bridge.version=Number(grant.version)||bridge.version;
          bridge.queuedState=null;
          bridge.mode='cloud';
        }
        setStatus(`${Number(grant.amountMagicCoins).toLocaleString()} Magic Coins credited after verified Monetag postback.`,'good');
      } else {
        setStatus(confirmed&&confirmed.status==='unvalued'?'Monetag did not report a valued impression. No reward was granted.':'No confirmed Monetag reward arrived. No Magic Coins were granted.','info');
      }
    } catch {
      setStatus('The ad was unavailable or could not be verified. No reward was granted.','info');
    } finally {
      bridge.adBusy=false;
      bridge.adSession=null;
      if(runtime&&runtime.Loop) runtime.Loop.start();
      await refreshAccount().catch(()=>{});
      renderAccount();
      if(bridge.mode==='cloud') prepareAdSession().catch(()=>{});
    }
  }

  async function restoreLocalBackup() {
    const recovery=readLocalRecovery();
    if(!recovery){setStatus('No local recovery copy was found.','info');renderAccount();return;}
    if(bridge.mode!=='cloud'&&bridge.mode!=='conflict'&&bridge.mode!=='review'){
      setStatus('Verify this Telegram account before restoring cloud progress.','bad');return;
    }
    const proceed=window.confirm('Restore this device recovery copy to your cloud game save? The current cloud save will first be preserved in a server backup. This does not affect payments or real-money balances.');
    if(!proceed) return;
    const runtime=window.MagIA&&window.MagIA.runtime?window.MagIA.runtime():null;
    const candidate=runtime&&runtime.Save&&runtime.Save.normalize?runtime.Save.normalize(recovery.state):null;
    if(!candidate){setStatus('The local recovery copy is not a valid Mag IA save.','bad');return;}
    try {
      const current=await request('/api/game',{signal:AbortSignal.timeout(8000)});
      if(!current||!current.state||!Number(current.version)) throw apiError('game_progress_missing','Cloud progress is not available.');
      const result=await request('/api/game/recover',{method:'POST',body:{state:candidate,version:Number(current.version)},signal:AbortSignal.timeout(12000)});
      bridge.mode='cloud';
      bridge.readyForSync=true;
      bridge.version=Number(result.version)||Number(current.version)+1;
      bridge.queuedState=null;
      if(result.state&&window.MagIA&&window.MagIA.load) window.MagIA.load(result.state);
      if(window.MagIA&&window.MagIA.save) window.MagIA.save();
      await flush();
      if(recovery.key===SAVE_KEY+'.conflict') { try { localStorage.removeItem(SAVE_KEY+'.conflict'); } catch {} }
      setStatus('Recovery restored. The previous cloud save is preserved on the server; the local copy remains on this device.','good');
      await refreshAccount().catch(()=>{});
    } catch(error) {
      if(error.status===409) bridge.mode='conflict';
      setStatus(error.status===422?'Recovery paused by server-side game validation; the cloud save was not changed.':error.message||'Recovery failed; neither balance nor cloud save was changed.','bad');
    } finally { renderAccount(); }
  }

  async function copyReferral() {
    const text=bridge.referrals&&(bridge.referrals.link||bridge.referrals.code);
    if(!text){setStatus('Referral link is not available until Telegram identity and bot settings are configured.','info');return;}
    try { await navigator.clipboard.writeText(text); setStatus('Referral link copied.','good'); }
    catch {
      const area=document.createElement('textarea'); area.value=text; area.setAttribute('readonly',''); area.style.position='fixed'; area.style.opacity='0'; document.body.appendChild(area); area.select();
      const copied=document.execCommand('copy'); area.remove();
      setStatus(copied?'Referral link copied.':'Copy the referral code manually.','info');
    }
  }
  async function claimReferral(button) {
    const id=button.dataset.referralId;
    if(!id||bridge.mode!=='cloud'||!bridge.readyForSync) return;
    const flushed=await flush();
    if(!flushed){setStatus('Sync the current cloud save before claiming this reward. Your progress is unchanged.','bad');return;}
    try {
      const result=await request(`/api/referrals/${encodeURIComponent(id)}/claim`,{method:'POST',body:{}});
      if(window.MagIA&&window.MagIA.load&&result.state) window.MagIA.load(result.state);
      bridge.version=Number(result.version)||bridge.version;
      setStatus(`${Number(result.amountMagicCoins).toLocaleString()} Magic Coins claimed.`, 'good');
      await refreshAccount();
    } catch(error) { setStatus(error.message||'Referral reward could not be claimed.','bad'); }
  }
  async function submitDeposit(form) {
    if(bridge.mode!=='cloud'||!bridge.finance||!bridge.finance.deposits.enabled) return;
    const data=new FormData(form);
    const amount=toMinorUnits(data.get('amount'),bridge.finance.currencyExponent);
    if(!amount){setStatus('Enter a valid deposit amount.','bad');return;}
    const key=cryptoRandomId();
    try {
      const result=await request('/api/deposits',{method:'POST',headers:{'Idempotency-Key':key},body:{amountMinor:amount,method:data.get('method'),transactionReference:data.get('transactionReference')}});
      setStatus(result.status==='pending'?'Deposit request submitted for manual external review. It is not yet credited.':'Deposit request recorded.', 'good');
      form.reset(); await refreshAccount();
    } catch(error) { setStatus(error.message||'Deposit request failed. No balance was changed.','bad'); }
  }
  async function submitWithdrawal(form) {
    if(bridge.mode!=='cloud'||!bridge.finance||!bridge.finance.withdrawals.enabled) return;
    const data=new FormData(form);
    const amount=toMinorUnits(data.get('amount'),bridge.finance.currencyExponent);
    if(!amount){setStatus('Enter a valid withdrawal amount.','bad');return;}
    const key=cryptoRandomId();
    try {
      const result=await request('/api/withdrawals',{method:'POST',headers:{'Idempotency-Key':key},body:{amountMinor:amount,payoutDetails:{method:data.get('method'),destination:data.get('destination'),accountName:data.get('accountName')}}});
      setStatus(result.status==='pending'?'Withdrawal request reserved and awaiting external review. No payout has been marked complete.':'Withdrawal request recorded.', 'good');
      form.reset(); await refreshAccount();
    } catch(error) { setStatus(error.message||'Withdrawal request failed. No payout was sent.','bad'); }
  }
  function cryptoRandomId() {
    if(window.crypto&&window.crypto.randomUUID) return window.crypto.randomUUID();
    const bytes=new Uint8Array(24); window.crypto.getRandomValues(bytes); return [...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');
  }

  document.addEventListener('click',event=>{
    const button=event.target&&event.target.closest?event.target.closest('[data-cloud-act]'):null;
    if(!button) return;
    event.preventDefault();
    const act=button.dataset.cloudAct;
    if(act==='copy-referral') copyReferral().catch(()=>{});
    else if(act==='claim-referral') claimReferral(button).catch(()=>{});
    else if(act==='rewarded-ad') startRewardedAd().catch(()=>{});
    else if(act==='refresh-account') refreshAccount().then(()=>setStatus('Account refreshed.','good')).catch(()=>setStatus('Could not refresh account data.','bad'));
    else if(act==='restore-local') restoreLocalBackup().catch(()=>setStatus('Recovery failed safely.','bad'));
  });
  document.addEventListener('submit',event=>{
    const form=event.target;
    if(form&&form.id==='deposit-form'){event.preventDefault();submitDeposit(form).catch(()=>{});}
    if(form&&form.id==='withdrawal-form'){event.preventDefault();submitWithdrawal(form).catch(()=>{});}
  });
  window.addEventListener('online',()=>{if(bridge.mode==='cloud')flush().catch(()=>{});});
  window.addEventListener('pagehide',()=>{if(bridge.syncTimer){clearTimeout(bridge.syncTimer);bridge.syncTimer=null;}if(bridge.mode==='cloud')flush().catch(()=>{});});

  window.MagIACloud={
    bootstrap,
    activate(){
      bridge.readyForSync=true;
      if(bridge.mode==='cloud'){
        queueSave(gameSnapshot());
        if(bridge.monetagShow) prepareAdSession().catch(()=>{});
      }
    },
    queueSave,
    flush,
    refreshAccount,
    renderAccount,
    loadMonetag,
    get mode(){return bridge.mode;},
    get profile(){return bridge.profile;},
    get version(){return bridge.version;},
    set mode(value){bridge.mode=value;},
    set version(value){bridge.version=Number(value)||0;},
    updateFromServer(state,version){
      if(state&&window.MagIA&&window.MagIA.load) window.MagIA.load(state);
      bridge.version=Number(version)||bridge.version;
      bridge.mode='cloud';
      bridge.readyForSync=true;
      bridge.queuedState=null;
      setStatus('Telegram verified · cloud save connected.','good');
    },
    setStatus
  };
})();
