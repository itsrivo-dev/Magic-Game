'use strict';

const crypto = require('node:crypto');

const MAGES = [
  ['apprentice', 0, 1.2, 14, 'common', 'globalOutput', .004, .4],
  ['fire', 300, 5, 52, 'uncommon', 'battleDamage', .02, 2],
  ['frost', 1100, 11, 120, 'uncommon', 'manaRegen', .03, 1.5],
  ['shadow', 4200, 28, 330, 'rare', 'coinFind', .025, 2],
  ['nature', 11000, 54, 700, 'rare', 'globalOutput', .006, .6],
  ['storm', 34000, 128, 2100, 'epic', 'cooldown', .006, .4],
  ['holy', 88000, 250, 5200, 'epic', 'healing', .03, 2],
  ['runesmith', 210000, 470, 11500, 'epic', 'relicLuck', .02, 1.2],
  ['chrono', 640000, 940, 32000, 'legendary', 'offlineCap', .06, .6],
  ['archmage', 1600000, 2100, 78000, 'legendary', 'all', .008, 1]
];
const MAGE_MAP = new Map(MAGES.map(x => [x[0], x]));
const ENEMY_COINS = [1, .9, 1.05, 1.15, 1, 1.25, 1.1, 1.3, 1.2, 1.3, 1.35, 1.45];
const BOSS_COIN_BY_STAGE = { 5:5.2, 10:5.8, 15:6.4, 20:7.2, 25:8, 30:9, 35:11 };
const TOWER = [0, .12, .24, .36, .48, .60, .75, .90, 1.05, 1.20, 1.38, 1.56, 1.74, 1.92];
const TOWER_COSTS = [0, 420, 980, 2300, 5400, 12600, 29500, 69000, 161000, 376000, 880000, 2050000, 4780000, 11150000];
const RELIC_IDS = ['coin', 'swift', 'ember', 'moon'];
const SPELL_IDS = ['fireball', 'frost', 'arcane', 'mend', 'gild'];
const QUEST_IDS = ['q_coins','q_kills','q_cast','q_upgrade','q_tower','q_boss','q_recruit','q_haste','q_fight','q_relic','q_crit','q_survive'];
const ACHIEVEMENTS = {
  a_first: [120, s => s.kills.total + (s.stats.collected > 0 ? 1 : 0) >= 1],
  a_rich10: [1200, s => s.earned.total >= 10000],
  a_rich1m: [120000, s => s.earned.total >= 1000000],
  a_rich100m: [2500000, s => s.earned.total >= 100000000],
  a_circle3: [600, s => Object.keys(s.mages).length >= 3],
  a_circleAll: [200000, s => Object.keys(s.mages).length >= MAGES.length],
  a_lv25: [900, s => Math.max(...Object.values(s.mages).map(m => m.level)) >= 25],
  a_lv50: [24000, s => Math.max(...Object.values(s.mages).map(m => m.level)) >= 50],
  a_tower5: [3000, s => s.tower >= 5],
  a_towerMax: [6000000, s => s.tower >= 14],
  a_kills100: [2500, s => s.kills.total >= 100],
  a_kills1000: [180000, s => s.kills.total >= 1000],
  a_stage10: [5000, s => s.battle.best >= 10],
  a_stage35: [400000, s => s.battle.best >= 35],
  a_boss1: [1500, s => s.kills.bosses >= 1],
  a_boss7: [5000000, s => s.kills.bosses >= 7],
  a_spellMax: [150000, s => Object.values(s.spells).reduce((a,b) => a + b, 0) >= 60],
  a_haste50: [8000, s => s.stats.hastes >= 50],
  a_crit500: [60000, s => s.stats.crits >= 500],
  a_daily5: [4000, s => s.stats.dailyDone >= 5]
};
const DEFAULT_STATS = ['kills','spellsCast','attacks','crits','hastes','collected','relics','upgrades','recruits','dailyDone','offlineSeconds','offlineGain','stages','retreats','spent','highestPouch'];
const DAILY_COUNTERS = ['coinsCollected','kills','spellsCast','mageUpgrades','towerUpgrades','bossKills','recruits','hastes','attacks','relicsForged','crits','stageWins'];

function clampNumber(value, fallback, min = 0, max = 1e18) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
function int(value, fallback, min = 0, max = 1e9) { return Math.floor(clampNumber(value, fallback, min, max)); }
function validObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function dateKey(now = new Date()) { return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`; }

function starterSave(now = Date.now()) {
  const date = dateKey(new Date(now));
  const out = {
    v: 1, created: now, lastSaved: now, lastSeen: now, playtime: 0,
    coins: 25, xp: 0, earned: { total: 25, today: 0 }, spent: 0,
    pouch: { uncollected: 0, hasteUntil: 0, hasteCdUntil: 0, lastAt: now },
    mages: { apprentice: { level: 1, at: now } }, active: 'apprentice', selected: 'apprentice', tower: 1,
    relics: { ember: 0, moon: 0, swift: 0, coin: 0 }, relicPool: 0,
    spells: { fireball: 1, frost: 0, arcane: 0, mend: 0, gild: 0 },
    battle: { stage: 1, best: 1, streak: 0, hp: 0, mp: 0, keys: {}, buffUntil: 0, buffCdUntil: 0, auto: false },
    kills: { total: 0, bosses: 0 },
    stats: { kills:0, spellsCast:0, attacks:0, crits:0, hastes:0, collected:0, relics:0, upgrades:0, recruits:0, dailyDone:0, offlineSeconds:0, offlineGain:0, stages:0, retreats:0, spent:0, highestPouch:0 },
    daily: { date, day: 1, c: Object.fromEntries(DAILY_COUNTERS.map(k => [k,0])), claimed: {}, streak: 0, lastClaimDay: 0, missions: [] },
    bestiary: {}, achievements: { unlocked: {} },
    settings: { sound: true, motion: null, haptics: true },
    flags: { intro: false, warned: false }
  };
  out.daily.missions = ['q_coins','q_kills','q_cast','q_upgrade','q_tower'].map(id => ({ id, claimed:false, progress:0 }));
  return out;
}

function sanitizeSave(raw, now = Date.now(), { migration = false } = {}) {
  if (!validObject(raw) || (!('coins' in raw) && !validObject(raw.mages))) return null;
  const d = starterSave(now);
  d.created = int(raw.created, d.created, Math.max(0, now - 3650 * 86400000), now + 300000) || d.created;
  d.lastSaved = int(raw.lastSaved, now, 0, now + 300000) || now;
  d.lastSeen = int(raw.lastSeen, now, Math.max(0, now - 365 * 86400000), now + 300000) || now;
  d.playtime = clampNumber(raw.playtime, 0, 0, 3.16e11);
  d.coins = clampNumber(raw.coins, 25, 0, migration ? 1e15 : 1e18);
  d.xp = clampNumber(raw.xp, 0, 0, 1e15);
  d.spent = clampNumber(raw.spent, 0, 0, 1e18);
  if (validObject(raw.earned)) {
    d.earned.total = Math.max(d.coins, clampNumber(raw.earned.total, d.coins, 0, 1e18));
    d.earned.today = clampNumber(raw.earned.today, 0, 0, 1e18);
  } else d.earned.total = d.coins;
  if (validObject(raw.pouch)) {
    d.pouch.uncollected = clampNumber(raw.pouch.uncollected, 0, 0, 1e18);
    d.pouch.hasteUntil = int(raw.pouch.hasteUntil, 0, 0, now + 120000);
    d.pouch.hasteCdUntil = int(raw.pouch.hasteCdUntil, 0, 0, now + 120000);
    d.pouch.lastAt = int(raw.pouch.lastAt, now, d.created, now + 300000);
  }
  if (validObject(raw.mages)) {
    for (const [id, rec] of Object.entries(raw.mages)) {
      if (!MAGE_MAP.has(id) || !validObject(rec)) continue;
      d.mages[id] = { level: int(rec.level, 1, 1, 500), at: int(rec.at, now, 0, now + 300000) };
    }
  }
  if (!d.mages.apprentice) d.mages.apprentice = { level: 1, at: now };
  d.active = typeof raw.active === 'string' && d.mages[raw.active] ? raw.active : 'apprentice';
  d.selected = typeof raw.selected === 'string' && d.mages[raw.selected] ? raw.selected : d.active;
  d.tower = int(raw.tower, 1, 1, 14);
  if (validObject(raw.relics)) for (const id of RELIC_IDS) d.relics[id] = int(raw.relics[id], 0, 0, 999);
  d.relicPool = int(raw.relicPool, 0, 0, 9999);
  if (validObject(raw.spells)) for (const [i,id] of SPELL_IDS.entries()) d.spells[id] = int(raw.spells[id], i === 0 ? 1 : 0, i === 0 ? 1 : 0, 12);
  if (validObject(raw.battle)) {
    d.battle.stage = int(raw.battle.stage, 1, 1, 9999);
    d.battle.best = Math.max(d.battle.stage, int(raw.battle.best, 1, 1, 9999));
    d.battle.streak = int(raw.battle.streak, 0, 0, 999);
    d.battle.hp = clampNumber(raw.battle.hp, 0, 0, 1e9);
    d.battle.mp = clampNumber(raw.battle.mp, 0, 0, 1e9);
    d.battle.buffUntil = int(raw.battle.buffUntil, 0, 0, now + 120000);
    d.battle.buffCdUntil = int(raw.battle.buffCdUntil, 0, 0, now + 120000);
    d.battle.auto = raw.battle.auto === true;
    if (validObject(raw.battle.keys)) for (const key of ['ember','frost','sand','void','storm','radiant','chrono']) if (raw.battle.keys[key] === true) d.battle.keys[key] = true;
  }
  if (validObject(raw.kills)) {
    d.kills.total = int(raw.kills.total, 0, 0, 1e12);
    d.kills.bosses = int(raw.kills.bosses, 0, 0, 1e12);
  }
  if (validObject(raw.stats)) for (const key of DEFAULT_STATS) d.stats[key] = clampNumber(raw.stats[key], 0, 0, 1e15);
  if (validObject(raw.daily)) {
    d.daily.day = int(raw.daily.day, 1, 1, 9999);
    d.daily.streak = int(raw.daily.streak, 0, 0, 999);
    d.daily.lastClaimDay = int(raw.daily.lastClaimDay, 0, 0, 9999999);
    d.daily.date = typeof raw.daily.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.daily.date) ? raw.daily.date : d.daily.date;
    if (validObject(raw.daily.c)) for (const key of DAILY_COUNTERS) d.daily.c[key] = clampNumber(raw.daily.c[key], 0, 0, 1e15);
    if (validObject(raw.daily.claimed)) for (const id of QUEST_IDS) if (raw.daily.claimed[id] === true) d.daily.claimed[id] = true;
    if (Array.isArray(raw.daily.missions)) d.daily.missions = raw.daily.missions.filter(m => validObject(m) && QUEST_IDS.includes(m.id)).slice(0,5).map(m => ({ id:m.id, claimed:m.claimed === true, progress:int(m.progress,0,0,1e15) }));
  }
  if (validObject(raw.bestiary)) {
    for (const [id, entry] of Object.entries(raw.bestiary).slice(0,32)) {
      if (!validObject(entry) || !/^[a-z0-9_-]{1,32}$/.test(id)) continue;
      d.bestiary[id] = { seen: int(entry.seen,0,0,1e9), killed:int(entry.killed,0,0,1e12), best:clampNumber(entry.best,0,0,1e18) };
    }
  }
  if (validObject(raw.achievements) && validObject(raw.achievements.unlocked)) {
    for (const id of Object.keys(ACHIEVEMENTS)) if (raw.achievements.unlocked[id] === true) d.achievements.unlocked[id] = true;
  }
  if (validObject(raw.settings)) {
    d.settings.sound = raw.settings.sound !== false;
    d.settings.haptics = raw.settings.haptics !== false;
    d.settings.motion = raw.settings.motion === true || raw.settings.motion === false ? raw.settings.motion : null;
  }
  if (validObject(raw.flags)) {
    d.flags.intro = raw.flags.intro === true;
    d.flags.warned = raw.flags.warned === true;
  }
  if (migration) {
    d.coins = Math.min(d.coins, 1e15);
    d.earned.total = Math.max(d.coins, Math.min(d.earned.total, 1e15));
  }
  return d;
}

function xpLevel(save) {
  let xp = save.xp || 0, level = 1, need = Math.ceil(70 * Math.pow(level, 1.55));
  while (xp >= need && level < 500) { xp -= need; level++; need = Math.ceil(70 * Math.pow(level, 1.55)); }
  return level;
}
function estimateCps(save, gameConfig = {}) {
  const rarities = { common:0, uncommon:1, rare:2, epic:3, legendary:4 };
  const level = xpLevel(save);
  const talent = Object.create(null);
  let total = 0;
  for (const [id, , baseCps, , rarity, kind, per, cap] of MAGES) {
    const rec = save.mages[id];
    if (!rec) continue;
    const rank = rec.level;
    const configured = gameConfig.mageCps && Number(gameConfig.mageCps[id]);
    const cpsBase = Number.isFinite(configured) && configured >= 0 ? configured : baseCps;
    const cps = cpsBase * (1 + (rarities[rarity] || 0) * .04) * (1 + .19 * (rank - 1)) * (1 + .012 * Math.max(0, rank - 20));
    total += cps;
    talent[kind] = (talent[kind] || 0) + Math.min(cap, per * rank);
  }
  const configuredTower = Array.isArray(gameConfig.towerBonuses) ? Number(gameConfig.towerBonuses[save.tower - 1]) : NaN;
  const floorBonus = Number.isFinite(configuredTower) && configuredTower >= 0 ? configuredTower : TOWER[save.tower - 1] || 0;
  const relicTotal = RELIC_IDS.reduce((sum,id) => sum + (save.relics[id] || 0), 0) + save.relicPool;
  const relicBonus = relicTotal <= 60 ? .06 * relicTotal : .06 * 60 + .004 * (relicTotal - 60);
  const circle = 1 + .02 * (Object.keys(save.mages).length - 1);
  const allTalent = talent.all || 0;
  const output = (1 + .02 * (level - 1)) * (1 + floorBonus) * circle * (1 + relicBonus) * (1 + (talent.globalOutput || 0)) * (1 + allTalent * (save.tower >= 13 ? 1.12 : 1)) * (save.tower >= 14 ? 1.4 : 1);
  return Math.max(0, total * output);
}
function stageRewardMax(stage, gameConfig = {}) {
  const s = Math.max(1, Math.min(9999, Math.floor(stage)));
  const coinGrowth = Math.pow(1.115, s - 1);
  const boss = BOSS_COIN_BY_STAGE[s] || 0;
  const bossStep = Math.pow(1.1, Math.max(0, Math.ceil(s / 5) - 1));
  const bossCoins = boss ? 17 * boss * 8 * coinGrowth * bossStep : 0;
  const normalCoins = 17 * 1.45 * coinGrowth;
  const multiplier = Number.isFinite(Number(gameConfig.battleRewardMultiplier)) ? Math.min(5,Math.max(.1,Number(gameConfig.battleRewardMultiplier))) : 1;
  return Math.ceil(Math.max(bossCoins, normalCoins) * 5 * multiplier);
}
function estimateIncomeAllowance(previous, next, elapsedSeconds, gameConfig = {}) {
  const sec = Math.max(0, Math.min(Number(elapsedSeconds) || 0, 24 * 3600));
  const configuredCap = Number.isFinite(Number(gameConfig.offlineCapHours)) ? Math.min(24,Math.max(1,Number(gameConfig.offlineCapHours))) : 8;
  const chrono = Object.entries(previous.mages).reduce((sum,[id,rec]) => id === 'chrono' ? sum + Math.min(.6,.06*rec.level) : sum,0);
  const capHours = Math.min(24,configuredCap * (1 + Math.min(.6,chrono)));
  const cps = estimateCps(previous,gameConfig);
  const configuredEfficiency = Number.isFinite(Number(gameConfig.offlineEfficiency)) ? Math.min(1,Math.max(.1,Number(gameConfig.offlineEfficiency))) : .55;
  const towerEfficiency = previous.tower >= 9 ? 1.25 : 1;
  // Includes the configured away rate plus a bounded margin for active pouch collection/haste.
  const passiveMargin = Math.max(1.35,configuredEfficiency*towerEfficiency*1.3+.75);
  const passive = cps * Math.min(sec,capHours*3600) * passiveMargin + 10;
  const killDelta = Math.max(0,Math.min(100,next.kills.total-previous.kills.total));
  const maxKillsByTime = sec <= 0 ? 0 : Math.max(1,Math.floor(sec/1.2));
  const battle = stageRewardMax(Math.max(previous.battle.stage,next.battle.stage),gameConfig) * Math.min(killDelta,maxKillsByTime);
  const questMultiplier = Number.isFinite(Number(gameConfig.questRewardMultiplier)) ? Math.min(5,Math.max(.1,Number(gameConfig.questRewardMultiplier))) : 1;
  const dailyClaimDelta = Object.entries(next.daily.claimed).filter(([id,claimed]) => claimed && !previous.daily.claimed[id]).length;
  const daily = Math.min(250000*questMultiplier,dailyClaimDelta*50000*questMultiplier);
  const achievementMultiplier = Number.isFinite(Number(gameConfig.achievementRewardMultiplier)) ? Math.min(5,Math.max(.1,Number(gameConfig.achievementRewardMultiplier))) : 1;
  const newlyUnlocked = Object.entries(next.achievements.unlocked).filter(([id,unlocked]) => unlocked && !previous.achievements.unlocked[id]);
  const achievement = newlyUnlocked.reduce((sum,[id]) => sum + ((ACHIEVEMENTS[id] && ACHIEVEMENTS[id][1](next)) ? ACHIEVEMENTS[id][0]*achievementMultiplier : 0),0);
  return Math.max(10,passive+battle+daily+achievement);
}

function syncValidation(previous, incomingRaw, elapsedSeconds, options = {}) {
  const next = sanitizeSave(incomingRaw, options.now || Date.now());
  if (!next) return { ok:false, reason:'invalid_game_save' };
  if (!previous) return { ok:true, state:next, version:1, migrated:true };
  const old = sanitizeSave(previous, options.now || Date.now());
  if (!old) return { ok:false, reason:'stored_game_save_invalid' };
  const hasReset = next.created > old.created + 1000 && next.tower === 1 && next.battle.best <= 1 && next.coins <= 25;
  if (hasReset) return { ok:true, state:next, version:(options.version || 1) + 1, reset:true };
  const allowance = estimateIncomeAllowance(old,next,elapsedSeconds,options.gameSettings || {});
  if (next.coins > old.coins + allowance) return { ok:false, reason:'magic_coin_delta_exceeds_server_limit', maxAllowedDelta:Math.floor(allowance) };
  if (next.earned.total > old.earned.total + allowance) return { ok:false, reason:'earned_total_exceeds_server_limit', maxAllowedDelta:Math.floor(allowance) };
  const seconds = Math.max(0, Number(elapsedSeconds) || 0);
  const maxEventCount = Math.max(1, Math.floor(Math.min(100, seconds / 1.2)));
  if (next.kills.total - old.kills.total > maxEventCount || next.battle.best - old.battle.best > maxEventCount + 1) return { ok:false, reason:'progression_rate_exceeds_server_limit' };
  next.created = old.created;
  next.lastSeen = options.now || Date.now();
  next.lastSaved = options.now || Date.now();
  return { ok:true, state:next, version:(options.version || 1) + 1, allowance:Math.floor(allowance) };
}

function referralCode() {
  return crypto.randomBytes(8).toString('base64url').replace(/[-_]/g, '').slice(0, 10).toUpperCase();
}

module.exports = {
  MAGES, MAGE_MAP, TOWER, TOWER_COSTS, RELIC_IDS, SPELL_IDS, QUEST_IDS, ACHIEVEMENTS,
  starterSave, sanitizeSave, xpLevel, estimateCps, estimateIncomeAllowance, syncValidation, referralCode
};
