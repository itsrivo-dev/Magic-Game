'use strict';

(() => {
  const state={authorized:false,uid:'',profile:null,mfaRequired:true,mfaConfigured:false,mfaVerified:false,settings:null,activeTab:'overview'};
  const $=(selector,root=document)=>root.querySelector(selector);
  const $$=(selector,root=document)=>Array.from(root.querySelectorAll(selector));
  function text(node,value){if(node)node.textContent=value==null?'':String(value);}
  function status(message,kind='info'){
    const box=$('#global-status');if(!box)return;
    box.hidden=false;box.textContent=String(message||'');box.dataset.kind=kind;
    clearTimeout(status.timer);status.timer=setTimeout(()=>{box.hidden=true;},4800);
  }
  function errMessage(code){
    const map={
      backend_not_configured:'Trusted Firebase storage is not configured on the server.',
      telegram_session_required:'Open this console inside Telegram and verify the administrator account.',
      telegram_session_invalid:'The Telegram session expired. Reopen the console from the bot.',
      admin_access_denied:'This Telegram account is not authorized for administrator access.',
      admin_identity_not_configured:'The administrator Telegram identity is not configured on the server.',
      admin_totp_not_configured:'Finance remains locked until an administrator authenticator secret is configured.',
      admin_mfa_required:'Verify the administrator authenticator code before accessing financial records.',
      admin_mfa_code_invalid:'That authenticator code was not accepted.',
      payment_provider_not_configured:'No verified payment adapter is implemented; real-money workflows remain disabled.',
      deposit_provider_not_configured:'No verified deposit adapter is available; deposits remain disabled.',
      payout_provider_not_configured:'No verified payout adapter is available; withdrawals remain disabled.',
      monetag_integration_not_verified:'Monetag remains disabled until its supported integration is implemented and verified.',
      monetag_postback_secret_not_configured:'A private Monetag postback secret is not configured.',
      monetag_sdk_or_zone_not_configured:'A valid Monetag SDK URL and zone are required before enabling ads.',
      verified_revenue_source_not_configured:'Cash reward budgets stay at zero until settled revenue can be verified.',
      magic_coin_reward_limits_not_configured:'Magic Coin reward claims are paused until all server-side caps are configured.',
      magic_coin_user_daily_limit_reached:'The per-user daily Magic Coin reward cap has been reached.',
      magic_coin_daily_budget_exhausted:'The global daily Magic Coin reward budget has been exhausted.',
      magic_coin_monthly_budget_exhausted:'The global monthly Magic Coin reward budget has been exhausted.',
      maintenance_mode:'The service is in maintenance mode; this operation is paused.',
      pending_withdrawal_liability_limit_reached:'The global pending-withdrawal liability cap has been reached.',
      pending_withdrawal_user_limit_reached:'The per-user pending-withdrawal cap has been reached.',
      deposit_daily_amount_limit_reached:'The per-user daily deposit amount cap has been reached.',
      withdrawal_daily_amount_limit_reached:'The per-user daily withdrawal amount cap has been reached.',
      financial_ledger_discrepancy:'A ledger discrepancy was detected; the financial operation was blocked and logged.',
      financial_ledger_corrupt:'Financial records need review; the operation was blocked and logged.',
      pending_deposit_counter_discrepancy:'Pending deposit counters need reconciliation; the operation was blocked and logged.',
      pending_withdrawal_counter_discrepancy:'Pending withdrawal counters need reconciliation; the operation was blocked and logged.',
      rate_limited:'Too many requests. Wait a moment and try again.'
    };
    return map[code]||String(code||'The request could not be completed.');
  }
  async function api(path,options={}){
    const headers={'Accept':'application/json','X-MagIA-Request':'1',...(options.headers||{})};
    const init={method:options.method||'GET',credentials:'same-origin',headers,signal:options.signal||AbortSignal.timeout(12000)};
    if(options.body!==undefined){headers['Content-Type']='application/json';init.body=JSON.stringify(options.body);}
    let response;
    try{response=await fetch(path,init);}catch{throw Object.assign(new Error('network_unavailable'),{code:'network_unavailable'});}
    let result={};const body=await response.text();if(body){try{result=JSON.parse(body);}catch{result={};}}
    if(!response.ok){
      const error=Object.assign(new Error(result.message||errMessage(result.error)),{status:response.status,code:result.error||'request_failed',data:result});
      if(error.code==='admin_mfa_required'||error.code==='admin_totp_not_configured'){state.mfaVerified=false;if(state.authorized)showShell();}
      throw error;
    }
    return result;
  }
  function setConnection(label,kind='info'){const badge=$('#connection-badge');if(badge){text(badge,label);badge.className='badge '+(kind==='good'?'good':kind==='bad'?'bad':'');}}
  function toggleGate(message,kind='info'){
    $('#admin-gate').hidden=false;$('#admin-shell').hidden=true;
    text($('#gate-message'),message);setConnection(kind==='bad'?'Access unavailable':'Telegram identity required',kind);
  }
  function number(n){const v=Number(n);return Number.isFinite(v)?v.toLocaleString('en-US'):'—';}
  function dateTime(ms){const n=Number(ms);return Number.isFinite(n)&&n>0?new Date(n).toLocaleString():'—';}
  function formatMinor(amount,currency,exponent=2){
    const n=Number(amount);const e=Math.max(0,Math.min(4,Number(exponent)||0));
    if(!Number.isSafeInteger(n))return '—';
    const value=(n/10**e).toFixed(e);
    if(currency){try{return new Intl.NumberFormat(undefined,{style:'currency',currency,minimumFractionDigits:e,maximumFractionDigits:e}).format(n/10**e);}catch{}}
    return `${currency?currency+' ':''}${value}`;
  }
  function node(tag,className,content){const el=document.createElement(tag);if(className)el.className=className;if(content!==undefined)el.textContent=String(content);return el;}
  function button(label,action,className='btn') {const b=node('button',className,label);b.type='button';b.dataset.adminAction=action;return b;}
  function showShell(){
    $('#admin-gate').hidden=true;$('#admin-shell').hidden=false;
    const mfaCard=$('#mfa-card'),warning=$('#mfa-warning');
    if(state.mfaRequired&&!state.mfaConfigured){mfaCard.hidden=true;warning.hidden=false;text(warning,'Finance records and actions are locked because ADMIN_TOTP_SECRET is not configured. Configure a private authenticator secret on the server before financial operations.');}
    else if(state.mfaRequired&&!state.mfaVerified){mfaCard.hidden=false;warning.hidden=false;text(warning,'Authenticator verification is required before viewing payout details, transaction records or performing finance actions.');}
    else{mfaCard.hidden=true;warning.hidden=true;}
    const profile=$('#admin-profile');text(profile,state.profile?`${state.profile.firstName||'Administrator'}${state.profile.username?' · @'+state.profile.username:''}`:'');
    const badge=$('#security-badge');text(badge,state.mfaVerified?'Administrator · MFA verified':'Administrator · finance locked');badge.className='badge '+(state.mfaVerified?'good':'gold');
  }
  async function login(){
    const tg=window.Telegram&&window.Telegram.WebApp;
    if(!tg||typeof tg.initData!=='string'||!tg.initData){toggleGate('No verified Telegram Mini App launch data was found. Open this page from the configured Mag IA bot while signed into the administrator Telegram account. No password or email login is accepted.','bad');return;}
    try{try{tg.ready();tg.expand();}catch{}setConnection('Verifying Telegram…');
      const auth=await api('/api/auth/telegram',{method:'POST',body:{initData:String(tg.initData)}});
      state.profile=auth.profile||null;state.uid=String(auth.profile&&auth.profile.telegramId||'');
      const me=await api('/api/admin/me');
      if(!me.authorized)throw Object.assign(new Error('admin_access_denied'),{code:'admin_access_denied'});
      state.profile=me.profile||state.profile;state.mfaRequired=me.mfaRequired!==false;state.mfaConfigured=me.mfaConfigured===true;state.mfaVerified=me.mfaVerified===true;state.authorized=true;
      showShell();setConnection('Telegram verified · admin API connected','good');
      await loadOverview();
    }catch(error){
      state.authorized=false;const message=errMessage(error.code||error.message);
      toggleGate(message,'bad');status(message,'bad');
    }
  }
  function canViewFinance(){return !state.mfaRequired||(state.mfaConfigured&&state.mfaVerified);}
  async function requireFinance(){if(canViewFinance())return true;status(state.mfaConfigured?'Verify the administrator authenticator code first.':'Finance is locked: ADMIN_TOTP_SECRET is not configured.','bad');return false;}
  function activateTab(tab){
    if(!state.authorized)return;state.activeTab=tab;
    $$('.nav-btn').forEach(b=>b.classList.toggle('active',b.dataset.adminTab===tab));
    $$('.view').forEach(v=>v.classList.toggle('active',v.dataset.adminView===tab));
    if(tab==='overview')loadOverview().catch(()=>{});
    if(tab==='deposits')loadDeposits().catch(()=>{});
    if(tab==='withdrawals')loadWithdrawals().catch(()=>{});
    if(tab==='referrals')loadReferrals().catch(()=>{});
    if(tab==='transactions')loadTransactions().catch(()=>{});
    if(tab==='settings')loadSettings().catch(()=>{});
    if(tab==='logs')loadLogs().catch(()=>{});
  }
  function addStat(name,value){text($(`[data-stat="${name}"]`),value);}
  async function loadOverview(){
    const result=await api('/api/admin/summary');const finance=result.finance||{};const users=result.users||{};
    addStat('totalUsers',number(users.total));addStat('newUsers',number(users.new24h));addStat('activeUsers',number(users.active24h));
    const financeLocked=finance.locked===true;
    if(financeLocked&&state.mfaVerified){state.mfaVerified=false;showShell();}
    addStat('pendingRequests',financeLocked?'MFA required':number((finance.pendingDeposits||0)+(finance.pendingWithdrawals||0)));
    const currency=finance.currency||null;const exp=Number.isInteger(finance.currencyExponent)?finance.currencyExponent:2;
    addStat('currency',financeLocked?'Finance locked':currency||'currency not configured');
    addStat('verifiedDeposits',financeLocked?'MFA required':currency?formatMinor(finance.verifiedDepositsMinor,currency,exp):'Not configured');
    addStat('verifiedWithdrawals',financeLocked?'MFA required':currency?formatMinor(finance.verifiedWithdrawalsMinor,currency,exp):'Not configured');
    addStat('availableLiabilities',financeLocked?'MFA required':currency?formatMinor(finance.availableLiabilitiesMinor,currency,exp):'Not configured');
    addStat('reservedLiabilities',financeLocked?'MFA required':currency?formatMinor(finance.reservedLiabilitiesMinor,currency,exp):'Not configured');
    const warnings=$('#overview-warnings');warnings.replaceChildren();
    for(const warning of result.warnings||[]){const p=node('div','notice blue',warning);warnings.appendChild(p);}
    const recent=$('#recent-actions');recent.replaceChildren();
    for(const row of result.recentActions||[]){const item=node('div','record');const main=node('div','record-main');main.append(node('div','record-title',row.action||'Action'));main.append(node('div','record-meta',`${dateTime(row.createdAtMs)} · admin ${String(row.actorUid||'').slice(-4)}${row.targetUid?' · target '+String(row.targetUid).slice(-4):''}`));item.append(main);recent.append(item);}
    if(!recent.childElementCount)recent.append(node('div','muted small','No administrative actions recorded.'));
  }
  function setListMessage(container,message){if(container){container.replaceChildren(node('div','muted small',message));}}
  async function searchUsers(query){
    const container=$('#user-results');setListMessage(container,'Searching…');
    try{const result=await api('/api/admin/users?q='+encodeURIComponent(query));container.replaceChildren();
      for(const user of result.users||[]){const row=node('div','record');const main=node('div','record-main');const title=node('div','record-title',`${user.firstName||'Telegram user'}${user.lastName?' '+user.lastName:''}`);const meta=node('div','record-meta',`${user.username?'@'+user.username+' · ':''}ID ${user.telegramId} · ${user.status||'active'}`);main.append(title,meta);const pick=button('Details','load-user','btn');pick.dataset.uid=String(user.telegramId);row.append(main,pick);container.append(row);}
      if(!container.childElementCount)container.append(node('div','muted small','No users found.'));
    }catch(error){setListMessage(container,errMessage(error.code));status(errMessage(error.code),'bad');}
  }
  async function loadUser(uid){
    const container=$('#user-detail');container.replaceChildren(node('div','muted small','Loading selected account…'));
    try{
      const result=await api('/api/admin/users/'+encodeURIComponent(uid));container.replaceChildren();
      const p=result.profile||{},g=result.gameProgress||{},balance=result.balance||{};
      const title=node('h3','record-title',`${p.firstName||'Telegram user'}${p.lastName?' '+p.lastName:''}`);container.append(title);
      const meta=node('p','record-meta',`Telegram ID ${p.telegramId||uid}${p.username?' · @'+p.username:''} · ${p.status||'active'} · created ${dateTime(p.createdAtMs)}`);container.append(meta);
      const game=node('div','notice blue',g?`Mage level ${number(g.level)} · Tower ${number(g.tower)} · Stage ${number(g.stage)} (best ${number(g.bestStage)}) · ${number(g.mages)} mages · ${number(g.coins)} Magic Coins · save v${number(g.version)}`:'No game save found.');container.append(game);
      if(balance.currency){container.append(node('p','record-meta',`Separate real-money ledger · available ${formatMinor(balance.availableMinor,balance.currency,Number.isInteger(balance.currencyExponent)?balance.currencyExponent:2)} · reserved ${formatMinor(balance.reservedMinor,balance.currency,Number.isInteger(balance.currencyExponent)?balance.currencyExponent:2)}`));}
      const controls=node('div','record-actions');for(const [label,status,className] of [['Activate','active','btn green'],['Suspend','suspended','btn'],['Ban','banned','btn red']]){const b=button(label,'user-status',className);b.dataset.uid=String(uid);b.dataset.status=status;controls.append(b);}container.append(controls);
      const noteForm=node('form','stack');noteForm.dataset.adminForm='user-note';noteForm.dataset.uid=String(uid);const field=node('div','field');const label=node('label','', 'Internal support note');const input=node('textarea');input.name='note';input.maxLength=1000;input.required=true;input.placeholder='Keep notes factual; do not enter passwords or payment credentials.';field.append(label,input);const save=node('button','btn','Add note');save.type='submit';noteForm.append(field,save);container.append(noteForm);
      const notes=node('div','list');for(const n of result.notes||[]){const item=node('div','record');const main=node('div','record-main');main.append(node('div','record-title',n.text||''),node('div','record-meta',`${dateTime(n.createdAtMs)} · admin ${String(n.actorUid||'').slice(-4)}`));item.append(main);notes.append(item);}if(notes.childElementCount){container.append(node('h4','', 'Support notes'),notes);}
      if((result.transactions||[]).length){container.append(node('h4','', 'Recent transaction history'));for(const tx of result.transactions.slice(0,10)){container.append(node('div','record-meta',`${dateTime(tx.createdAtMs)} · ${tx.type||'transaction'} · ${tx.status||''} · ${tx.amountMinor!=null?formatMinor(tx.amountMinor,tx.currency,Number.isInteger(tx.currencyExponent)?tx.currencyExponent:2):''}`));}}
    }catch(error){setListMessage(container,errMessage(error.code));status(errMessage(error.code),'bad');if(error.code==='admin_mfa_required'||error.code==='admin_totp_not_configured'){state.mfaVerified=false;showShell();}}
  }
  async function changeUserStatus(uid,newStatus){
    const note=window.prompt(`Optional audit note for ${newStatus} status (leave blank if not needed):`,'');if(note===null)return;
    if(!window.confirm(`Set Telegram account ${uid} to ${newStatus}?`))return;
    try{await api('/api/admin/users/'+encodeURIComponent(uid)+'/status',{method:'POST',body:{status:newStatus,note}});status('User status updated and audited.','good');await searchUsers($('#user-query').value.trim());await loadUser(uid);}catch(error){status(errMessage(error.code),'bad');}
  }
  async function addUserNote(form){const fd=new FormData(form);const uid=form.dataset.uid;try{await api('/api/admin/users/'+encodeURIComponent(uid)+'/notes',{method:'POST',body:{note:fd.get('note')}});status('Support note added to the audit trail.','good');await loadUser(uid);}catch(error){status(errMessage(error.code),'bad');}}
  async function loadDeposits(){
    const container=$('#deposit-list');if(!await requireFinance()){setListMessage(container,'Verify MFA to view deposit records.');return;}
    setListMessage(container,'Loading deposit requests…');
    try{const data=await api('/api/admin/deposits');container.replaceChildren();
      for(const row of data.deposits||[]){const item=node('div','record');const main=node('div','record-main');main.append(node('div','record-title',`${formatMinor(row.amountMinor,row.currency,Number.isInteger(row.currencyExponent)?row.currencyExponent:2)} · ${row.status||'unknown'}`),node('div','record-meta',`ID ${row.id} · user ${String(row.userId||'').slice(-4)} · method ${row.method||'—'} · ref ${row.userReference||'—'} · ${dateTime(row.createdAtMs)}`));if(row.evidenceReference)main.append(node('div','record-meta',`Evidence: ${row.evidenceReference}`));item.append(main);
        if(row.status==='pending'){const actions=node('div','record-actions');const approve=button('Approve with evidence','deposit-approve','btn green');approve.dataset.id=row.id;const reject=button('Reject','deposit-reject','btn red');reject.dataset.id=row.id;actions.append(approve,reject);item.append(actions);}container.append(item);}
      if(!container.childElementCount)container.append(node('div','muted small','No deposit requests.'));
    }catch(error){setListMessage(container,errMessage(error.code));status(errMessage(error.code),'bad');if(error.code==='admin_mfa_required'||error.code==='admin_totp_not_configured'){state.mfaVerified=false;showShell();}}
  }
  async function decideDeposit(id,decision){
    if(!await requireFinance())return;let body;
    if(decision==='approve'){const evidenceReference=window.prompt('Enter the independently verified external provider receipt/reference:');if(!evidenceReference)return;body={decision:'approve',evidenceReference};}
    else{const reason=window.prompt('Enter a factual reason for rejecting this request:');if(!reason||reason.trim().length<4)return;body={decision:'reject',reason};}
    if(!window.confirm(`Confirm deposit ${decision}? This action changes the separate real-money ledger.`))return;
    try{await api('/api/admin/deposits/'+encodeURIComponent(id)+'/decision',{method:'POST',body});status(`Deposit ${decision} recorded. Verify the external receipt in the provider system.`,decision==='approve'?'good':'info');await loadDeposits();await loadOverview();}
    catch(error){status(errMessage(error.code),'bad');}
  }
  async function loadWithdrawals(){
    const container=$('#withdrawal-list');if(!await requireFinance()){setListMessage(container,'Verify MFA to view payout destinations and withdrawal records.');return;}
    setListMessage(container,'Loading withdrawal requests…');
    try{const data=await api('/api/admin/withdrawals');container.replaceChildren();
      for(const row of data.withdrawals||[]){const item=node('div','record');const main=node('div','record-main');const detail=row.payoutDetails||{};main.append(node('div','record-title',`${formatMinor(row.amountMinor,row.currency,Number.isInteger(row.currencyExponent)?row.currencyExponent:2)} · ${row.status||'unknown'}`),node('div','record-meta',`ID ${row.id} · user ${String(row.userId||'').slice(-4)} · method ${detail.method||'—'} · destination ${detail.destination||'—'}${detail.accountName?' · account '+detail.accountName:''} · ${dateTime(row.createdAtMs)}`));if(row.payoutReference)main.append(node('div','record-meta',`Payout evidence: ${row.payoutReference}`));item.append(main);
        const actions=node('div','record-actions');const add=(label,action,cls='btn')=>{const b=button(label,'withdrawal-action',cls);b.dataset.id=row.id;b.dataset.action=action;actions.append(b);};
        if(row.status==='pending'){add('Approve','approve','btn green');add('Reject','reject','btn red');}
        if(row.status==='approved'){add('Mark processing','processing');add('Release / fail','fail','btn red');}
        if(row.status==='processing'){add('Mark paid · evidence required','paid','btn green');add('Fail / release','fail','btn red');}
        if(actions.childElementCount)item.append(actions);container.append(item);}
      if(!container.childElementCount)container.append(node('div','muted small','No withdrawal requests.'));
    }catch(error){setListMessage(container,errMessage(error.code));status(errMessage(error.code),'bad');if(error.code==='admin_mfa_required'||error.code==='admin_totp_not_configured'){state.mfaVerified=false;showShell();}}
  }
  async function withdrawalAction(id,action){
    if(!await requireFinance())return;let body={action};
    if(action==='paid'){body.evidenceReference=window.prompt('Enter the external payout provider settlement reference:');if(!body.evidenceReference)return;}
    if(['reject','fail'].includes(action)){body.reason=window.prompt('Enter a factual reason; reserved funds will be released to available balance:');if(!body.reason||body.reason.trim().length<4)return;}
    if(!window.confirm(`Confirm withdrawal action: ${action}?`))return;
    try{await api('/api/admin/withdrawals/'+encodeURIComponent(id)+'/action',{method:'POST',body});status(`Withdrawal ${action} recorded. Confirm provider settlement separately.`,action==='paid'?'good':'info');await loadWithdrawals();await loadOverview();}
    catch(error){status(errMessage(error.code),'bad');}
  }
  async function loadReferrals(){
    const container=$('#referral-list');setListMessage(container,'Loading referral activity…');
    try{const result=await api('/api/admin/referrals');container.replaceChildren();
      for(const row of result.referrals||[]){const item=node('div','record');const main=node('div','record-main');main.append(node('div','record-title',`${row.status||'unknown'} · referee ${String(row.refereeUid||'').slice(-4)} · referrer ${String(row.referrerUid||'').slice(-4)}`),node('div','record-meta',`created ${dateTime(row.createdAtMs)} · reward ${number(row.rewardMagicCoins)} Magic Coins${row.reviewNote?' · '+row.reviewNote:''}`));item.append(main);const actions=node('div','record-actions');const add=(label,action)=>{const b=button(label,'referral-review');b.dataset.id=row.refereeUid;b.dataset.action=action;actions.append(b);};if(row.status!=='rewarded'&&row.status!=='suspended'){add('Flag for review','review');add('Suspend','suspend');}if(row.status==='suspended')add('Restore to pending','restore');if(actions.childElementCount)item.append(actions);container.append(item);}
      if(!container.childElementCount)container.append(node('div','muted small','No referral activity.'));
    }catch(error){setListMessage(container,errMessage(error.code));status(errMessage(error.code),'bad');}
  }
  async function reviewReferral(id,action){const note=window.prompt('Add a concise audit note for this referral action:');if(note===null)return;if(!window.confirm(`Apply referral action ${action}?`))return;try{await api('/api/admin/referrals/'+encodeURIComponent(id)+'/review',{method:'POST',body:{action,note}});status('Referral review updated.','good');await loadReferrals();}catch(error){status(errMessage(error.code),'bad');}}
  async function loadTransactions(){
    const body=$('#transaction-list');if(!await requireFinance()){body.replaceChildren();const tr=node('tr');const td=node('td','muted','Finance MFA is required to view transactions.');td.colSpan=6;tr.append(td);body.append(tr);return;}
    body.replaceChildren();
    try{const result=await api('/api/admin/transactions');for(const row of result.transactions||[]){const tr=document.createElement('tr');for(const value of [dateTime(row.createdAtMs),row.type||'—',String(row.userId||'').slice(-4),row.amountMinor!=null?formatMinor(row.amountMinor,row.currency,Number.isInteger(row.currencyExponent)?row.currencyExponent:2):'—',row.status||'—',row.providerReference||row.reference||'—']){const td=node('td','',value);tr.append(td);}body.append(tr);}if(!body.childElementCount){const tr=node('tr');const td=node('td','muted','No transaction entries.');td.colSpan=6;tr.append(td);body.append(tr);}}
    catch(error){const tr=node('tr');const td=node('td','muted',errMessage(error.code));td.colSpan=6;tr.append(td);body.append(tr);status(errMessage(error.code),'bad');}
  }
  async function loadSettings(){
    try{const result=await api('/api/admin/settings');state.settings=result;fillSettings(result);renderSecretStatus(result.secretStatus||{});}
    catch(error){status(errMessage(error.code),'bad');text($('#settings-secret-status'),errMessage(error.code));}
  }
  function fillSettings(settings){
    const s=settings.system||{},g=settings.game||{},a=settings.ads||{},p=settings.payments||{},r=settings.referrals||{};
    const switches=s.emergencySwitches||{},limits=s.safetyLimits||{};
    const check=(id,val)=>{const input=$('#'+id);if(input)input.checked=val===true;};const put=(id,val)=>{const input=$('#'+id);if(input)input.value=val==null?'':String(val);};
    const disable=(id,value)=>{const input=$('#'+id);if(input)input.disabled=!!value;};
    check('sys-maintenance',s.maintenanceMode);put('sys-announcement',s.announcement||'');check('sys-real-money',s.realMoneyEnabled);disable('sys-real-money',!p.providerVerified);
    check('stop-deposits',switches.depositsPaused);check('stop-withdrawals',switches.withdrawalsPaused);check('stop-cash-rewards',switches.cashRewardsPaused);check('stop-coin-rewards',switches.magicCoinRewardsPaused);check('stop-referrals',switches.referralsPaused);check('stop-referral-rewards',switches.referralRewardsPaused);check('stop-monetization',switches.monetizationPaused);
    const limitFields={
      'limit-pending-withdrawal-global':'maxPendingWithdrawalLiabilityMinor','limit-pending-withdrawal-user':'maxPendingWithdrawalPerUserMinor',
      'limit-withdrawals-daily-count':'maxWithdrawalsPerUserDaily','limit-withdrawals-daily-amount':'maxWithdrawalPerUserDailyMinor',
      'limit-deposits-pending-count':'maxPendingDepositsPerUser','limit-deposits-daily-count':'maxDepositsPerUserDaily','limit-deposits-daily-amount':'maxDepositPerUserDailyMinor',
      'limit-coin-reward-max':'maxMagicCoinsPerReward','limit-coin-user-daily':'maxMagicCoinsPerUserDaily','limit-coin-global-daily':'dailyMagicCoinsRewardBudget','limit-coin-global-monthly':'monthlyMagicCoinsRewardBudget',
      'limit-cash-user':'maxCashRewardPerUserMinor','limit-cash-daily':'dailyCashRewardBudgetMinor','limit-cash-monthly':'monthlyCashRewardBudgetMinor','limit-cash-total':'maxTotalCashRewardLiabilityMinor'
    };
    for(const [id,key] of Object.entries(limitFields))put(id,limits[key]??0);
    put('game-quest-mult',g.questRewardMultiplier);put('game-ach-mult',g.achievementRewardMultiplier);put('game-battle-mult',g.battleRewardMultiplier);put('game-offline-cap',g.offlineCapHours);put('game-offline-eff',g.offlineEfficiency);
    put('game-mage-costs',JSON.stringify(g.mageCosts||{},null,2));put('game-mage-cps',JSON.stringify(g.mageCps||{},null,2));put('game-mage-upgrades',JSON.stringify(g.mageUpgradeBaseCosts||{},null,2));put('game-tower-costs',JSON.stringify(g.towerCosts||[]));put('game-tower-bonuses',JSON.stringify(g.towerBonuses||[]));
    check('ads-enabled',a.enabled);check('ads-interstitial',a.formats&&a.formats.inAppInterstitial);check('ads-rewarded',a.formats&&a.formats.rewardedInterstitial);put('ads-publisher',a.publisherId);put('ads-zone',a.mainZoneId);put('ads-reward-coins',a.rewardedMagicCoins);put('ads-frequency',a.interstitialFrequency);
    disable('ads-enabled',settings.secretStatus?.monetagIntegrationVerified!==true);disable('ads-interstitial',settings.secretStatus?.monetagIntegrationVerified!==true);disable('ads-rewarded',settings.secretStatus?.monetagIntegrationVerified!==true||settings.secretStatus?.monetagPostbackSecretConfigured!==true);
    check('pay-deposits',p.depositsEnabled);check('pay-withdrawals',p.withdrawalsEnabled);put('pay-currency',p.currency);put('pay-exponent',p.currencyExponent);put('pay-min-deposit',p.minimumDepositMinor);put('pay-max-deposit',p.maximumDepositMinor);put('pay-min-withdrawal',p.minimumWithdrawalMinor);put('pay-max-withdrawal',p.maximumWithdrawalMinor);
    disable('pay-deposits',p.providerVerified!==true);disable('pay-withdrawals',p.providerVerified!==true);
    check('ref-enabled',r.enabled);put('ref-level',r.qualificationLevel);put('ref-hours',r.qualificationHours);put('ref-reward',r.rewardMagicCoins);
  }
  function renderSecretStatus(secrets){
    const box=$('#settings-secret-status');box.replaceChildren();
    const checks=[
      ['Telegram Bot Token format',secrets.telegramBotTokenConfigured],['Firebase Admin credential',secrets.firebaseAdminConfigured],
      ['Session signing secret',secrets.sessionSecretConfigured],['Admin Telegram ID format',secrets.adminTelegramIdConfigured],
      ['Admin TOTP secret',secrets.adminTotpConfigured],['Monetag SDK URL',secrets.monetagSdkUrlConfigured],
      ['Monetag publisher ID',secrets.monetagPublisherConfigured],['Monetag postback secret',secrets.monetagPostbackSecretConfigured],
      ['Monetag policy review',secrets.monetagPolicyReviewed],['Monetag integration verified',secrets.monetagIntegrationVerified],
      ['Verified payment/payout adapter',secrets.paymentProviderConfigured]
    ];
    box.append(node('div','small',checks.map(([name,configured])=>`${name}: ${configured?'configured':'missing/unverified'}`).join(' · ')));
    if(secrets.configurationSource)box.append(node('div','tiny muted',`Private configuration source: ${secrets.configurationSource}${secrets.privateConfigurationLoaded?' (loaded)':' (not loaded)'}.`));
    if(secrets.sessionSecretSource)box.append(node('div','tiny muted',`Session key source: ${secrets.sessionSecretSource}.`));
    if(Array.isArray(secrets.invalidConfigValues)&&secrets.invalidConfigValues.length)box.append(node('div','tiny muted',`Invalid configuration fields: ${secrets.invalidConfigValues.join(', ')}.`));
    if(Array.isArray(secrets.configurationWarnings))for(const warning of secrets.configurationWarnings)box.append(node('div','tiny muted',warning));
    box.append(node('div','tiny muted','Only credential presence, validation status and field names are shown. Secret values are never sent to this browser. Firebase Web configuration is not Firebase Admin access; ad estimates are not settled revenue.'));
  }
  function parseJsonField(id,expected){const raw=$('#'+id).value.trim();let value;try{value=JSON.parse(raw|| (expected==='array'?'[]':'{}'));}catch{throw new Error(`${id} must be valid JSON.`);}if(expected==='array'&&!Array.isArray(value))throw new Error(`${id} must be a JSON array.`);if(expected==='object'&&(!value||typeof value!=='object'||Array.isArray(value)))throw new Error(`${id} must be a JSON object.`);return value;}
  async function saveSettings(form){
    if(!state.settings){status('Load server settings before saving.','bad');return;}
    const value=id=>$('#'+id).value;
    const amount=id=>Math.max(0,Math.trunc(Number(value(id))||0));
    try{
      const emergencySwitches={depositsPaused:$('#stop-deposits').checked,withdrawalsPaused:$('#stop-withdrawals').checked,cashRewardsPaused:$('#stop-cash-rewards').checked,magicCoinRewardsPaused:$('#stop-coin-rewards').checked,referralsPaused:$('#stop-referrals').checked,referralRewardsPaused:$('#stop-referral-rewards').checked,monetizationPaused:$('#stop-monetization').checked};
      const safetyLimits={maxPendingWithdrawalLiabilityMinor:amount('limit-pending-withdrawal-global'),maxPendingWithdrawalPerUserMinor:amount('limit-pending-withdrawal-user'),maxWithdrawalsPerUserDaily:amount('limit-withdrawals-daily-count'),maxWithdrawalPerUserDailyMinor:amount('limit-withdrawals-daily-amount'),maxPendingDepositsPerUser:amount('limit-deposits-pending-count'),maxDepositsPerUserDaily:amount('limit-deposits-daily-count'),maxDepositPerUserDailyMinor:amount('limit-deposits-daily-amount'),maxMagicCoinsPerReward:amount('limit-coin-reward-max'),maxMagicCoinsPerUserDaily:amount('limit-coin-user-daily'),dailyMagicCoinsRewardBudget:amount('limit-coin-global-daily'),monthlyMagicCoinsRewardBudget:amount('limit-coin-global-monthly'),maxCashRewardPerUserMinor:amount('limit-cash-user'),dailyCashRewardBudgetMinor:amount('limit-cash-daily'),monthlyCashRewardBudgetMinor:amount('limit-cash-monthly'),maxTotalCashRewardLiabilityMinor:amount('limit-cash-total')};
      const settings={
        system:{maintenanceMode:$('#sys-maintenance').checked,announcement:value('sys-announcement'),realMoneyEnabled:$('#sys-real-money').checked,emergencySwitches,safetyLimits},
        game:{questRewardMultiplier:Number(value('game-quest-mult')),achievementRewardMultiplier:Number(value('game-ach-mult')),battleRewardMultiplier:Number(value('game-battle-mult')),offlineCapHours:Number(value('game-offline-cap')),offlineEfficiency:Number(value('game-offline-eff')),mageCosts:parseJsonField('game-mage-costs','object'),mageCps:parseJsonField('game-mage-cps','object'),mageUpgradeBaseCosts:parseJsonField('game-mage-upgrades','object'),towerCosts:parseJsonField('game-tower-costs','array'),towerBonuses:parseJsonField('game-tower-bonuses','array')},
        ads:{...state.settings.ads,enabled:$('#ads-enabled').checked,publisherId:value('ads-publisher'),mainZoneId:value('ads-zone'),rewardedMagicCoins:amount('ads-reward-coins'),interstitialFrequency:Number(value('ads-frequency'))||1,formats:{...(state.settings.ads&&state.settings.ads.formats||{}),inAppInterstitial:$('#ads-interstitial').checked,rewardedInterstitial:$('#ads-rewarded').checked}},
        payments:{depositsEnabled:$('#pay-deposits').checked,withdrawalsEnabled:$('#pay-withdrawals').checked,currency:value('pay-currency').toUpperCase(),currencyExponent:Number(value('pay-exponent'))||0,minimumDepositMinor:amount('pay-min-deposit'),maximumDepositMinor:amount('pay-max-deposit'),minimumWithdrawalMinor:amount('pay-min-withdrawal'),maximumWithdrawalMinor:amount('pay-max-withdrawal')},
        referrals:{enabled:$('#ref-enabled').checked,qualificationLevel:Number(value('ref-level'))||1,qualificationHours:Number(value('ref-hours'))||0,rewardMagicCoins:amount('ref-reward')}
      };
      const oldSystem=state.settings.system||{},oldSwitches=oldSystem.emergencySwitches||{},oldLimits=oldSystem.safetyLimits||{};
      const unpausing=Object.keys(emergencySwitches).some(key=>key.endsWith('Paused')&&oldSwitches[key]===true&&emergencySwitches[key]===false);
      const raisingLimit=Object.keys(safetyLimits).some(key=>safetyLimits[key]>Number(oldLimits[key]||0));
      const oldPayments=state.settings.payments||{};
      const enablingMoney=(settings.payments.depositsEnabled&&!oldPayments.depositsEnabled)||(settings.payments.withdrawalsEnabled&&!oldPayments.withdrawalsEnabled)||(settings.system.realMoneyEnabled&&!oldSystem.realMoneyEnabled);
      const looseningMoney=Number(settings.payments.maximumDepositMinor)>Number(oldPayments.maximumDepositMinor||0)||Number(settings.payments.maximumWithdrawalMinor)>Number(oldPayments.maximumWithdrawalMinor||0)||Number(settings.payments.minimumDepositMinor)<Number(oldPayments.minimumDepositMinor||0)||Number(settings.payments.minimumWithdrawalMinor)<Number(oldPayments.minimumWithdrawalMinor||0)||settings.payments.currency!==String(oldPayments.currency||'').toUpperCase()||settings.payments.currencyExponent!==Number(oldPayments.currencyExponent||0);
      if(unpausing||raisingLimit||enablingMoney||looseningMoney){if(!await requireFinance())return;}
      const result=await api('/api/admin/settings',{method:'PATCH',body:{settings}});state.settings=result.settings||state.settings;fillSettings(state.settings);renderSecretStatus(state.settings.secretStatus||{});status('Operational settings saved. Restart is not required; public runtime settings refresh on the next game bootstrap.','good');
    }catch(error){status(error.message||errMessage(error.code),'bad');}
  }
  async function loadLogs(){
    const container=$('#admin-logs');setListMessage(container,'Loading audit log…');
    try{
      const data=await api('/api/admin/logs');container.replaceChildren();
      for(const row of data.logs||[]){
        const item=node('div','record'),main=node('div','record-main'),details=row.details&&typeof row.details==='object'?row.details:{};
        const meta=`${dateTime(row.createdAtMs)} · admin ${String(row.actorUid||'').slice(-4)}${row.targetUid?' · target '+String(row.targetUid).slice(-4):''}${row.targetId?' · '+row.targetId:''}`;
        main.append(node('div','record-title',row.action||'Action'),node('div','record-meta',meta));
        const safeParts=[];
        if(Array.isArray(details.changedFields)&&details.changedFields.length)safeParts.push(`Fields: ${details.changedFields.slice(0,20).join(', ')}`);
        else if(Array.isArray(details.changedSections)&&details.changedSections.length)safeParts.push(`Sections: ${details.changedSections.join(', ')}`);
        if(Number.isSafeInteger(Number(details.amountMinor)))safeParts.push(`Amount minor units: ${number(details.amountMinor)}${details.currency?' '+String(details.currency).slice(0,3):''}`);
        if(details.evidenceReference)safeParts.push('External evidence reference recorded');
        if(Number.isSafeInteger(Number(details.noteLength)))safeParts.push(`Audit note length: ${number(details.noteLength)} characters`);
        if(safeParts.length)main.append(node('div','record-meta',safeParts.join(' · ')));
        item.append(main);container.append(item);
      }
      if(!container.childElementCount)container.append(node('div','muted small','No audit records.'));
    }catch(error){setListMessage(container,errMessage(error.code));status(errMessage(error.code),'bad');}
  }
  async function verifyMfa(form){const code=$('#mfa-code').value.trim();if(!/^\d{6}$/.test(code)){status('Enter a six-digit authenticator code.','bad');return;}try{await api('/api/admin/mfa',{method:'POST',body:{code}});state.mfaVerified=true;showShell();$('#mfa-code').value='';status('Administrator MFA verified for 15 minutes.','good');await loadOverview();if(state.activeTab==='deposits')await loadDeposits();if(state.activeTab==='withdrawals')await loadWithdrawals();if(state.activeTab==='transactions')await loadTransactions();}catch(error){status(errMessage(error.code),'bad');}}
  document.addEventListener('click',event=>{
    const tab=event.target.closest&&event.target.closest('[data-admin-tab]');if(tab){activateTab(tab.dataset.adminTab);return;}
    const target=event.target.closest&&event.target.closest('[data-admin-action]');if(!target)return;
    const action=target.dataset.adminAction;
    if(action==='refresh-overview')loadOverview().then(()=>status('Overview refreshed.','good')).catch(e=>status(errMessage(e.code),'bad'));
    else if(action==='load-deposits')loadDeposits();else if(action==='load-withdrawals')loadWithdrawals();else if(action==='load-referrals')loadReferrals();else if(action==='load-transactions')loadTransactions();else if(action==='load-settings')loadSettings();else if(action==='load-logs')loadLogs();
    else if(action==='load-user')loadUser(target.dataset.uid);
    else if(action==='user-status')changeUserStatus(target.dataset.uid,target.dataset.status);
    else if(action==='deposit-approve')decideDeposit(target.dataset.id,'approve');else if(action==='deposit-reject')decideDeposit(target.dataset.id,'reject');
    else if(action==='withdrawal-action')withdrawalAction(target.dataset.id,target.dataset.action);
    else if(action==='referral-review')reviewReferral(target.dataset.id,target.dataset.action);
  });
  document.addEventListener('submit',event=>{
    const form=event.target;if(form.id==='mfa-form'){event.preventDefault();verifyMfa(form).catch(()=>{});}
    else if(form.id==='user-search-form'){event.preventDefault();searchUsers($('#user-query').value.trim());}
    else if(form.id==='settings-form'){event.preventDefault();saveSettings(form);}
    else if(form.dataset.adminForm==='user-note'){event.preventDefault();addUserNote(form);}
  });
  function boot(){
    $('#admin-retry').addEventListener('click',()=>login());
    if(window.Telegram&&window.Telegram.WebApp){login();}else{toggleGate('This console needs a verified Telegram Mini App launch. Open the admin URL from the configured Mag IA bot in Telegram.','info');}
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
