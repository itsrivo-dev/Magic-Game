'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');

function jsonResponse(value,status=200){return {ok:status>=200&&status<300,status,async text(){return JSON.stringify(value);}};}

test('admin console authenticates through Telegram and renders a MFA-gated dashboard',async t=>{
  const html=fs.readFileSync(path.resolve(__dirname,'../admin.html'),'utf8');
  const script=fs.readFileSync(path.resolve(__dirname,'../admin.js'),'utf8');
  const dom=new JSDOM(html,{url:'https://magia.test/admin',runScripts:'outside-only',pretendToBeVisual:true});
  t.after(()=>dom.window.close());const {window}=dom;
  window.AbortSignal=AbortSignal;
  window.Telegram={WebApp:{initData:'signed-test-init-data',ready(){},expand(){}}};
  window.fetch=async(url,options={})=>{
    const pathName=new URL(url,'https://magia.test').pathname;
    if(pathName==='/api/auth/telegram')return jsonResponse({authenticated:true,profile:{telegramId:'900000001',firstName:'Test Admin',username:'test_admin'}});
    if(pathName==='/api/admin/me')return jsonResponse({authorized:true,mfaRequired:true,mfaConfigured:true,mfaVerified:false,profile:{telegramId:'900000001',firstName:'Test Admin'}});
    if(pathName==='/api/admin/summary')return jsonResponse({users:{total:3,new24h:1,active24h:2},finance:{locked:true,verifiedDepositsMinor:null},recentActions:[],warnings:['Finance metrics are hidden until administrator MFA is verified.','Revenue unavailable/unverified.']});
    return jsonResponse({error:'not_found'},404);
  };
  window.eval(script);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded',{bubbles:true}));
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(window.document.getElementById('admin-gate').hidden,true);
  assert.equal(window.document.getElementById('admin-shell').hidden,false);
  assert.equal(window.document.getElementById('mfa-card').hidden,false);
  assert.equal(window.document.querySelector('[data-stat="totalUsers"]').textContent,'3');
  assert.equal(window.document.querySelector('[data-stat="verifiedDeposits"]').textContent,'MFA required');
  assert.match(window.document.getElementById('overview-warnings').textContent,/unavailable\/unverified/);
  assert.match(html,/@media\(max-width:620px\)/);
  assert.doesNotMatch(html,/type="password"/i);
});
