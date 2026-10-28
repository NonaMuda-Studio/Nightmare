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
