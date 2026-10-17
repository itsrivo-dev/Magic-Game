'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');

function makeContext(canvas){const grad={addColorStop(){}};return new Proxy({canvas,measureText(){return {width:10};},createLinearGradient(){return grad;},createRadialGradient(){return grad;}},{get:(o,k)=>k in o?o[k]:()=>{},set:(o,k,v)=>(o[k]=v,true)});}
function response(data,status=200){return {ok:status>=200&&status<300,status,async text(){return JSON.stringify(data);}};}

test('Telegram bootstrap loads cloud progress, preserves the previous local save, then enables sync',async t=>{
  const html=fs.readFileSync(path.resolve(__dirname,'../index.html'),'utf8');
  const gameClient=fs.readFileSync(path.resolve(__dirname,'../client.js'),'utf8');
  const dom=new JSDOM(html,{url:'https://magia.test/',runScripts:'outside-only',pretendToBeVisual:true});
  t.after(()=>dom.window.close());const {window}=dom;
  window.scrollTo=()=>{};window.matchMedia=()=>({matches:false});window.requestAnimationFrame=()=>1;window.cancelAnimationFrame=()=>{};window.AbortSignal=AbortSignal;
  window.HTMLCanvasElement.prototype.getContext=function(){return makeContext(this);};
  const inline=[...window.document.scripts].filter(script=>!script.src).pop();window.eval(inline.textContent);
  assert.equal(window.MagIA.load({coins:25,mages:{apprentice:{level:1}}}),true);
  const local=window.MagIA.snapshot;local.coins=250;local.earned.total=250;local.lastSeen=Date.now();
  window.localStorage.setItem('magia.save.v1',JSON.stringify(local));
  const cloud=window.MagIA.snapshot;cloud.coins=750;cloud.earned.total=750;cloud.lastSeen=Date.now();
  window.Telegram={WebApp:{initData:'signed-telegram-init-data',ready(){},expand(){},setHeaderColor(){},setBackgroundColor(){}}};
  const requests=[];
  window.fetch=async(url,options={})=>{
    const endpoint=new URL(url,'https://magia.test').pathname;requests.push(endpoint);
    if(endpoint==='/api/public/config')return response({maintenanceMode:false,announcement:'',game:null,monetag:{enabled:false,formats:{}},finance:{depositsEnabled:false,withdrawalsEnabled:false}});
    if(endpoint==='/api/auth/telegram')return response({authenticated:true,profile:{telegramId:'123456789',firstName:'Cloud Mage'},game:{version:4,hasProgress:true,state:cloud}});
    if(endpoint==='/api/me')return response({profile:{telegramId:'123456789',firstName:'Cloud Mage'}});
    if(endpoint==='/api/account/finance')return response({configured:false,status:'not_configured',currency:null,currencyExponent:2,availableMinor:0,reservedMinor:0,deposits:{enabled:false,methods:[],history:[]},withdrawals:{enabled:false,methods:[],history:[]},transactions:[]});
    if(endpoint==='/api/account/referrals')return response({code:'ABCD123456',link:null,counts:{},total:0,history:[]});
    if(endpoint==='/api/game/sync')return response({accepted:true,version:5,serverTime:Date.now(),allowance:0});
    return response({error:'not_found'},404);
  };
  window.eval(gameClient);
  window.MagIA.runtime().Boot.run();
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal(window.MagIA.runtime().S.coins,750);
  assert.equal(window.MagIACloud.mode,'cloud');
  assert.equal(window.MagIACloud.version,4);
  assert.ok(window.localStorage.getItem('magia.save.v1.pre-cloud-backup'));
  const backup=JSON.parse(window.localStorage.getItem('magia.save.v1.pre-cloud-backup'));
  assert.equal(backup.state.coins,250);
  assert.ok(requests.includes('/api/auth/telegram'));
  assert.equal(window.document.getElementById('acc-name').textContent,'Cloud Mage');
});
