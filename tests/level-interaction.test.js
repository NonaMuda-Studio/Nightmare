'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const handlerStart = source.indexOf('async function handleLevelCommand(interaction) {');
const handlerEnd = source.indexOf('\nasync function applyLevelRewards', handlerStart);
assert.notEqual(handlerStart, -1, 'level command handler exists');
assert.notEqual(handlerEnd, -1, 'level command handler has an end boundary');
const handlerSource = source.slice(handlerStart, handlerEnd);

function createHandler(context = {}) {
  return vm.runInNewContext(`(${handlerSource})`, {
    MessageFlags: { Ephemeral: 64 },
    PermissionFlagsBits: { Administrator: 8 },
    performance,
    interactionDispatchStartedAt: new WeakMap(),
    console: { error() {}, warn() {} },
    ...context
  });
}

test('level slash commands are registered once and dispatched to one handler', () => {
  assert.equal((source.match(/async function handleLevelCommand\(/g) || []).length, 1);
  assert.equal((source.match(/return await handleLevelCommand\(interaction\)/g) || []).length, 1);
  for (const command of ['rank', 'level', 'card', 'rewards', 'boosters', 'leaderboard']) {
    const rootCommand = new RegExp(`\\.setName\\('${command}'\\)\\n\\s+\\.setDescription`, 'g');
    assert.equal((source.match(rootCommand) || []).length, 1, `${command} root registration`);
  }
  assert.match(source, /if \(!xpStore\.isEligibleMessage\(message\)\) return;\s*\/\/ XP persistence uses synchronous JSON work\. Yield once so queued gateway\s*\/\/ interactions can be dispatched and acknowledged before that work begins\.\s*setImmediate\(\(\) => \{ void processXpMessage\(message\); \}\);/);
});

test('rank, card, and leaderboard defer before guild, member, store, or rendering work', async () => {
  for (const commandName of ['rank', 'card', 'leaderboard']) {
    const order = [];
    const handler = createHandler({
      requireGuild() {
        order.push('guild');
        throw new Error('stop after acknowledgment');
      }
    });
    const interaction = {
      commandName,
      createdTimestamp: Date.now(),
      deferred: false,
      replied: false,
      async deferReply() {
        order.push('defer');
        this.deferred = true;
      },
      async editReply() { order.push('edit'); },
      async reply() { order.push('reply'); }
    };

    await handler(interaction);
    assert.deepEqual(order, ['defer', 'guild', 'edit'], `${commandName} ordering`);
  }
});

test('rank and card deliver the rendered PNG through editReply after deferring', async () => {
  for (const commandName of ['rank', 'card']) {
    const order = [];
    const guild = {
      id: 'guild',
      members: {
        async fetch() {
          order.push('member');
          return {
            id: 'member',
            user: { bot: false, username: 'Nightmare' },
            displayName: 'Nightmare',
            displayAvatarURL: () => 'avatar-url'
          };
        }
      }
    };
    class EmbedBuilder {
      setColor() { return this; }
      setImage(url) { this.image = url; return this; }
    }
    class AttachmentBuilder {
      constructor(buffer, options) { this.buffer = buffer; this.options = options; }
    }
    const buffer = Buffer.from('png-data');
    const handler = createHandler({
      requireGuild() { order.push('guild'); return guild; },
      xpStore: {
        getStats() { order.push('stats'); return { level: 2, totalXp: 300, currentLevelXp: 100, xpToNextLevel: 200, progress: 0.5 }; },
        getRank() { order.push('rank'); return 1; }
      },
      renderRankCardSafely: async () => { order.push('render'); return { buffer, error: null }; },
      EmbedBuilder,
      AttachmentBuilder
    });
    const interaction = {
      commandName,
      createdTimestamp: Date.now(),
      user: { id: 'member' },
      options: { getUser: () => null },
      deferred: false,
      replied: false,
      async deferReply() { order.push('defer'); this.deferred = true; },
      async editReply(payload) { order.push('edit'); return payload; },
      async reply() { order.push('reply'); }
    };

    const payload = await handler(interaction);
    assert.deepEqual(order, ['defer', 'guild', 'member', 'stats', 'rank', 'render', 'edit'], commandName);
    assert.equal(payload.embeds[0].image, 'attachment://nightmare-rank.png');
    assert.equal(payload.files[0].buffer, buffer);
    assert.equal(payload.files[0].options.name, 'nightmare-rank.png');
  }
});

test('expired or already-acknowledged defer errors never trigger a second response', async () => {
  for (const code of [10062, 40060]) {
    const calls = [];
    const handler = createHandler();
    const interaction = {
      commandName: 'card',
      createdTimestamp: Date.now(),
      deferred: false,
      replied: false,
      async deferReply() {
        calls.push('defer');
        const error = new Error('Discord acknowledgment failure');
        error.code = code;
        throw error;
      },
      async editReply() { calls.push('edit'); },
      async reply() { calls.push('reply'); }
    };

    await handler(interaction);
    assert.deepEqual(calls, ['defer'], `Discord code ${code}`);
  }
});
