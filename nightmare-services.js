'use strict';

// Small persistent primitives for the optional Nightmare feature modules.
// Each service uses its own JSON file; existing XP/music data is never migrated.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomInt } = require('node:crypto');
const { ITEMS, getItem, normalizeInventory, RANKS } = require('./economy-catalog');
const { RECIPES } = require('./adventure-recipes');
const { MONSTERS, getMonster } = require('./adventure-monsters');
const { SKILLS, getSkill, parseRequirement } = require('./adventure-skills');

function rankForProgress(profile) { const thresholds = [0, 100, 250, 500, 900, 1500, 2400]; let rank = 'F'; for (let i = 0; i < thresholds.length; i++) if (profile.exp >= thresholds[i] && (i === 0 || profile.hunts >= i * 3 && profile.completedQuests >= i - 1)) rank = RANKS[i]; return rank; }
function equipmentStats(profile) { const out = { attack: 0, defense: 0, magic: 0, mitigation: 0 }; for (const id of Object.values(profile.equipment || {})) { const item = getItem(id); for (const key of Object.keys(out)) out[key] += item?.effects?.[key] || 0; } return out; }
function addInventory(accountValue, itemId, amount) { const current = accountValue.inventory[itemId] || 0; if (!Number.isSafeInteger(amount) || amount < 1 || current > Number.MAX_SAFE_INTEGER - amount) throw new Error('Batas jumlah inventory terlampaui.'); accountValue.inventory[itemId] = current + amount; }
function learnedSkills(profile) { if (profile.skills == null) profile.skills = {}; if (typeof profile.skills !== 'object' || Array.isArray(profile.skills)) throw new Error('Data skill tersimpan tidak valid.'); for (const [id, level] of Object.entries(profile.skills)) { const skill = getSkill(id); if (!skill || !Number.isSafeInteger(level) || level < 1 || level > skill.maxLevel) throw new Error('Level skill tersimpan tidak valid.'); } return profile.skills; }
function skillLevel(profile, skillId) { return learnedSkills(profile)[skillId] || 0; }
function skillBonuses(profile) {
  const out = { attack: 0, maxHp: 0, mitigation: 0, critChance: 0 };
  for (const skill of SKILLS) { const level = skillLevel(profile, skill.id); if (skill.type !== 'passive' || !level) continue; for (const [key, value] of Object.entries(skill.effect)) out[key] += value * level; }
  out.critChance = Math.min(0.5, out.critChance); return out;
}
function awardRankSkillPoints(profile, oldRank) {
  if (profile.rankOverride) return 0;
  const gained = Math.max(0, RANKS.indexOf(profile.rank) - RANKS.indexOf(oldRank));
  if (gained) { const current = profile.skillPoints || 0; if (!Number.isSafeInteger(current) || current > 1_000_000 - gained) throw new Error('Batas skill point terlampaui.'); profile.skillPoints = current + gained; }
  return gained;
}

function createJsonStore(filePath, initial = {}) {
  function read() {
    let raw;
    try { raw = fs.readFileSync(filePath, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return structuredClone(initial); throw error; }
    try {
      const value = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('root must be an object');
      return value;
    } catch (error) { throw new Error(`Invalid JSON data at ${filePath}; preserving file: ${error.message}`); }
  }
  function write(data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temp = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
    try { fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, filePath); }
    finally { try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
  return { read, write };
}

function createEconomyStore(filePath, { now = Date.now, gameCooldownMs = 15_000 } = {}) {
  if (!Number.isSafeInteger(gameCooldownMs) || gameCooldownMs < 0) throw new Error('Invalid game cooldown');
  const store = createJsonStore(filePath, { version: 1, guilds: {} });
  function mutate(guildId, fn) {
    if (!/^\d{17,20}$/.test(guildId || '')) throw new Error('Invalid guild ID');
    const data = store.read();
    if (data.version !== 1 || !data.guilds || typeof data.guilds !== 'object') throw new Error('Invalid economy data');
    const guild = data.guilds[guildId] ||= { users: {}, transactions: [] };
    const result = fn(guild);
    store.write(data);
    return result;
  }
  function account(g, userId) {
    if (!/^\d{17,20}$/.test(userId || '')) throw new Error('Invalid user ID');
    const value = g.users[userId] ||= { balance: 0, inventory: {}, lastDailyAt: 0 };
    if (!Number.isSafeInteger(value.balance) || value.balance < 0 || !Number.isSafeInteger(value.lastDailyAt) || value.lastDailyAt < 0 || !value.inventory || typeof value.inventory !== 'object' || Array.isArray(value.inventory)) throw new Error('Invalid persisted economy account; data was not changed');
    value.inventory = normalizeInventory(value.inventory);
    return value;
  }
  function transact(g, type, from, to, amount) {
    if (!Number.isSafeInteger(amount) || amount < 1) throw new Error('Amount must be a positive safe integer');
    if (from) { const a = account(g, from); if (a.balance < amount) throw new Error('Insufficient balance'); a.balance -= amount; }
    if (to) { const a = account(g, to); if (a.balance > Number.MAX_SAFE_INTEGER - amount) throw new Error('Balance limit exceeded'); a.balance += amount; }
    g.transactions.push({ id: randomUUID(), type, from, to, amount, at: now() });
    if (g.transactions.length > 500) g.transactions.splice(0, g.transactions.length - 500);
  }
  function ensureEconomyGuild(data, guildId) {
    const guild = data.guilds[guildId] ||= { users: {}, transactions: [] };
    guild.games ||= {};
    guild.shopPrices ||= {};
    guild.adminAudit ||= [];
    return guild;
  }
  function validQuantity(amount) { if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1000) throw new Error('Jumlah harus bilangan bulat 1–1000.'); }
  function rankFor(guild, userId) { return guild.adventureProfiles?.[userId]?.rank || 'F'; }
  function priceFor(guild, item) { return guild.shopPrices?.[item.id] ?? item.price; }
  function audit(guild, { actorId, targetId, action, before, after }) {
    guild.adminAudit ||= [];
    guild.adminAudit.push({ id: randomUUID(), actorId, targetId, action, before, after, at: now() });
    if (guild.adminAudit.length > 500) guild.adminAudit.splice(0, guild.adminAudit.length - 500);
  }
  function adminActionSeen(guild, interactionId) {
    const cutoff = now() - 86_400_000;
    guild.adventureAdminActions = (guild.adventureAdminActions || []).filter(entry => entry && Number.isSafeInteger(entry.at) && entry.at >= cutoff);
    return guild.adventureAdminActions.some(entry => entry.interactionId === interactionId);
  }
  function rememberAdminAction(guild, interactionId) {
    guild.adventureAdminActions.push({ interactionId, at: now() });
    if (guild.adventureAdminActions.length > 5_000) guild.adventureAdminActions.splice(0, guild.adventureAdminActions.length - 5_000);
  }
  function skillActionSeen(guild, interactionId) { const cutoff = now() - 86_400_000; guild.adventureSkillActions = (guild.adventureSkillActions || []).filter(x => x.at >= cutoff); return guild.adventureSkillActions.some(x => x.id === interactionId); }
  function rememberSkillAction(guild, interactionId) { guild.adventureSkillActions.push({ id: interactionId, at: now() }); if (guild.adventureSkillActions.length > 5000) guild.adventureSkillActions.splice(0, guild.adventureSkillActions.length - 5000); }
  return {
    balance: (guildId, userId) => { const g = store.read().guilds[guildId]; return g?.users?.[userId]?.balance || 0; },
    daily(guildId, userId, reward = 100, cooldownMs = 86_400_000) { return mutate(guildId, g => {
      const a = account(g, userId); const current = now();
      if (current - a.lastDailyAt < cooldownMs) return { claimed: false, nextAt: a.lastDailyAt + cooldownMs, balance: a.balance };
      transact(g, 'daily', null, userId, reward); a.lastDailyAt = current;
      return { claimed: true, balance: a.balance };
    }); },
    transfer(guildId, fromId, toId, amount) { if (fromId === toId) throw new Error('Cannot transfer to yourself'); return mutate(guildId, g => { transact(g, 'transfer', fromId, toId, amount); return { balance: account(g, fromId).balance }; }); },
    purchase(guildId, userId, item, price) { if (!/^[\w -]{1,40}$/.test(item)) throw new Error('Invalid item'); return mutate(guildId, g => { transact(g, 'purchase', userId, null, price); const a = account(g, userId); a.inventory[item] = (a.inventory[item] || 0) + 1; return { balance: a.balance, quantity: a.inventory[item] }; }); },
    startGame({ guildId, userId, gameId, type, entryFee = 0, payload, expiresAt }) {
      if (!/^\d{17,20}$/.test(gameId || '') || !/^[a-z][a-z0-9_-]{1,24}$/.test(type || '') || !Number.isSafeInteger(entryFee) || entryFee < 0 || entryFee > 1000 || !Number.isSafeInteger(expiresAt) || expiresAt <= now()) throw new Error('Invalid game setup');
      return mutate(guildId, data => {
        const guild = ensureEconomyGuild({ guilds: { [guildId]: data } }, guildId);
        if (guild.games[gameId]) throw new Error('Game already exists');
        for (const game of Object.values(guild.games)) if (game.status === 'active' && game.expiresAt <= now()) { game.status = 'expired'; game.endedAt = now(); }
        const active = Object.values(guild.games).filter(game => game.userId === userId && game.status === 'active' && game.expiresAt > now());
        if (active.length >= 3) throw new Error('Too many active games');
        const player = account(guild, userId);
        if (player.balance < entryFee) throw new Error('Insufficient balance');
        guild.gameCooldowns ||= {};
        const nextGameAt = (guild.gameCooldowns[userId] || 0) + gameCooldownMs;
        if (now() < nextGameAt) throw new Error(`Game cooldown active; retry after ${Math.ceil((nextGameAt - now()) / 1000)} seconds.`);
        if (entryFee > 0) transact(guild, 'game_entry', userId, null, entryFee);
        guild.gameCooldowns[userId] = now();
        const game = { id: gameId, guildId, userId, type, entryFee, payload: structuredClone(payload), status: 'active', createdAt: now(), expiresAt, actionIds: [] };
        guild.games[gameId] = game;
        return { game: structuredClone(game), balance: player.balance };
      });
    },
    getGame(guildId, gameId) { const game = store.read().guilds[guildId]?.games?.[gameId]; return game ? structuredClone(game) : null; },
    actGame({ guildId, userId, gameId, actionId, apply }) {
      if (!/^\d{17,20}$/.test(actionId || '') || typeof apply !== 'function') throw new Error('Invalid game action');
      return mutate(guildId, rawGuild => {
        const guild = ensureEconomyGuild({ guilds: { [guildId]: rawGuild } }, guildId);
        const current = guild.games[gameId];
        if (!current) return { reason: 'missing' };
        if (current.userId !== userId) return { reason: 'owner' };
        if (current.actionIds?.includes(actionId)) return { reason: 'duplicate' };
        if (current.status !== 'active') return { reason: 'ended', game: structuredClone(current) };
        if (current.expiresAt <= now()) {
          current.status = 'expired'; current.endedAt = now();
          current.actionIds = [...(current.actionIds || []), actionId].slice(-20);
          return { reason: 'expired', game: structuredClone(current) };
        }
        const transition = apply(structuredClone(current));
        if (!transition || !transition.game || typeof transition.done !== 'boolean') throw new Error('Invalid game transition');
        const updated = { ...transition.game, actionIds: [...(current.actionIds || []), actionId].slice(-20) };
        let balance = account(guild, userId).balance;
        if (transition.done) {
          const payout = transition.payout ?? 0;
          if (!Number.isSafeInteger(payout) || payout < 0) throw new Error('Invalid game payout');
          if (payout > 0) transact(guild, 'game_reward', null, userId, payout);
          updated.status = 'completed'; updated.endedAt = now(); updated.outcome = transition.outcome || 'completed'; updated.payout = payout;
          balance = account(guild, userId).balance;
        } else updated.status = 'active';
        guild.games[gameId] = updated;
        return { reason: 'ok', done: transition.done, game: structuredClone(updated), balance, payout: transition.done ? updated.payout : 0, outcome: transition.done ? updated.outcome : null, response: transition.response };
      });
    },
    catalog: () => ITEMS.map(item => ({ ...item, effects: { ...item.effects } })),
    itemPrice(guildId, itemId) { const item = getItem(itemId); if (!item) throw new Error('Item tidak ditemukan.'); return store.read().guilds[guildId]?.shopPrices?.[item.id] ?? item.price; },
    purchaseCatalog(guildId, userId, itemId, quantity = 1) {
      validQuantity(quantity); const item = getItem(itemId); if (!item) throw new Error('Item tidak tersedia di katalog.');
      return mutate(guildId, raw => { const g = ensureEconomyGuild({ guilds: { [guildId]: raw } }, guildId); const rank = rankFor(g, userId); if (RANKS.indexOf(rank) < RANKS.indexOf(item.requiredRank)) throw new Error(`Item ini memerlukan rank ${item.requiredRank}.`); const unitPrice = priceFor(g, item); if (!Number.isSafeInteger(unitPrice) || unitPrice < 1 || unitPrice > 1_000_000) throw new Error('Harga item server tidak valid.'); const total = unitPrice * quantity; if (!Number.isSafeInteger(total) || total < 1) throw new Error('Total harga tidak valid.'); const a = account(g, userId); const nextCount = (a.inventory[item.id] || 0) + quantity; if (!Number.isSafeInteger(nextCount)) throw new Error('Batas jumlah inventory terlampaui.'); transact(g, 'shop_purchase', userId, null, total); a.inventory[item.id] = nextCount; return { balance: a.balance, quantity: nextCount, item, total }; });
    },
    sell(guildId, userId, itemId, quantity = 1) {
      validQuantity(quantity); const item = getItem(itemId); if (!item || item.sellPrice <= 0) throw new Error('Item ini tidak dapat dijual.');
      return mutate(guildId, raw => { const g = ensureEconomyGuild({ guilds: { [guildId]: raw } }, guildId); const a = account(g, userId); const owned = a.inventory[item.id] || 0; if (owned < quantity) throw new Error(`Inventory tidak cukup (dimiliki ${owned}).`); const total = item.sellPrice * quantity; if (!Number.isSafeInteger(total) || total < 1) throw new Error('Total penjualan tidak valid.'); a.inventory[item.id] -= quantity; if (!a.inventory[item.id]) delete a.inventory[item.id]; transact(g, 'shop_sale', null, userId, total); return { balance: a.balance, quantity: a.inventory[item.id] || 0, item, total }; });
    },
    configurePrice(guildId, actorId, itemId, price) {
      const item = getItem(itemId); if (!item || !Number.isSafeInteger(price) || price < 1 || price > 1_000_000) throw new Error('Item atau harga tidak valid.');
      return mutate(guildId, raw => { const g = ensureEconomyGuild({ guilds: { [guildId]: raw } }, guildId); const before = priceFor(g, item); g.shopPrices[item.id] = price; audit(g, { actorId, targetId: null, action: 'shop_price', before: { itemId: item.id, price: before }, after: { itemId: item.id, price } }); return { item, before, price }; });
    },
    adminAdjust(guildId, actorId, targetId, operation, amount) {
      if (!['add', 'remove', 'reset'].includes(operation) || (operation !== 'reset' && (!Number.isSafeInteger(amount) || amount < 1 || amount > 1_000_000))) throw new Error('Operasi admin atau jumlah tidak valid.');
      return mutate(guildId, raw => { const g = ensureEconomyGuild({ guilds: { [guildId]: raw } }, guildId); const a = account(g, targetId); const before = a.balance; if (operation === 'reset') a.balance = 0; else if (operation === 'add') { if (before > Number.MAX_SAFE_INTEGER - amount) throw new Error('Batas saldo terlampaui.'); a.balance += amount; } else { if (before < amount) throw new Error('Saldo target tidak cukup.'); a.balance -= amount; } audit(g, { actorId, targetId, action: `balance_${operation}`, before, after: a.balance }); g.transactions.push({ id: randomUUID(), type: `admin_${operation}`, from: operation === 'remove' ? targetId : null, to: operation === 'add' ? targetId : null, amount: operation === 'reset' ? before : amount, at: now(), actorId }); if (g.transactions.length > 500) g.transactions.splice(0, g.transactions.length - 500); return { before, balance: a.balance }; });
    },
    adminItem(guildId, actorId, targetId, operation, itemId, quantity) {
      const item = getItem(itemId); validQuantity(quantity); if (!item || !['give', 'remove'].includes(operation)) throw new Error('Item atau operasi tidak valid.');
      return mutate(guildId, raw => { const g = ensureEconomyGuild({ guilds: { [guildId]: raw } }, guildId); const a = account(g, targetId); const before = a.inventory[item.id] || 0; if (operation === 'remove' && before < quantity) throw new Error('Item target tidak cukup.'); const after = operation === 'give' ? before + quantity : before - quantity; if (!Number.isSafeInteger(after)) throw new Error('Batas jumlah item terlampaui.'); if (after) a.inventory[item.id] = after; else delete a.inventory[item.id]; audit(g, { actorId, targetId, action: `item_${operation}`, before: { itemId: item.id, quantity: before }, after: { itemId: item.id, quantity: after } }); return { item, quantity: after }; });
    },
    registerAdventure(guildId, userId, name) {
      if (!/^\d{17,20}$/.test(userId || '') || typeof name !== 'string' || !name.trim() || name.trim().length > 32) throw new Error('ID pengguna atau nama petualang tidak valid.');
      return mutate(guildId, raw => { const g = ensureEconomyGuild({ guilds: { [guildId]: raw } }, guildId); g.adventureProfiles ||= {}; if (g.adventureProfiles[userId]) return { created: false, profile: { ...g.adventureProfiles[userId] } }; account(g, userId); const profile = { userId, name: name.trim(), rank: 'F', rankOverride: false, exp: 0, hp: 100, maxHp: 100, baseAttack: 10, baseDefense: 5, skillPoints: 0, hunts: 0, completedQuests: 0, equipment: { weapon: null, armor: null, accessory: null }, createdAt: now() }; g.adventureProfiles[userId] = profile; return { created: true, profile: { ...profile, equipment: { ...profile.equipment } } }; });
    },
    adventureProfile(guildId, userId) { const data = store.read(); const g = data.guilds[guildId]; const profile = g?.adventureProfiles?.[userId]; if (!profile) return null; const equipment = { ...profile.equipment }; const bonuses = equipmentStats(profile), trained = skillBonuses(profile); return { ...profile, skillPoints: profile.skillPoints || 0, skills: { ...(profile.skills || {}) }, equipment, bonuses, skillBonuses: trained, effectiveMaxHp: profile.maxHp + trained.maxHp, combatAttack: profile.baseAttack + bonuses.attack + Math.floor(bonuses.magic / 2) + trained.attack, combatDefense: profile.baseDefense + bonuses.defense, balance: g.users?.[userId]?.balance || 0, inventory: normalizeInventory(g.users?.[userId]?.inventory || {}) }; },
    listAdventureSkills(guildId, userId) { const p = store.read().guilds[guildId]?.adventureProfiles?.[userId]; if (!p) throw new Error('Daftar melalui /adventure register terlebih dahulu.'); const levels = learnedSkills(p); return SKILLS.map(skill => { const req = parseRequirement(skill.requires); return { ...skill, effect: { ...skill.effect }, level: levels[skill.id] || 0, skillPoints: p.skillPoints || 0, unlocked: RANKS.indexOf(p.rank) >= RANKS.indexOf(skill.rank) && (!req || (levels[req.id] || 0) >= req.level), prerequisiteLevel: req ? levels[req.id] || 0 : null }; }); },
    learnAdventureSkill(guildId, userId, skillId, interactionId) { const skill = getSkill(skillId); if (!skill || !/^\d{17,20}$/.test(interactionId || '')) throw new Error('Skill atau ID interaksi tidak valid.'); return mutate(guildId, raw => { const g = ensureEconomyGuild({ guilds: { [guildId]: raw } }, guildId); if (skillActionSeen(g, interactionId)) return { duplicate: true }; const p = g.adventureProfiles?.[userId]; if (!p) throw new Error('Daftar melalui /adventure register terlebih dahulu.'); if (Object.values(g.adventureGames || {}).some(game => game.userId === userId && game.status === 'active' && game.expiresAt > now())) throw new Error('Skill tidak dapat dipelajari selama sesi hunting aktif.'); const levels = learnedSkills(p), current = levels[skill.id] || 0, req = parseRequirement(skill.requires); if (current) throw new Error('Skill sudah dipelajari; gunakan upgrade.'); if (RANKS.indexOf(p.rank) < RANKS.indexOf(skill.rank)) throw new Error(`Skill ini memerlukan rank ${skill.rank}.`); if (req && (levels[req.id] || 0) < req.level) throw new Error(`Prasyarat: ${getSkill(req.id).name} level ${req.level}.`); const points = p.skillPoints || 0; if (!Number.isSafeInteger(points) || points < skill.cost) throw new Error(`Skill point tidak cukup (${points}/${skill.cost}).`); p.skillPoints = points - skill.cost; levels[skill.id] = 1; rememberSkillAction(g, interactionId); return { skill, level: 1, cost: skill.cost, skillPoints: p.skillPoints }; }); },
    upgradeAdventureSkill(guildId, userId, skillId, interactionId) { const skill = getSkill(skillId); if (!skill || !/^\d{17,20}$/.test(interactionId || '')) throw new Error('Skill atau ID interaksi tidak valid.'); return mutate(guildId, raw => { const g = ensureEconomyGuild({ guilds: { [guildId]: raw } }, guildId); if (skillActionSeen(g, interactionId)) return { duplicate: true }; const p = g.adventureProfiles?.[userId]; if (!p) throw new Error('Daftar melalui /adventure register terlebih dahulu.'); if (Object.values(g.adventureGames || {}).some(game => game.userId === userId && game.status === 'active' && game.expiresAt > now())) throw new Error('Skill tidak dapat ditingkatkan selama sesi hunting aktif.'); const levels = learnedSkills(p), current = levels[skill.id] || 0, req = parseRequirement(skill.requires); if (!current) throw new Error('Pelajari skill terlebih dahulu.'); if (current >= skill.maxLevel) throw new Error('Skill sudah mencapai level maksimum.'); if (RANKS.indexOf(p.rank) < RANKS.indexOf(skill.rank)) throw new Error(`Upgrade memerlukan rank ${skill.rank}.`); if (req && (levels[req.id] || 0) < req.level) throw new Error(`Prasyarat: ${getSkill(req.id).name} level ${req.level}.`); const cost = skill.cost * (current + 1), points = p.skillPoints || 0; if (!Number.isSafeInteger(points) || points < cost) throw new Error(`Skill point tidak cukup (${points}/${cost}).`); p.skillPoints = points - cost; levels[skill.id] = current + 1; rememberSkillAction(g, interactionId); return { skill, level: current + 1, cost, skillPoints: p.skillPoints }; }); },
    setAdventureSkill(guildId, actorId, targetId, skillId, level, interactionId) { const skill = getSkill(skillId); if (!skill || ![guildId, actorId, targetId, interactionId].every(id => /^\d{17,20}$/.test(id || '')) || !Number.isSafeInteger(level) || level < 0 || level > skill.maxLevel) throw new Error('Target, interaksi, skill, atau level tidak valid.'); return mutate(guildId, raw => { const g = ensureEconomyGuild({ guilds: { [guildId]: raw } }, guildId); if (adminActionSeen(g, interactionId)) return { duplicate: true }; const p = g.adventureProfiles?.[targetId]; if (!p) throw new Error('Target belum memiliki profil Adventure.'); if (Object.values(g.adventureGames || {}).some(game => game.userId === targetId && game.status === 'active' && game.expiresAt > now())) throw new Error('Skill target tidak dapat diubah selama sesi hunting aktif.'); const levels = learnedSkills(p), before = levels[skill.id] || 0; if (level) levels[skill.id] = level; else delete levels[skill.id]; audit(g, { actorId, targetId, action: 'adventure_skill_override', before: { skillId, level: before }, after: { skillId, level } }); rememberAdminAction(g, interactionId); return { skill, before, level }; }); },
    recipes: () => Object.entries(RECIPES).map(([itemId, recipe]) => ({ item: getItem(itemId), amount: recipe.amount, materials: { ...recipe.materials } })),
    craft(guildId, userId, itemId, quantity = 1) {
      if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100) throw new Error('Jumlah crafting harus 1–100.');
      const item = getItem(itemId), recipe = RECIPES[item?.id]; if (!item || !recipe) throw new Error('Tidak ada resep untuk item tersebut.');
      return mutate(guildId, raw => { const g = ensureEconomyGuild({ guilds: { [guildId]: raw } }, guildId); const profile = g.adventureProfiles?.[userId]; if (!profile) throw new Error('Daftar melalui /adventure register terlebih dahulu.'); if (RANKS.indexOf(profile.rank) < RANKS.indexOf(item.requiredRank)) throw new Error(`Resep ini memerlukan rank ${item.requiredRank}.`); const a = account(g, userId); const missing = Object.entries(recipe.materials).map(([id, needed]) => ({ id, needed: needed * quantity, owned: a.inventory[id] || 0 })).filter(x => x.owned < x.needed); if (missing.length) throw new Error(`Material kurang: ${missing.map(x => `${getItem(x.id)?.name || x.id} ${x.owned}/${x.needed}`).join(', ')}.`); for (const [id, amount] of Object.entries(recipe.materials)) { a.inventory[id] -= amount * quantity; if (!a.inventory[id]) delete a.inventory[id]; } const output = recipe.amount * quantity; a.inventory[item.id] = (a.inventory[item.id] || 0) + output; if (!Number.isSafeInteger(a.inventory[item.id])) throw new Error('Batas inventory terlampaui.'); return { item, quantity: a.inventory[item.id], crafted: output, consumed: Object.fromEntries(Object.entries(recipe.materials).map(([id, amount]) => [id, amount * quantity])) }; });
    },
    startHunt(guildId, userId, gameId, { ttlMs = 300_000, random = Math.random } = {}) {
      if (!/^\d{17,20}$/.test(gameId || '') || !Number.isSafeInteger(ttlMs) || ttlMs < 10_000 || ttlMs > 900_000) throw new Error('Sesi hunting tidak valid.');
      return mutate(guildId, raw => { const g = ensureEconomyGuild({ guilds: { [guildId]: raw } }, guildId); const p = g.adventureProfiles?.[userId]; if (!p) throw new Error('Daftar melalui /adventure register terlebih dahulu.');
        g.adventureGames ||= {}; for (const [oldId, game] of Object.entries(g.adventureGames)) { if (game.status === 'active' && game.expiresAt <= now()) { game.status = 'expired'; game.endedAt = now(); } if (game.status !== 'active' && Number.isSafeInteger(game.endedAt) && now() - game.endedAt > 86_400_000) delete g.adventureGames[oldId]; }
        if (Object.values(g.adventureGames).some(x => x.userId === userId && x.status === 'active')) throw new Error('Selesaikan sesi hunting aktif terlebih dahulu.');
        const bait = account(g, userId).inventory.monster_bait || 0; const useBait = bait > 0; if (useBait) { account(g, userId).inventory.monster_bait--; if (!account(g, userId).inventory.monster_bait) delete account(g, userId).inventory.monster_bait; }
        const selected = p.nextEnemyId ? getMonster(p.nextEnemyId) : null;
        if (p.nextEnemyId && !selected) throw new Error('Musuh pilihan admin tidak valid; data tidak diubah.');
        const m = selected || MONSTERS[Math.min(MONSTERS.length - 1, Math.floor(random() * MONSTERS.length))]; const scale = Math.min(3, 1 + Math.floor(RANKS.indexOf(p.rank) / 2));
        const id = gameId; if (g.adventureGames[id]) throw new Error('ID sesi duplikat.'); if (!Number.isSafeInteger(p.hunts) || p.hunts >= Number.MAX_SAFE_INTEGER) throw new Error('Batas jumlah hunting terlampaui.'); const maxHp = p.maxHp + skillBonuses(p).maxHp; const game = { id, userId, status: 'active', createdAt: now(), expiresAt: now() + ttlMs, playerHp: Math.min(p.hp, maxHp), playerMaxHp: maxHp, enemyId: m.id, lootBonus: useBait ? 1 : 0, monster: { ...m, hp: m.hp * scale, maxHp: m.hp * scale, attack: m.attack * scale }, turn: 0, actions: [], usedSkills: [] }; g.adventureGames[id] = game; delete p.nextEnemyId; p.hunts++; return structuredClone(game);
      });
    },
    actHunt(guildId, userId, gameId, actionId, action, itemId, random = Math.random) {
      if (!/^\d{17,20}$/.test(actionId || '') || !['attack','defend','potion','run','skill'].includes(action)) throw new Error('Aksi hunting tidak valid.');
      return mutate(guildId, raw => {
        const g = ensureEconomyGuild({ guilds: { [guildId]: raw } }, guildId), game = g.adventureGames?.[gameId];
        if (!game) return { reason: 'missing' }; if (game.userId !== userId) return { reason: 'owner' }; if (game.actions.includes(actionId)) return { reason: 'duplicate' }; if (game.status !== 'active') return { reason: 'ended' }; if (game.expiresAt <= now()) { game.status = 'expired'; game.endedAt = now(); return { reason: 'expired' }; }
        const p = g.adventureProfiles[userId], a = account(g,userId), passives = skillBonuses(p); let message = '', defending = action === 'defend', attackMultiplier = 1, attackFlat = 0, skillId = null;
        game.buffs ||= { attack:0, defense:0, turns:0 }; game.usedSkills ||= [];
        if (action === 'run') { game.status = 'escaped'; game.endedAt = now(); game.actions.push(actionId); return { reason: 'ok', done: true, outcome: 'escaped', game: structuredClone(game), message: 'Berhasil kabur tanpa hadiah.' }; }
        if (action === 'potion') { const item = getItem(itemId); if (!item || item.category !== 'consumable' || !Object.keys(item.effects).some(k=>['heal','attack','defense'].includes(k))) throw new Error('Item bukan potion yang dapat digunakan.'); if (!(a.inventory[item.id] > 0)) throw new Error('Potion tidak dimiliki.'); if (item.effects.heal && game.playerHp >= game.playerMaxHp) throw new Error('HP sudah penuh.'); a.inventory[item.id]--; if (!a.inventory[item.id]) delete a.inventory[item.id]; if(item.effects.heal){const gained=Math.min(item.effects.heal,game.playerMaxHp-game.playerHp);game.playerHp+=gained;message=`Pulih ${gained} HP.`;} else {game.buffs.attack=item.effects.attack||0;game.buffs.defense=item.effects.defense||0;game.buffs.turns=item.effects.turns||0;message=`Efek ${item.name} aktif ${game.buffs.turns} giliran.`;}
        } else if (action === 'skill') { const skill = getSkill(itemId), level = p.skills?.[itemId] || 0; if (!skill || !['active','ultimate'].includes(skill.type)) throw new Error('Skill aktif tidak tersedia.'); if (!level) throw new Error('Kamu belum mempelajari skill ini.'); if (skill.type === 'ultimate' && game.usedSkills.includes(skill.id)) throw new Error('Ultimate ini sudah digunakan pada sesi hunt ini.'); skillId = skill.id; attackMultiplier = skill.effect.multiplier + (skill.effect.perLevel || 0) * (level - 1); attackFlat = (skill.effect.flatPerLevel || 0) * level; if (skill.type === 'ultimate') game.usedSkills.push(skill.id); message = `${skill.name} level ${level}! `;
        } else if (action === 'attack') { message = 'Serangan biasa! '; }
        if (action === 'attack' || action === 'skill') { const equipment = equipmentStats(p), base = p.baseAttack + equipment.attack + Math.floor(equipment.magic / 2) + passives.attack + game.buffs.attack; const crit = random() < passives.critChance; const damage = Math.max(1, Math.floor((base * attackMultiplier + attackFlat - game.monster.defense) * (crit ? 1.5 : 1))); game.monster.hp = Math.max(0, game.monster.hp - damage); message += `${crit ? 'Critical! ' : ''}${damage} damage.`; }
        if (game.monster.hp <= 0) { if (p.exp > Number.MAX_SAFE_INTEGER - game.monster.exp) throw new Error('Batas EXP terlampaui.'); game.status = 'won'; game.endedAt = now(); p.exp += game.monster.exp; p.hp = Math.max(1, game.playerHp); const oldRank = p.rank; if (!p.rankOverride) p.rank = rankForProgress(p); const pointsGained = awardRankSkillPoints(p, oldRank); p.questProgress ||= { hunts:0, claimedAt:0 }; p.questProgress.hunts = Math.min(3,p.questProgress.hunts+1); const drop = game.monster.loot, lootCount=1+game.lootBonus; addInventory(a,drop,lootCount); transact(g,'adventure_hunt',null,userId,game.monster.coins); game.actions.push(actionId); return { reason:'ok', done:true, outcome:'won', game:structuredClone(game), message:`${message} ${game.monster.name} dikalahkan! +${game.monster.exp} EXP, ${game.monster.coins} koin, ${lootCount} ${getItem(drop).name}.${pointsGained ? ` +${pointsGained} Skill Point dari rank progression.` : ''}${p.rank !== oldRank ? ` Rank naik ke ${p.rank}!` : ''}` }; }
        const equipment = equipmentStats(p), damage = Math.max(1, game.monster.attack - p.baseDefense - equipment.defense - game.buffs.defense - passives.mitigation - (defending ? 5 : 0) - equipment.mitigation); game.playerHp = Math.max(0, game.playerHp - damage); game.turn++; if(game.buffs.turns>0 && action!=='potion')game.buffs.turns--; message += ` ${game.monster.name} membalas ${damage} damage.`;
        if (game.playerHp <= 0) { game.status='lost'; game.endedAt=now(); p.hp=Math.max(1,Math.floor(game.playerMaxHp/2)); game.actions.push(actionId); return { reason:'ok', done:true, outcome:'lost', game:structuredClone(game), message: message+' Kamu kalah; HP dipulihkan ke setengah.' }; }
        p.hp = game.playerHp; game.actions.push(actionId); return { reason:'ok', done:false, game:structuredClone(game), skillId, message };
      });
    },
    quest(guildId,userId) { return mutate(guildId,raw=>{const g=ensureEconomyGuild({guilds:{[guildId]:raw}},guildId);const p=g.adventureProfiles?.[userId];if(!p)throw new Error('Daftar melalui /adventure register terlebih dahulu.');const a=account(g,userId);p.questProgress ||= { hunts:0, claimedAt:0 }; const day=Math.floor(now()/86_400_000);if(p.questProgress.claimedAt===day)return { claimed:false, alreadyClaimed:true, progress:p.questProgress.hunts, target:3 };if(p.questProgress.hunts<3)return { claimed:false, alreadyClaimed:false, progress:p.questProgress.hunts,target:3 };if(p.exp>Number.MAX_SAFE_INTEGER-50||p.completedQuests>=Number.MAX_SAFE_INTEGER)throw new Error('Batas progression terlampaui.');addInventory(a,'herb',2);transact(g,'adventure_quest',null,userId,75);p.questProgress.claimedAt=day;p.questProgress.hunts=0;p.completedQuests++;p.exp+=50;const old=p.rank;if(!p.rankOverride)p.rank=rankForProgress(p);const skillPoints=awardRankSkillPoints(p,old);return {claimed:true,exp:50,coins:75,rank:p.rank,rankUp:old!==p.rank,skillPoints};}); },
    usePotion(guildId,userId,itemId) { return mutate(guildId,raw=>{const g=ensureEconomyGuild({guilds:{[guildId]:raw}},guildId),p=g.adventureProfiles?.[userId];if(!p)throw new Error('Daftar dahulu.');if(Object.values(g.adventureGames||{}).some(game=>game.userId===userId&&game.status==='active'&&game.expiresAt>now()))throw new Error('Gunakan potion melalui aksi fight selama sesi aktif.');const item=getItem(itemId),a=account(g,userId),maxHp=p.maxHp+skillBonuses(p).maxHp;if(!item||item.category!=='consumable'||!item.effects.heal)throw new Error('Potion ini hanya dapat digunakan saat pertarungan.');if(!(a.inventory[item.id]>0))throw new Error('Potion tidak dimiliki.');if(p.hp>=maxHp)throw new Error('HP sudah penuh.');const before=p.hp;p.hp=Math.min(maxHp,p.hp+item.effects.heal);a.inventory[item.id]--;if(!a.inventory[item.id])delete a.inventory[item.id];return {item,before,hp:p.hp,maxHp};}); },
    equip(guildId,userId,itemId,slot,unequip=false) { if(!['weapon','armor','accessory'].includes(slot))throw new Error('Slot tidak valid.');return mutate(guildId,raw=>{const g=ensureEconomyGuild({guilds:{[guildId]:raw}},guildId),p=g.adventureProfiles?.[userId];if(!p)throw new Error('Daftar dahulu.');const a=account(g,userId);p.equipment ||= {weapon:null,armor:null,accessory:null};if(unequip){const old=p.equipment[slot],oldItem=getItem(old);if(!oldItem)throw new Error('Equipment tersimpan tidak valid; data tidak diubah.');addInventory(a,oldItem.id,1);p.equipment[slot]=null;return {item:oldItem,slot,unequipped:true};}const item=getItem(itemId), expected={weapon:'weapon',armor:'armor',accessory:'accessory'}[slot];if(!item||item.category!==expected)throw new Error('Jenis item tidak cocok dengan slot.');if(RANKS.indexOf(p.rank)<RANKS.indexOf(item.requiredRank))throw new Error(`Memerlukan rank ${item.requiredRank}.`);if(!(a.inventory[item.id]>0))throw new Error('Item tidak dimiliki.');const old=p.equipment[slot],oldItem=old?getItem(old):null;if(old&&!oldItem)throw new Error('Equipment tersimpan tidak valid; data tidak diubah.');if(oldItem&&a.inventory[oldItem.id]>=Number.MAX_SAFE_INTEGER)throw new Error('Batas jumlah inventory terlampaui.');if(oldItem)addInventory(a,oldItem.id,1);a.inventory[item.id]--;if(!a.inventory[item.id])delete a.inventory[item.id];p.equipment[slot]=item.id;return {item,slot,old:oldItem};}); },
    openMysteryBox(guildId,userId,random=Math.random) { return mutate(guildId,raw=>{const g=ensureEconomyGuild({guilds:{[guildId]:raw}},guildId),a=account(g,userId);if(!(a.inventory.mystery_box>0))throw new Error('Mystery Box tidak dimiliki.');const rewards=[['slime_gel',3],['monster_fang',2],['health_potion',1],['magic_crystal',1],['rare_herb',1]],roll=random();if(!Number.isFinite(roll)||roll<0||roll>=1)throw new Error('Hasil Mystery Box tidak valid.');const [id,n]=rewards[Math.floor(roll*rewards.length)];addInventory(a,id,n);a.inventory.mystery_box--;if(!a.inventory.mystery_box)delete a.inventory.mystery_box;return {item:getItem(id),quantity:n};}); },
    setAdventureRank(guildId,actorId,targetId,rank,interactionId) { if (![guildId,actorId,targetId,interactionId].every(id=>/^\d{17,20}$/.test(id||''))||!RANKS.includes(rank)) throw new Error('Target, interaksi, atau rank tidak valid.'); return mutate(guildId,raw=>{const g=ensureEconomyGuild({guilds:{[guildId]:raw}},guildId);if(adminActionSeen(g,interactionId))return {duplicate:true};const p=g.adventureProfiles?.[targetId];if(!p)throw new Error('Target belum memiliki profil Adventure.');const before={rank:p.rank,override:Boolean(p.rankOverride)};p.rank=rank;p.rankOverride=true;audit(g,{actorId,targetId,action:'adventure_rank_override',before,after:{rank,override:true}});rememberAdminAction(g,interactionId);return {rank,previousRank:before.rank,override:true};}); },
    setAdventureStats(guildId,actorId,targetId,{attack,defense,maxHp,currentHp},interactionId) { if (![guildId,actorId,targetId,interactionId].every(id=>/^\d{17,20}$/.test(id||''))||![attack,defense,currentHp].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=100_000)||!Number.isSafeInteger(maxHp)||maxHp<1||maxHp>100_000||currentHp>maxHp) throw new Error('ATK/DEF/HP harus bilangan bulat dalam batas 0–100.000 dan HP saat ini tidak boleh melebihi max HP.');return mutate(guildId,raw=>{const g=ensureEconomyGuild({guilds:{[guildId]:raw}},guildId);if(adminActionSeen(g,interactionId))return {duplicate:true};const p=g.adventureProfiles?.[targetId];if(!p)throw new Error('Target belum memiliki profil Adventure.');if(Object.values(g.adventureGames||{}).some(game=>game.userId===targetId&&game.status==='active'&&game.expiresAt>now()))throw new Error('Stat tidak dapat diubah selama sesi hunting aktif.');const before={attack:p.baseAttack,defense:p.baseDefense,maxHp:p.maxHp,currentHp:p.hp};p.baseAttack=attack;p.baseDefense=defense;p.maxHp=maxHp;p.hp=currentHp;audit(g,{actorId,targetId,action:'adventure_stats_override',before,after:{attack,defense,maxHp,currentHp}});rememberAdminAction(g,interactionId);return {attack,defense,maxHp,currentHp};}); },
    setAdventureSkillPoints(guildId,actorId,targetId,operation,amount,interactionId) { if (![guildId,actorId,targetId,interactionId].every(id=>/^\d{17,20}$/.test(id||''))||!['add','set'].includes(operation)||!Number.isSafeInteger(amount)||amount<(operation==='add'?1:0)||amount>1_000_000)throw new Error('Operasi, interaksi, atau skill point tidak valid (0–1.000.000).');return mutate(guildId,raw=>{const g=ensureEconomyGuild({guilds:{[guildId]:raw}},guildId);if(adminActionSeen(g,interactionId))return {duplicate:true};const p=g.adventureProfiles?.[targetId];if(!p)throw new Error('Target belum memiliki profil Adventure.');const persisted=p.skillPoints??0;if(!Number.isSafeInteger(persisted)||persisted<0||persisted>1_000_000)throw new Error('Saldo skill point tersimpan tidak valid.');const before=persisted,after=operation==='set'?amount:before+amount;if(!Number.isSafeInteger(after)||after>1_000_000)throw new Error('Batas skill point terlampaui.');p.skillPoints=after;audit(g,{actorId,targetId,action:`adventure_skillpoints_${operation}`,before,after});rememberAdminAction(g,interactionId);return {before,skillPoints:after};}); },
    setAdventureEnemy(guildId,actorId,targetId,monsterId,interactionId) { if (![guildId,actorId,targetId,interactionId].every(id=>/^\d{17,20}$/.test(id||'')))throw new Error('Target atau interaksi tidak valid.');const monster=getMonster(monsterId);if(!monster)throw new Error('Musuh tidak tersedia dalam katalog Adventure.');return mutate(guildId,raw=>{const g=ensureEconomyGuild({guilds:{[guildId]:raw}},guildId);if(adminActionSeen(g,interactionId))return {duplicate:true};const p=g.adventureProfiles?.[targetId];if(!p)throw new Error('Target belum memiliki profil Adventure.');if(Object.values(g.adventureGames||{}).some(game=>game.userId===targetId&&game.status==='active'&&game.expiresAt>now()))throw new Error('Target sedang memiliki sesi hunting aktif.');const before=p.nextEnemyId||null;p.nextEnemyId=monster.id;audit(g,{actorId,targetId,action:'adventure_enemy_override',before,after:monster.id});rememberAdminAction(g,interactionId);return {monster,before};}); },
    inventory(guildId, userId) { return normalizeInventory(store.read().guilds[guildId]?.users?.[userId]?.inventory || {}); },
    leaderboard(guildId, limit = 10) { return Object.entries(store.read().guilds[guildId]?.users || {}).map(([userId, a]) => ({ userId, balance: a.balance })).sort((a, b) => b.balance - a.balance).slice(0, limit); },
    history(guildId, userId) { return (store.read().guilds[guildId]?.transactions || []).filter(x => x.from === userId || x.to === userId); }
  };
}

function pickWinners(entries, winnerCount, random = randomInt) {
  if (!Array.isArray(entries) || !Number.isInteger(winnerCount) || winnerCount < 1) throw new Error('Invalid winner selection');
  const pool = [...new Set(entries)]; const winners = [];
  while (pool.length && winners.length < winnerCount) winners.push(pool.splice(random(pool.length), 1)[0]);
  return winners;
}

function createGiveawayStore(filePath, { now = Date.now } = {}) {
  const store = createJsonStore(filePath, { version: 1, giveaways: {} });
  return {
    create(input) {
      const { guildId, channelId, messageId, hostId, prize, endsAt, winnerCount } = input || {};
      if (![guildId, channelId, messageId, hostId].every(id => /^\d{17,20}$/.test(id || '')) || typeof prize !== 'string' || !prize.trim() || prize.length > 200 || !Number.isSafeInteger(endsAt) || endsAt <= now() || !Number.isInteger(winnerCount) || winnerCount < 1 || winnerCount > 20) throw new Error('Invalid giveaway');
      const data = store.read(); if (data.version !== 1 || !data.giveaways) throw new Error('Invalid giveaway data');
      if (data.giveaways[messageId]) throw new Error('Duplicate giveaway');
      const giveaway = { ...input, prize: prize.trim(), entries: [], ended: false, createdAt: now() };
      data.giveaways[messageId] = giveaway; store.write(data); return giveaway;
    },
    enter(messageId, userId) { if (!/^\d{17,20}$/.test(userId || '')) throw new Error('Invalid user ID'); const data = store.read(); const g = data.giveaways[messageId]; if (!g || g.ended || g.endsAt <= now()) return false; if (g.entries.includes(userId)) return false; g.entries.push(userId); store.write(data); return true; },
    due() { return Object.values(store.read().giveaways).filter(g => !g.ended && g.endsAt <= now()); },
    finish(messageId, random = randomInt) { const data = store.read(); const g = data.giveaways[messageId]; if (!g || g.ended || g.endsAt > now()) return null; g.ended = true; g.winners = pickWinners(g.entries, g.winnerCount, random); g.finishedAt = now(); store.write(data); return g; },
    get(messageId) { return store.read().giveaways[messageId] || null; }
  };
}

function createRateLimiter({ windowMs = 10_000, max = 5, now = Date.now } = {}) {
  const seen = new Map();
  return key => { const t = now(); const prior = (seen.get(key) || []).filter(at => t - at < windowMs); if (prior.length >= max) return false; prior.push(t); seen.set(key, prior); return true; };
}

function createTicketStore(filePath, { now = Date.now } = {}) {
  const store = createJsonStore(filePath, { version: 1, guilds: {} });
  function guildData(data, guildId) { return data.guilds[guildId] ||= { staffRoleId: null, categoryId: null, tickets: {} }; }
  const ticketFrom = (data, guildId, channelId) => data.guilds[guildId]?.tickets?.[channelId];
  return {
    configure(guildId, { staffRoleId, categoryId = null }) {
      const data = store.read(); const g = guildData(data, guildId);
      if (!/^\d{17,20}$/.test(staffRoleId || '')) throw new Error('Staff role ID tidak valid.');
      if (categoryId !== null && !/^\d{17,20}$/.test(categoryId)) throw new Error('Category ID tidak valid.');
      g.staffRoleId = staffRoleId; g.categoryId = categoryId; store.write(data); return { ...g };
    },
    configuration(guildId) { const g = store.read().guilds[guildId]; return g ? { staffRoleId: g.staffRoleId, categoryId: g.categoryId } : null; },
    create({ guildId, userId, channelId }) {
      if (![guildId, userId, channelId].every(id => /^\d{17,20}$/.test(id || ''))) throw new Error('Data tiket tidak valid.');
      const data = store.read(); const g = guildData(data, guildId);
      if (!g.staffRoleId) throw new Error('Tiket belum dikonfigurasi administrator.');
      if (Object.values(g.tickets).some(t => t.userId === userId && t.status === 'open')) throw new Error('Kamu sudah memiliki tiket terbuka.');
      if (g.tickets[channelId]) throw new Error('ID channel tiket duplikat.');
      const ticket = { guildId, userId, channelId, status: 'open', createdAt: now(), closedAt: null, deleteAt: null, deletionStatus: 'none', deletionAttempts: 0, deletionToken: null, transcript: null, transcriptSavedAt: null };
      g.tickets[channelId] = ticket; store.write(data); return { ...ticket };
    },
    getByChannel(guildId, channelId) { const t = store.read().guilds[guildId]?.tickets?.[channelId]; return t ? { ...t } : null; },
    setStatus(guildId, channelId, status) {
      if (!['open', 'closed'].includes(status)) throw new Error('Status tiket tidak valid.');
      const data = store.read(); const t = data.guilds[guildId]?.tickets?.[channelId];
      if (!t) throw new Error('Tiket tidak ditemukan.');
      if (t.status === status) return { ...t };
      t.status = status;
      if (status === 'closed') {
        t.closedAt = now(); t.deleteAt = t.closedAt + 60_000; t.deletionStatus = 'pending';
        t.deletionAttempts ||= 0; t.deletionToken = null; t.transcript = null; t.transcriptSavedAt = null;
      } else {
        t.closedAt = null; t.deleteAt = null; t.deletionStatus = 'none'; t.deletionAttempts = 0; t.deletionToken = null;
        t.transcript = null; t.transcriptSavedAt = null;
      }
      store.write(data); return { ...t };
    },
    saveTranscript(guildId, channelId, transcript) {
      if (typeof transcript !== 'string') throw new Error('Transkrip tiket tidak valid.');
      const data = store.read(); const t = ticketFrom(data, guildId, channelId);
      if (!t || t.status !== 'closed') throw new Error('Hanya tiket tertutup yang dapat menyimpan transkrip.');
      t.transcript = transcript.slice(-100_000); t.transcriptSavedAt = now(); store.write(data); return true;
    },
    transcript(guildId, channelId) { return ticketFrom(store.read(), guildId, channelId)?.transcript ?? null; },
    recoverDeletions() {
      const data = store.read(); const found = [];
      for (const [guildId, guild] of Object.entries(data.guilds)) for (const [channelId, t] of Object.entries(guild.tickets || {})) {
        if (t.status !== 'closed') continue;
        if (!Number.isSafeInteger(t.deleteAt) && Number.isSafeInteger(t.closedAt)) {
          t.deleteAt = t.closedAt + 60_000; t.deletionStatus = 'pending'; t.deletionAttempts = 0; t.deletionToken = null;
        }
        if (Number.isSafeInteger(t.deleteAt) && ['pending', 'deleting'].includes(t.deletionStatus)) found.push({ ...t, guildId, channelId });
      }
      store.write(data); return found;
    },
    claimDeletion(guildId, channelId, token) {
      const data = store.read(); const t = ticketFrom(data, guildId, channelId);
      if (!t || t.status !== 'closed' || !Number.isSafeInteger(t.deleteAt) || t.deleteAt > now() || !['pending', 'deleting'].includes(t.deletionStatus) || typeof t.transcript !== 'string' || t.transcriptSavedAt === null) return null;
      t.deletionStatus = 'deleting'; t.deletionToken = token; store.write(data); return { ...t };
    },
    deletionIsCurrent(guildId, channelId, token) {
      const t = ticketFrom(store.read(), guildId, channelId);
      return Boolean(t && t.status === 'closed' && t.deletionStatus === 'deleting' && t.deletionToken === token && t.deleteAt <= now());
    },
    markChannelMissing(guildId, channelId) {
      const data = store.read(); const t = ticketFrom(data, guildId, channelId);
      if (!t || t.status !== 'closed') return false;
      t.deletionStatus = 'deleted'; t.deletedAt = now(); t.deletionToken = null; store.write(data); return true;
    },
    markDeleted(guildId, channelId, token) {
      const data = store.read(); const t = ticketFrom(data, guildId, channelId);
      if (!t || t.status !== 'closed' || t.deletionToken !== token || t.deletionStatus !== 'deleting') return false;
      t.deletionStatus = 'deleted'; t.deletedAt = now(); t.deletionToken = null; store.write(data); return true;
    },
    markDeletionFailed(guildId, channelId, token, retryMs = 5_000) {
      const data = store.read(); const t = ticketFrom(data, guildId, channelId);
      if (!t || t.status !== 'closed' || t.deletionToken !== token || t.deletionStatus !== 'deleting') return null;
      t.deletionAttempts = (t.deletionAttempts || 0) + 1; t.deletionStatus = 'pending'; t.deletionToken = null;
      t.deleteAt = now() + Math.max(1_000, Math.min(300_000, retryMs)); store.write(data); return { ...t };
    },
    deferDeletion(guildId, channelId, retryMs = 5_000) {
      const data = store.read(); const t = ticketFrom(data, guildId, channelId);
      if (!t || t.status !== 'closed' || !['pending', 'deleting'].includes(t.deletionStatus)) return null;
      t.deletionAttempts = (t.deletionAttempts || 0) + 1; t.deletionStatus = 'pending'; t.deletionToken = null;
      t.deleteAt = now() + Math.max(1_000, Math.min(300_000, retryMs)); store.write(data); return { ...t };
    },
    list(guildId) { return Object.values(store.read().guilds[guildId]?.tickets || {}).map(t => ({ ...t })); }
  };
}

module.exports = { createJsonStore, createEconomyStore, createGiveawayStore, createTicketStore, createRateLimiter, pickWinners };
