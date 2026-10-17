'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');

function makeCanvasContext(canvas){
  const gradient={addColorStop(){}};
  const base={canvas,measureText(){return {width:12};},createLinearGradient(){return gradient;},createRadialGradient(){return gradient;},createPattern(){return null},getImageData(){return {data:new Uint8ClampedArray(4)};}};
  return new Proxy(base,{get(target,key){if(key in target)return target[key];return ()=>{};},set(target,key,value){target[key]=value;return true;}});
}
function loadGame(){
  const html=fs.readFileSync(path.resolve(__dirname,'../index.html'),'utf8');
  const dom=new JSDOM(html,{url:'https://game.test/',runScripts:'outside-only',pretendToBeVisual:true});
  const {window}=dom;
  window.scrollTo=()=>{};window.matchMedia=()=>({matches:false,addListener(){},removeListener(){}});
  window.requestAnimationFrame=()=>1;window.cancelAnimationFrame=()=>{};
  window.HTMLCanvasElement.prototype.getContext=function(){return makeCanvasContext(this);};
  const inline=[...window.document.scripts].filter(script=>!script.src).pop();
  assert.ok(inline&&inline.textContent.includes('const CONFIG'));
  window.eval(inline.textContent);
  window.MagIA.runtime().Boot.run();
  return dom;
}

test('existing Mag IA game boots with progression and the responsive Account screen',t=>{
  const dom=loadGame();t.after(()=>dom.window.close());const {window}=dom;
  const game=window.MagIA;const runtime=game.runtime();
  assert.equal(game.data.MAGES.length,10);assert.equal(game.data.TOWER_FLOORS.length,14);
  assert.equal(game.data.SPELLS.length,5);assert.equal(game.data.ENEMIES.length,12);assert.equal(game.data.BOSSES.length,7);
  assert.equal(Object.keys(game.data.ACHIEVEMENTS).length,20);
  assert.ok(window.document.getElementById('screen-account'));
  assert.ok(window.document.getElementById('deposit-form'));
  assert.ok(window.document.getElementById('withdrawal-form'));
  assert.ok(window.document.querySelector('script[src="client.js"]'));
  game.router.go('account');
  assert.equal(window.document.getElementById('screen-account').classList.contains('active'),true);
  assert.ok(window.document.getElementById('dock-account'));
  assert.ok(window.document.getElementById('deposit-amount').disabled);
  assert.ok(window.document.getElementById('withdrawal-amount').disabled);
  assert.equal(runtime.S.coins,25);
});

test('legacy save v1 remains loadable and cloud config only changes intended balance knobs',t=>{
  const dom=loadGame();t.after(()=>dom.window.close());const {window}=dom;const game=window.MagIA;const runtime=game.runtime();
  const save=game.snapshot;save.coins=12345;save.mages.fire={level:4,at:Date.now()};save.active='fire';
  assert.equal(game.load(save),true);assert.equal(game.runtime().S.coins,12345);assert.equal(game.runtime().S.mages.fire.level,4);
  const beforeCost=game.data.MAGES.find(m=>m.id==='fire').cost;
  let queued=0;window.MagIACloud={mode:'cloud',queueSave(){queued++;}};
  runtime.Save.write();assert.equal(queued,1);
  assert.equal(game.applyOperationalConfig({game:{mageCosts:{fire:777},mageCps:{fire:9},mageUpgradeBaseCosts:{fire:99},towerCosts:Array(14).fill(42),towerBonuses:Array(14).fill(.2),questRewardMultiplier:2,achievementRewardMultiplier:1.5,battleRewardMultiplier:1.25,offlineCapHours:12,offlineEfficiency:.7}}),true);
  assert.equal(game.data.MAGES.find(m=>m.id==='fire').cost,777);
  assert.notEqual(beforeCost,777);assert.equal(game.data.TOWER_FLOORS[1].cost,42);
  assert.equal(game.config.QUEST_REWARD_MULT,2);assert.equal(game.config.ACHIEVEMENT_REWARD_MULT,1.5);assert.equal(game.config.BATTLE_REWARD_MULT,1.25);
  assert.equal(game.config.OFFLINE_CAP_HOURS,12);assert.equal(game.config.OFFLINE_EFFICIENCY,.7);
});
