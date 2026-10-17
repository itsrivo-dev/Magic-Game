'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {MemoryStore,FirestoreStore}=require('../server/store');
const {starterSave,sanitizeSave,estimateIncomeAllowance,syncValidation,MAGES,RELIC_IDS,SPELL_IDS,ACHIEVEMENTS,xpLevel}=require('../server/game-state');

test('MemoryStore supports equality, range operators and in filters',async()=>{
  const store=new MemoryStore({
    'users/1':{name:'A',lastActivityAtMs:20,status:'active'},
    'users/2':{name:'B',lastActivityAtMs:10,status:'pending'},
    'users/3':{name:'C',lastActivityAtMs:30,status:'approved'}
  });
  const recent=await store.list('users',{where:{lastActivityAtMs:{op:'>=',value:20}}});
  assert.deepEqual(recent.map(row=>row.id).sort(),['1','3']);
  const open=await store.list('users',{where:{status:['pending','approved']},orderBy:'lastActivityAtMs',direction:'asc'});
  assert.deepEqual(open.map(row=>row.id),['2','3']);
  assert.equal(await store.count('users',{where:{status:{op:'in',value:['active','pending']}}}),2);
});

test('MemoryStore transaction adapter rejects Firestore-invalid reads after writes',async()=>{
  const store=new MemoryStore();
  await assert.rejects(store.runTransaction(async tx=>{tx.set('things/one',{ok:true});await tx.get('things/two');}),error=>error.code==='READ_AFTER_WRITE');
  assert.equal(await store.get('things/one'),null,'failed transaction writes are not committed');
});

test('FirestoreStore translates array status filters to an in query',async()=>{
  const clauses=[];
  const docs=[{id:'a',ref:{path:'requests/a'},data:()=>({status:'pending'})}];
  const query={
    where(field,op,value){clauses.push([field,op,value]);return this;},
    orderBy(){return this;},limit(){return this;},
    async get(){return {docs};}
  };
  const db={collection(){return query;}};
  const store=new FirestoreStore(db,{serverTimestamp:()=>new Date()});
  const rows=await store.list('requests',{where:{status:['pending','approved']},limit:25});
  assert.deepEqual(clauses,[['status','in',['pending','approved']]]);
  assert.equal(rows[0].id,'a');
});

test('game save sanitizer preserves Mag IA data shape and discards untrusted fields',()=>{
  const now=Date.now();const fresh=starterSave(now);
  const sanitized=sanitizeSave({...fresh,coins:Infinity,admin:true,realMoneyBalance:1e12,mages:{apprentice:{level:3},forged:{level:999999}}},now);
  assert.ok(sanitized);
  assert.equal(sanitized.coins,25);
  assert.equal(sanitized.mages.apprentice.level,3);
  assert.equal('forged' in sanitized.mages,false);
  assert.equal('admin' in sanitized,false);
  assert.equal('realMoneyBalance' in sanitized,false);
  assert.equal(MAGES.length,10);assert.equal(RELIC_IDS.length,4);assert.equal(SPELL_IDS.length,5);assert.equal(Object.keys(ACHIEVEMENTS).length,20);
  assert.equal(xpLevel({...fresh,xp:70}),2);
});

test('sync allowance reflects runtime economy settings and sync versioning',()=>{
  const now=Date.now();const old=starterSave(now-10000);const next=structuredClone(old);
  next.lastSeen=now;next.lastSaved=now;next.coins+=500;next.earned.total+=500;
  const defaults={offlineCapHours:8,offlineEfficiency:.55,questRewardMultiplier:1,achievementRewardMultiplier:1,battleRewardMultiplier:1};
  const tuned={...defaults,offlineCapHours:24,offlineEfficiency:1,mageCps:{apprentice:3},towerBonuses:Array(14).fill(.5),battleRewardMultiplier:5,questRewardMultiplier:2,achievementRewardMultiplier:2};
  const base=estimateIncomeAllowance(old,next,3600,defaults);
  const adjusted=estimateIncomeAllowance(old,next,3600,tuned);
  assert.ok(adjusted>base);
  const accepted=syncValidation(old,next,3600,{version:7,now,gameSettings:tuned});
  assert.equal(accepted.ok,true);assert.equal(accepted.version,8);
  const over=structuredClone(next);over.coins+=adjusted+100;over.earned.total+=adjusted+100;
  const rejected=syncValidation(old,over,3600,{version:7,now,gameSettings:tuned});
  assert.equal(rejected.ok,false);assert.equal(rejected.reason,'magic_coin_delta_exceeds_server_limit');
});
