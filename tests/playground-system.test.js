'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEconomyStore } = require('../nightmare-services');
const { createPlaygroundService, handlePlaygroundCommand, describeResult } = require('../playground-system');

function fixture(t, random = () => 7) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightmare-playground-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let time = 100_000_000;
  const economy = createEconomyStore(path.join(dir, 'economy.json'), { now: () => time });
  const guildId = '12345678901234567', userId = '12345678901234568';
  economy.daily(guildId, userId, 100);
  const service = createPlaygroundService(economy, { now: () => time, random });
  return { economy, service, guildId, userId, advance(ms) { time += ms; } };
}

test('guess game charges entry fee through shared economy and pays a win exactly once', t => {
  const { economy, service, guildId, userId } = fixture(t);
  const game = service.startGuess(guildId, userId, '12345678901234569', 10);
  assert.equal(economy.balance(guildId, userId), 90);
  const wrong = service.guess(guildId, userId, game.id, '12345678901234570', 1);
  assert.equal(wrong.done, false);
  assert.match(wrong.response, /Sisa kesempatan: \*\*2/);
  const won = service.guess(guildId, userId, game.id, '12345678901234571', 7);
  assert.equal(won.outcome, 'won'); assert.equal(won.payout, 35);
  assert.equal(economy.balance(guildId, userId), 125);
  assert.equal(service.guess(guildId, userId, game.id, '12345678901234571', 7).reason, 'duplicate');
  assert.equal(economy.history(guildId, userId).filter(tx => tx.type === 'game_reward').length, 1);
});

test('loss consumes only the entry fee and invalid answers do not consume a turn', t => {
  const { economy, service, guildId, userId } = fixture(t);
  const game = service.startGuess(guildId, userId, '12345678901234569', 8);
  assert.throws(() => service.guess(guildId, userId, game.id, '12345678901234570', 11), /1–10/);
  assert.equal(economy.getGame(guildId, game.id).payload.attemptsLeft, 3);
  service.guess(guildId, userId, game.id, '12345678901234571', 1);
  service.guess(guildId, userId, game.id, '12345678901234572', 2);
  const lost = service.guess(guildId, userId, game.id, '12345678901234573', 3);
  assert.equal(lost.outcome, 'lost'); assert.equal(lost.payout, 0);
  assert.equal(economy.balance(guildId, userId), 92);
});

test('insufficient balance, expired game, and ended game return safe outcomes', t => {
  const { economy, service, guildId, userId, advance } = fixture(t);
  assert.throws(() => service.startGuess(guildId, userId, '12345678901234569', 101), /Insufficient balance/);
  assert.equal(economy.balance(guildId, userId), 100);
  const game = service.startGuess(guildId, userId, '12345678901234570', 5);
  advance(5 * 60_000);
  assert.equal(service.guess(guildId, userId, game.id, '12345678901234571', 7).reason, 'expired');
  assert.match(describeResult({ reason: 'ended' }), /sudah berakhir/);
  assert.match(describeResult({ reason: 'expired' }), /kedaluwarsa/);
});

test('trivia concurrent answers settle a single prize in shared wallet', async t => {
  const { economy, service, guildId, userId } = fixture(t, () => 0);
  const game = service.startTrivia(guildId, userId, '12345678901234569', 5);
  const [first, second] = await Promise.all([
    Promise.resolve().then(() => service.answerTrivia(guildId, userId, game.id, '12345678901234570', 2)),
    Promise.resolve().then(() => service.answerTrivia(guildId, userId, game.id, '12345678901234571', 2))
  ]);
  assert.equal([first, second].filter(result => result.outcome === 'won').length, 1);
  assert.equal([first, second].filter(result => result.reason === 'ended').length, 1);
  assert.equal(economy.balance(guildId, userId), 135);
  assert.equal(economy.history(guildId, userId).filter(tx => tx.type === 'game_reward').length, 1);
});

test('coin flip requires a bounded stake and uses shared wallet for win/loss', t => {
  const { economy, service, guildId, userId, advance } = fixture(t, () => 0);
  assert.throws(() => service.flip(guildId, userId, '12345678901234569', 'heads', 0), /1–100/);
  const won = service.flip(guildId, userId, '12345678901234570', 'heads', 10);
  assert.equal(won.outcome, 'won'); assert.equal(won.payout, 20);
  advance(15_000);
  const lost = service.flip(guildId, userId, '12345678901234571', 'tails', 10);
  assert.equal(lost.reason, 'ok');
  assert.equal(lost.outcome, 'lost'); assert.equal(lost.payout, 0);
  assert.equal(economy.balance(guildId, userId), 100);
});

test('playground command acknowledges privately and reports insufficient shared wallet funds', async () => {
  let edited;
  const interaction = { id: '12345678901234569', guildId: '12345678901234567', user: { id: '12345678901234568' }, inGuild: () => true,
    options: { getSubcommand: () => 'guess-start', getInteger: () => 1000 },
    async deferReply() {}, async editReply(value) { edited = value; } };
  const service = { startGuess() { throw new Error('Insufficient balance'); } };
  await handlePlaygroundCommand(interaction, service);
  assert.match(edited, /Saldo coin tidak cukup/);
});

test('registered playground command handler creates its session in the shared economy store', async t => {
  const { economy, service, guildId, userId } = fixture(t);
  let response;
  const interaction = { id: '12345678901234569', guildId, user: { id: userId }, inGuild: () => true,
    options: { getSubcommand: () => 'guess-start', getInteger: () => 5 },
    async deferReply() {}, async editReply(value) { response = value; } };
  await handlePlaygroundCommand(interaction, service);
  const game = economy.getGame(guildId, interaction.id);
  assert.equal(game.status, 'active'); assert.equal(game.entryFee, 5);
  assert.equal(economy.balance(guildId, userId), 95);
  assert.match(response, /game ID: 12345678901234569/);
});
