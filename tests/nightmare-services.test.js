'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEconomyStore, createGiveawayStore, createTicketStore, pickWinners, createRateLimiter } = require('../nightmare-services');

test('economy persists daily, transfer, purchase and rejects duplicate daily claims', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightmare-economy-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let time = 100_000_000; const file = path.join(dir, 'economy.json');
  const store = createEconomyStore(file, { now: () => time });
  assert.equal(store.daily('12345678901234567', '12345678901234568').claimed, true);
  assert.equal(store.daily('12345678901234567', '12345678901234568').claimed, false);
  store.transfer('12345678901234567', '12345678901234568', '12345678901234569', 40);
  store.purchase('12345678901234567', '12345678901234569', 'Potion', 10);
  assert.equal(createEconomyStore(file, { now: () => time }).balance('12345678901234567', '12345678901234569'), 30);
  assert.throws(() => store.transfer('12345678901234567', '12345678901234569', '12345678901234570', 100), /Insufficient/);
  time += 86_400_000;
  assert.equal(store.daily('12345678901234567', '12345678901234568').claimed, true);
});

test('catalog purchases use stable IDs, server prices, rank gates, atomic sales and audited admin changes', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightmare-catalog-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createEconomyStore(path.join(dir, 'economy.json'), { now: () => 200_000_000 });
  const guildId = '12345678901234567', userId = '12345678901234568', adminId = '12345678901234569';
  store.daily(guildId, userId, 10_000);
  const purchase = store.purchaseCatalog(guildId, userId, 'iron_sword', 2);
  assert.equal(purchase.total, 700); assert.equal(store.inventory(guildId, userId).iron_sword, 2);
  assert.throws(() => store.purchaseCatalog(guildId, userId, 'dragon_armor'), /rank S/);
  const price = store.configurePrice(guildId, adminId, 'iron_sword', 500);
  assert.equal(price.before, 350); assert.equal(store.itemPrice(guildId, 'iron_sword'), 500);
  const sale = store.sell(guildId, userId, 'iron_sword', 1);
  assert.equal(sale.total, 140); assert.equal(sale.quantity, 1);
  assert.throws(() => store.sell(guildId, userId, 'iron_sword', 2), /Inventory tidak cukup/);
  store.adminAdjust(guildId, adminId, userId, 'add', 50);
  store.adminItem(guildId, adminId, userId, 'give', 'herb', 3);
  assert.equal(store.inventory(guildId, userId).herb, 3);
  assert.throws(() => store.adminAdjust(guildId, adminId, userId, 'remove', 1_000_000), /Saldo target tidak cukup/);
  const data = JSON.parse(fs.readFileSync(path.join(dir, 'economy.json'), 'utf8'));
  assert.equal(data.guilds[guildId].adminAudit.length, 3);
  assert.equal(data.guilds[guildId].adminAudit[0].actorId, adminId);
});

test('legacy inventory labels migrate to stable item IDs and concurrent sales cannot oversell', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightmare-catalog-legacy-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'economy.json'); const guildId = '12345678901234567', userId = '12345678901234568';
  fs.writeFileSync(file, JSON.stringify({ version: 1, guilds: { [guildId]: { users: { [userId]: { balance: 0, inventory: { Potion: 2 }, lastDailyAt: 0 } }, transactions: [] } } }));
  const store = createEconomyStore(file); assert.deepEqual(store.inventory(guildId, userId), { health_potion: 2 });
  const results = [() => store.sell(guildId, userId, 'health_potion', 2), () => store.sell(guildId, userId, 'health_potion', 2)].map(fn => { try { return fn(); } catch (error) { return error; } });
  assert.equal(results.filter(result => !(result instanceof Error)).length, 1);
  assert.equal(store.inventory(guildId, userId).health_potion || 0, 0);
});

test('Adventure registration and crafting use the shared Economy inventory atomically', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightmare-crafting-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'economy.json'), store = createEconomyStore(file);
  const guildId = '12345678901234567', userId = '12345678901234568';
  const registered = store.registerAdventure(guildId, userId, 'Mira');
  assert.equal(registered.created, true); assert.equal(registered.profile.rank, 'F');
  store.adminItem(guildId, '12345678901234569', userId, 'give', 'slime_gel', 2);
  store.adminItem(guildId, '12345678901234569', userId, 'give', 'herb', 1);
  const results = [() => store.craft(guildId, userId, 'health_potion', 1), () => store.craft(guildId, userId, 'health_potion', 1)].map(run => { try { return run(); } catch (error) { return error; } });
  assert.equal(results.filter(result => !(result instanceof Error)).length, 1);
  assert.equal(store.inventory(guildId, userId).health_potion, 1);
  assert.equal(store.inventory(guildId, userId).slime_gel, undefined);
  assert.throws(() => store.craft(guildId, userId, 'health_potion'), /Material kurang/);
  const restarted = createEconomyStore(file); assert.equal(restarted.adventureProfile(guildId, userId).name, 'Mira');
  assert.equal(restarted.inventory(guildId, userId).health_potion, 1);
});

test('Adventure hunting settles one reward, expires safely, and rejects repeated actions', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nightmare-hunt-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let time=200_000_000;const store=createEconomyStore(path.join(dir,'economy.json'),{now:()=>time});const guild='12345678901234567',user='12345678901234568';store.registerAdventure(guild,user,'Rin');
  const game=store.startHunt(guild,user,'12345678901234569',{random:()=>0});assert.equal(game.monster.name,'Slime');assert.equal(store.actHunt(guild,user,game.id,'12345678901234570','attack').reason,'ok');const repeated=store.actHunt(guild,user,game.id,'12345678901234570','attack');assert.equal(repeated.reason,'duplicate');assert.equal(store.balance(guild,user),0);
  let result=store.actHunt(guild,user,game.id,'12345678901234571','attack');assert.equal(result.done,false);result=store.actHunt(guild,user,game.id,'12345678901234572','attack');assert.equal(result.done,true);assert.equal(result.outcome,'won');assert.equal(store.balance(guild,user),12);assert.equal(store.inventory(guild,user).slime_gel,1);assert.equal(store.actHunt(guild,user,game.id,'12345678901234573','attack').reason,'ended');
  const next=store.startHunt(guild,user,'12345678901234573',{random:()=>0});time+=300_001;assert.equal(store.actHunt(guild,user,next.id,'12345678901234574','attack').reason,'expired');assert.equal(store.balance(guild,user),12);
});

test('Monster Bait is consumed atomically at hunt start and consistently spent on escape/expiry, with bonus loot only on victory', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nightmare-bait-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let time=200_000_000;const file=path.join(dir,'economy.json'),store=createEconomyStore(file,{now:()=>time});const guild='12345678901234567',user='12345678901234568';store.registerAdventure(guild,user,'Rin');store.adminItem(guild,user,user,'give','monster_bait',2);
  const escaped=store.startHunt(guild,user,'12345678901234569',{random:()=>0});assert.equal(escaped.lootBonus,1);assert.equal(store.inventory(guild,user).monster_bait,1);assert.throws(()=>store.startHunt(guild,user,'12345678901234570',{random:()=>0}),/sesi hunting aktif/);assert.equal(store.inventory(guild,user).monster_bait,1);assert.equal(store.actHunt(guild,user,escaped.id,'12345678901234571','run').outcome,'escaped');assert.equal(store.inventory(guild,user).slime_gel,undefined);
  const expired=store.startHunt(guild,user,'12345678901234572',{random:()=>0});time+=300_001;assert.equal(store.actHunt(guild,user,expired.id,'12345678901234573','attack').reason,'expired');assert.equal(store.inventory(guild,user).monster_bait,undefined);assert.equal(store.balance(guild,user),0);
  const loser='12345678901234579';store.registerAdventure(guild,loser,'Ash');store.adminItem(guild,user,loser,'give','monster_bait',1);const lostGame=store.startHunt(guild,loser,'12345678901234578',{random:()=>0.99});assert.equal(lostGame.monster.name,'Dire Wolf');let lost;for(let i=0;i<40;i++){lost=store.actHunt(guild,loser,lostGame.id,`1234567890123${String(i).padStart(4,'0')}`,'defend');if(lost.done)break;}assert.equal(lost.outcome,'lost');assert.equal(store.inventory(guild,loser).monster_bait,undefined);assert.equal(store.inventory(guild,loser).herb,undefined);assert.equal(store.balance(guild,loser),0);
  store.adminItem(guild,user,user,'give','monster_bait',1);const failedId='12345678901234569';assert.throws(()=>store.startHunt(guild,user,failedId,{random:()=>0}),/ID sesi duplikat/);assert.equal(store.inventory(guild,user).monster_bait,1,'failed session creation leaves bait intact');
  const victory=store.startHunt(guild,user,'12345678901234574',{random:()=>0});for(const id of ['12345678901234575','12345678901234576','12345678901234577']){const result=store.actHunt(guild,user,victory.id,id,'attack');if(result.done)break;}assert.equal(store.inventory(guild,user).slime_gel,2);assert.equal(store.balance(guild,user),12);assert.equal(store.inventory(guild,user).monster_bait,undefined);
});

test('Adventure reward overflow fails atomically without consuming boxes or corrupting inventory', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nightmare-inventory-overflow-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'economy.json'),guild='12345678901234567',user='12345678901234568';const store=createEconomyStore(file);store.registerAdventure(guild,user,'Rin');store.adminItem(guild,user,user,'give','mystery_box',1);
  const data=JSON.parse(fs.readFileSync(file,'utf8'));data.guilds[guild].users[user].inventory.slime_gel=Number.MAX_SAFE_INTEGER-2;fs.writeFileSync(file,JSON.stringify(data));assert.throws(()=>store.openMysteryBox(guild,user,()=>0),/Batas jumlah inventory/);const inventory=store.inventory(guild,user);assert.equal(inventory.mystery_box,1);assert.equal(inventory.slime_gel,Number.MAX_SAFE_INTEGER-2);
});

test('Adventure administrator bypass persists rank/stats/skill points and changes real combat values', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nightmare-adventure-admin-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let time=200_000_000;const file=path.join(dir,'economy.json'),store=createEconomyStore(file,{now:()=>time});const guild='12345678901234567',admin='12345678901234568',target='12345678901234569';store.registerAdventure(guild,target,'Kai');
  assert.equal(store.setAdventureRank(guild,admin,target,'S','12345678901234580').rank,'S');assert.equal(store.setAdventureRank(guild,admin,target,'F','12345678901234580').duplicate,true);assert.equal(store.adventureProfile(guild,target).rank,'S');assert.throws(()=>store.setAdventureRank(guild,admin,target,'Z','12345678901234581'),/rank tidak valid/);
  assert.deepEqual(store.setAdventureStats(guild,admin,target,{attack:100,defense:50,maxHp:500,currentHp:500},'12345678901234582'),{attack:100,defense:50,maxHp:500,currentHp:500});assert.throws(()=>store.setAdventureStats(guild,admin,target,{attack:-1,defense:0,maxHp:100,currentHp:100},'12345678901234583'),/bilangan bulat/);assert.throws(()=>store.setAdventureStats(guild,admin,target,{attack:1,defense:1,maxHp:100,currentHp:101},'12345678901234584'),/tidak boleh melebihi/);
  assert.equal(store.setAdventureSkillPoints(guild,admin,target,'add',12,'12345678901234585').skillPoints,12);assert.equal(store.setAdventureSkillPoints(guild,admin,target,'add',12,'12345678901234585').duplicate,true);assert.equal(store.adventureProfile(guild,target).skillPoints,12);assert.equal(store.setAdventureSkillPoints(guild,admin,target,'set',3,'12345678901234586').skillPoints,3);assert.throws(()=>store.setAdventureSkillPoints(guild,admin,target,'add',-1,'12345678901234587'),/skill point tidak valid/);
  assert.equal(store.setAdventureEnemy(guild,admin,target,'goblin','12345678901234588').monster.name,'Goblin');assert.throws(()=>store.setAdventureEnemy(guild,admin,target,'dragon','12345678901234589'),/tidak tersedia/);const game=store.startHunt(guild,target,'12345678901234570',{random:()=>0});assert.equal(game.enemyId,'goblin');assert.equal(game.monster.hp,114);assert.equal(store.adventureProfile(guild,target).nextEnemyId,undefined);
  const strike=store.actHunt(guild,target,game.id,'12345678901234571','attack');assert.equal(strike.game.monster.hp,17);assert.equal(strike.game.playerHp,499);const win=store.actHunt(guild,target,game.id,'12345678901234572','attack');assert.equal(win.outcome,'won');assert.equal(store.adventureProfile(guild,target).rank,'S','progression cannot overwrite admin override');assert.equal(store.adventureProfile(guild,target).combatAttack,100);assert.equal(store.adventureProfile(guild,target).combatDefense,50);assert.equal(store.adventureProfile(guild,target).hp,499);assert.equal(store.adventureProfile(guild,target).maxHp,500);
  assert.ok(store.history(guild,target).filter(tx=>tx.type==='adventure_hunt').length===1);const data=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(data.guilds[guild].adventureProfiles[target].skillPoints,3);assert.ok(data.guilds[guild].adminAudit.some(entry=>entry.actorId===admin&&entry.action==='adventure_stats_override'));
});

test('admin stat changes and enemy selection reject active-session inconsistencies and unknown targets', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nightmare-adventure-admin-active-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const store=createEconomyStore(path.join(dir,'economy.json'));const guild='12345678901234567',admin='12345678901234568',target='12345678901234569';store.registerAdventure(guild,target,'Kai');store.startHunt(guild,target,'12345678901234570',{random:()=>0});assert.throws(()=>store.setAdventureStats(guild,admin,target,{attack:1,defense:1,maxHp:100,currentHp:100},'12345678901234572'),/sesi hunting aktif/);assert.throws(()=>store.setAdventureEnemy(guild,admin,target,'goblin','12345678901234573'),/sesi hunting aktif/);assert.throws(()=>store.setAdventureRank(guild,admin,'12345678901234571','A','12345678901234574'),/belum memiliki profil/);
});

test('Adventure skills spend points once, enforce ranks/prerequisites, persist and alter real combat calculations', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nightmare-skills-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let time=300_000_000;const file=path.join(dir,'economy.json'),store=createEconomyStore(file,{now:()=>time});const guild='12345678901234567',admin='12345678901234568',user='12345678901234569';store.registerAdventure(guild,user,'Rin');
  assert.throws(()=>store.learnAdventureSkill(guild,user,'flame_burst','12345678901234572'),/rank D/);assert.throws(()=>store.learnAdventureSkill(guild,user,'not_a_skill','12345678901234573'),/tidak valid/);
  store.setAdventureSkillPoints(guild,admin,user,'set',30,'12345678901234570');store.setAdventureRank(guild,admin,user,'B','12345678901234571');
  assert.throws(()=>store.learnAdventureSkill(guild,user,'critical_eye','12345678901234574'),/Prasyarat/);const mastery=store.learnAdventureSkill(guild,user,'weapon_mastery','12345678901234575');assert.equal(mastery.skillPoints,29);assert.equal(store.learnAdventureSkill(guild,user,'weapon_mastery','12345678901234575').duplicate,true);assert.throws(()=>store.learnAdventureSkill(guild,user,'weapon_mastery','12345678901234576'),/sudah dipelajari/);
  assert.equal(store.upgradeAdventureSkill(guild,user,'weapon_mastery','12345678901234577').level,2);store.setAdventureSkillPoints(guild,admin,user,'set',1,'12345678901234590');assert.throws(()=>store.upgradeAdventureSkill(guild,user,'weapon_mastery','12345678901234578'),/tidak cukup/);
  store.setAdventureSkillPoints(guild,admin,user,'set',30,'12345678901234591');store.learnAdventureSkill(guild,user,'critical_eye','12345678901234592');store.learnAdventureSkill(guild,user,'vitality','12345678901234593');store.learnAdventureSkill(guild,user,'iron_guard','12345678901234594');store.learnAdventureSkill(guild,user,'arcane_slash','12345678901234595');store.learnAdventureSkill(guild,user,'flame_burst','12345678901234596');store.upgradeAdventureSkill(guild,user,'flame_burst','12345678901234597');store.learnAdventureSkill(guild,user,'crescent_nova','12345678901234598');
  let profile=store.adventureProfile(guild,user);assert.equal(profile.combatAttack,14);assert.equal(profile.effectiveMaxHp,110);assert.equal(profile.skillBonuses.mitigation,1);const restarted=createEconomyStore(file,{now:()=>time});assert.equal(restarted.adventureProfile(guild,user).skills.crescent_nova,1);
  restarted.setAdventureEnemy(guild,admin,user,'goblin','12345678901234573');const game=restarted.startHunt(guild,user,'12345678901234574',{random:()=>0});assert.equal(game.playerMaxHp,110);assert.equal(game.enemyId,'goblin');
  const normal = createEconomyStore(path.join(dir,'normal.json'),{now:()=>time});normal.registerAdventure(guild,'12345678901234575','Plain');normal.setAdventureEnemy(guild,admin,'12345678901234575','goblin','12345678901234576');const plainGame=normal.startHunt(guild,'12345678901234575','12345678901234577',{random:()=>0});const plainHit=normal.actHunt(guild,'12345678901234575',plainGame.id,'12345678901234578','attack',null,()=>0.99);const cast=restarted.actHunt(guild,user,game.id,'12345678901234579','skill','arcane_slash',()=>0.99);assert.equal(cast.game.monster.hp,game.monster.maxHp-18,'Arcane Slash uses trained/equipment attack and its level multiplier');assert.equal(cast.game.playerHp,76,'rank-scaled Goblin deals 24 damage after Iron Guard mitigation');assert.equal(plainHit.game.playerHp,95,'untrained F-rank profile receives 5 damage');
  assert.equal(restarted.actHunt(guild,'12345678901234580',game.id,'12345678901234581','skill','arcane_slash').reason,'owner');
});

test('Adventure critical and ultimate effects run in combat once per session; expired, foreign and duplicate casts are rejected', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nightmare-skill-cast-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let time=400_000_000;const store=createEconomyStore(path.join(dir,'economy.json'),{now:()=>time});const guild='12345678901234567',admin='12345678901234568',user='12345678901234569';store.registerAdventure(guild,user,'Rin');store.setAdventureRank(guild,admin,user,'B','12345678901234570');store.setAdventureSkillPoints(guild,admin,user,'set',20,'12345678901234571');for(const id of ['weapon_mastery','critical_eye','arcane_slash','flame_burst','crescent_nova'])store.setAdventureSkill(guild,admin,user,id,id==='flame_burst'?2:1,`123456789012345${String(72+['weapon_mastery','critical_eye','arcane_slash','flame_burst','crescent_nova'].indexOf(id)).padStart(2,'0')}`);
  store.setAdventureEnemy(guild,admin,user,'dire_wolf','12345678901234580');const game=store.startHunt(guild,user,'12345678901234581',{random:()=>0});const foreign=store.actHunt(guild,'12345678901234582',game.id,'12345678901234583','skill','crescent_nova');assert.equal(foreign.reason,'owner');const wrongGuild=store.actHunt('12345678901234584',user,game.id,'12345678901234585','skill','crescent_nova');assert.equal(wrongGuild.reason,'missing');
  const critical=store.actHunt(guild,user,game.id,'12345678901234586','attack',null,()=>0);assert.match(critical.message,/Critical/);assert.equal(critical.game.monster.hp,game.monster.maxHp-12,'Critical Eye multiplies the actual attack damage');const ultimate=store.actHunt(guild,user,game.id,'12345678901234587','skill','crescent_nova',()=>0.99);assert.equal(ultimate.reason,'ok');assert.equal(ultimate.game.monster.hp,critical.game.monster.hp-32,'Crescent Nova applies 3× ATK against monster defense');assert.throws(()=>store.actHunt(guild,user,game.id,'12345678901234588','skill','crescent_nova'),/sudah digunakan/);assert.equal(store.actHunt(guild,user,game.id,'12345678901234587','skill','crescent_nova').reason,'duplicate');
  time+=300_001;const expired=store.startHunt(guild,user,'12345678901234589',{random:()=>0});time+=300_001;assert.equal(store.actHunt(guild,user,expired.id,'12345678901234590','skill','arcane_slash').reason,'expired');
});

test('Adventure quest, rank progression, equipment, potion and Mystery Box use shared inventory atomically', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nightmare-rpg-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const store=createEconomyStore(path.join(dir,'economy.json'),{now:()=>200_000_000});const guild='12345678901234567',user='12345678901234568';store.registerAdventure(guild,user,'Mira');
  assert.throws(()=>store.equip(guild,user,'iron_sword','weapon'),/tidak dimiliki/);store.adminItem(guild,user,user,'give','iron_sword',1);assert.equal(store.equip(guild,user,'iron_sword','weapon').item.id,'iron_sword');assert.equal(store.adventureProfile(guild,user).combatAttack,15);assert.equal(store.inventory(guild,user).iron_sword,undefined);assert.equal(store.equip(guild,user,null,'weapon',true).unequipped,true);assert.equal(store.inventory(guild,user).iron_sword,1);
  store.adminItem(guild,user,user,'give','health_potion',1);store.adminItem(guild,user,user,'give','mystery_box',1);assert.throws(()=>store.usePotion(guild,user,'health_potion'),/HP sudah penuh/);assert.equal(store.inventory(guild,user).health_potion,1);const box=store.openMysteryBox(guild,user,()=>0);assert.equal(box.item.id,'slime_gel');assert.equal(store.inventory(guild,user).mystery_box,undefined);assert.throws(()=>store.openMysteryBox(guild,user),/tidak dimiliki/);
  const profile=store.adventureProfile(guild,user);assert.equal(profile.rank,'F');assert.throws(()=>store.equip(guild,user,'dragon_armor','armor'),/Memerlukan rank S/);
  const dayStore=createEconomyStore(path.join(dir,'quest.json'),{now:()=>200_000_000});dayStore.registerAdventure(guild,user,'Mira');for(let i=0;i<3;i++){let id=`1234567890123457${i}`;let game=dayStore.startHunt(guild,user,id,{random:()=>0});for(let j=0;j<5;j++){const action=`123456789012345${i}${j}`;const r=dayStore.actHunt(guild,user,game.id,action,'attack');if(r.done)break;}}
  const quest=dayStore.quest(guild,user);assert.equal(quest.claimed,true);assert.equal(quest.skillPoints,1);assert.equal(dayStore.quest(guild,user).claimed,false);assert.equal(dayStore.balance(guild,user),111);assert.equal(dayStore.adventureProfile(guild,user).rank,'E');assert.equal(dayStore.adventureProfile(guild,user).skillPoints,1);
});

test('economy game entry atomically validates stake, debits the shared wallet and rejects duplicate games', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightmare-economy-games-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let time = 100_000_000; const store = createEconomyStore(path.join(dir, 'economy.json'), { now: () => time });
  const guildId = '12345678901234567', userId = '12345678901234568';
  store.daily(guildId, userId, 50);
  const game = store.startGame({ guildId, userId, gameId: '12345678901234569', type: 'guess', entryFee: 20, payload: { target: 5 }, expiresAt: time + 60_000 });
  assert.equal(game.balance, 30);
  assert.equal(store.history(guildId, userId).filter(tx => tx.type === 'game_entry').length, 1);
  assert.throws(() => store.startGame({ guildId, userId, gameId: '12345678901234570', type: 'guess', entryFee: 40, payload: {}, expiresAt: time + 60_000 }), /Insufficient/);
  assert.throws(() => store.startGame({ guildId, userId, gameId: '12345678901234571', type: 'guess', entryFee: 0, payload: {}, expiresAt: time + 60_000 }), /cooldown/);
  assert.equal(store.balance(guildId, userId), 30, 'failed entry fee cannot partially debit wallet');
  assert.throws(() => store.startGame({ guildId, userId, gameId: '12345678901234569', type: 'guess', entryFee: 0, payload: {}, expiresAt: time + 60_000 }), /already exists/);
});

test('game settlement pays at most once under duplicate and concurrent interactions', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightmare-game-settle-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let time = 100_000_000; const store = createEconomyStore(path.join(dir, 'economy.json'), { now: () => time });
  const guildId = '12345678901234567', userId = '12345678901234568'; store.daily(guildId, userId, 1000);
  const gameId = '12345678901234569';
  store.startGame({ guildId, userId, gameId, type: 'trivia', entryFee: 100, payload: {}, expiresAt: time + 60_000 });
  const apply = game => ({ game: { ...game, payload: { solved: true } }, done: true, payout: 200, outcome: 'won' });
  const results = [store.actGame({ guildId, userId, gameId, actionId: '12345678901234570', apply }), store.actGame({ guildId, userId, gameId, actionId: '12345678901234571', apply })];
  assert.equal(results.filter(result => result.reason === 'ok' && result.payout === 200).length, 1);
  assert.equal(results.filter(result => result.reason === 'ended').length, 1);
  assert.equal(store.balance(guildId, userId), 1100);
  assert.equal(store.history(guildId, userId).filter(tx => tx.type === 'game_reward').length, 1);
  assert.equal(store.actGame({ guildId, userId, gameId, actionId: '12345678901234570', apply }).reason, 'duplicate');
});

test('simultaneous games share one economy file without cross-player lost updates', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightmare-concurrent-games-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let time = 100_000_000; const store = createEconomyStore(path.join(dir, 'economy.json'), { now: () => time, gameCooldownMs: 0 });
  const guildId = '12345678901234567', a = '12345678901234568', b = '12345678901234569';
  store.daily(guildId, a, 100); store.daily(guildId, b, 100);
  const starts = [
    store.startGame({ guildId, userId: a, gameId: '12345678901234570', type: 'guess', entryFee: 60, payload: {}, expiresAt: time + 60_000 }),
    store.startGame({ guildId, userId: b, gameId: '12345678901234571', type: 'trivia', entryFee: 60, payload: {}, expiresAt: time + 60_000 })
  ];
  assert.equal(starts.length, 2);
  assert.equal(store.balance(guildId, a), 40); assert.equal(store.balance(guildId, b), 40);
  assert.equal(store.history(guildId, a).filter(tx => tx.type === 'game_entry').length, 1);
  assert.equal(store.history(guildId, b).filter(tx => tx.type === 'game_entry').length, 1);
});

test('expired games cannot pay and invalid game results leave balances unchanged', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightmare-game-expiry-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let time = 100_000_000; const store = createEconomyStore(path.join(dir, 'economy.json'), { now: () => time });
  const guildId = '12345678901234567', userId = '12345678901234568'; store.daily(guildId, userId, 50);
  const gameId = '12345678901234569'; store.startGame({ guildId, userId, gameId, type: 'guess', entryFee: 10, payload: {}, expiresAt: time + 1 });
  assert.throws(() => store.actGame({ guildId, userId, gameId, actionId: '12345678901234570', apply: game => ({ game, done: true, payout: -1 }) }), /Invalid game payout/);
  time += 1;
  assert.equal(store.actGame({ guildId, userId, gameId, actionId: '12345678901234571', apply: game => ({ game, done: true, payout: 100 }) }).reason, 'expired');
  assert.equal(store.balance(guildId, userId), 40);
});

test('giveaway entries persist and finish exactly once with unique winners', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightmare-giveaway-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let time = 1_000; const file = path.join(dir, 'giveaways.json'); const store = createGiveawayStore(file, { now: () => time });
  const g = { guildId: '12345678901234567', channelId: '12345678901234568', messageId: '12345678901234569', hostId: '12345678901234570', prize: 'Prize', endsAt: 2_000, winnerCount: 2 };
  store.create(g); assert.equal(store.enter(g.messageId, '12345678901234571'), true); assert.equal(store.enter(g.messageId, '12345678901234571'), false);
  store.enter(g.messageId, '12345678901234572'); store.enter(g.messageId, '12345678901234573');
  time = 2_000; assert.equal(store.due().length, 1);
  const result = store.finish(g.messageId, max => max - 1); assert.equal(result.winners.length, 2); assert.equal(new Set(result.winners).size, 2);
  assert.equal(store.finish(g.messageId), null);
});

test('giveaway winner selection and limiter enforce bounds', () => {
  assert.deepEqual(pickWinners(['a', 'a', 'b'], 3, max => 0), ['a', 'b']);
  let time = 0; const allowed = createRateLimiter({ windowMs: 100, max: 2, now: () => time });
  assert.equal(allowed('g:u'), true); assert.equal(allowed('g:u'), true); assert.equal(allowed('g:u'), false);
  time = 100; assert.equal(allowed('g:u'), true);
});

test('ticket store persists configuration, prevents duplicate open tickets, and permits close/reopen', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightmare-ticket-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let time = 100; const file = path.join(dir, 'tickets.json'); const store = createTicketStore(file, { now: () => time });
  const guildId = '12345678901234567', userId = '12345678901234568', channelId = '12345678901234569';
  store.configure(guildId, { staffRoleId: '12345678901234570' });
  store.create({ guildId, userId, channelId });
  assert.throws(() => store.create({ guildId, userId, channelId: '12345678901234571' }), /already|terbuka/);
  time = 200; assert.equal(store.setStatus(guildId, channelId, 'closed').closedAt, 200);
  const reopened = createTicketStore(file, { now: () => time });
  assert.equal(reopened.getByChannel(guildId, channelId).status, 'closed');
  assert.equal(reopened.setStatus(guildId, channelId, 'open').status, 'open');
});
