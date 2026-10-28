'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PermissionFlagsBits } = require('discord.js');
const { createNotificationStore, deliverNotification, retryPendingNotifications, handleNotifyCommand, handleMemberNotification } = require('../notification-system');

test('notification configuration persists per guild and claim deduplicates with cooldown', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightmare-notify-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let time = 100_000; const file = path.join(dir, 'notifications.json');
  let store = createNotificationStore(file, { now: () => time });
  const guildId = '12345678901234567';
  store.configure(guildId, { channelId: '12345678901234568', roleId: '12345678901234569', joins: true, leaves: false });
  assert.equal(createNotificationStore(file, { now: () => time }).get(guildId).joins, true);
  assert.equal(store.claim(guildId, 'manual:one', { cooldownMs: 30_000 }).ok, true);
  assert.deepEqual(store.claim(guildId, 'manual:one', { cooldownMs: 30_000 }), { ok: false, reason: 'duplicate' });
  assert.equal(store.claim(guildId, 'manual:two', { cooldownMs: 30_000 }).reason, 'cooldown');
  time += 30_000;
  assert.equal(store.claim(guildId, 'manual:two', { cooldownMs: 30_000 }).ok, true);
  assert.equal(store.claim(guildId, 'join:member:1').ok, true);
});

test('notify command checks Manage Server and sends only configured role mentions', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightmare-notify-cmd-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let time = 100_000; const store = createNotificationStore(path.join(dir, 'notifications.json'), { now: () => time });
  const sends = [];
  const channel = { id: '12345678901234568', type: 0, isTextBased: () => true, async send(payload) { sends.push(payload); } };
  const guild = { id: '12345678901234567', channels: { cache: new Map([[channel.id, channel]]), async fetch() { return channel; } } };
  store.configure(guild.id, { channelId: channel.id, roleId: '12345678901234569', joins: false, leaves: false });
  function make({ permission = true, id = '98765432109876543' } = {}) {
    return { guild, guildId: guild.id, user: { id }, inGuild: () => true,
      memberPermissions: { has: value => permission && value === PermissionFlagsBits.ManageGuild },
      options: { getSubcommand: () => 'send', getString: () => 'Hello @everyone' },
      async deferReply() {}, async editReply(value) { this.result = value; } };
  }
  const authorized = make(); await handleNotifyCommand(authorized, store);
  assert.match(authorized.result, /terkirim/);
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].allowedMentions, { parse: [], users: [], roles: ['12345678901234569'] });
  assert.match(sends[0].content, /@everyone/);
  time += 30_000;
  const denied = make({ permission: false, id: '98765432109876544' }); await handleNotifyCommand(denied, store);
  assert.match(denied.result, /Manage Server/);
  assert.equal(sends.length, 1);
});

test('member notifications honor per-server switches and suppress repeated events', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightmare-notify-events-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createNotificationStore(path.join(dir, 'notifications.json'));
  const sends = []; const channel = { isTextBased: () => true, async send(payload) { sends.push(payload); } };
  const guild = { id: '12345678901234567', name: 'Test Server', channels: { cache: new Map([['12345678901234568', channel]]) } };
  store.configure(guild.id, { channelId: '12345678901234568', roleId: null, joins: true, leaves: false });
  const member = { id: '12345678901234569', user: { id: '12345678901234569', bot: false }, joinedTimestamp: 1234, guild };
  assert.equal((await handleMemberNotification(member, 'join', store)).ok, true);
  assert.deepEqual(await handleMemberNotification(member, 'join', store), { ok: false, reason: 'duplicate' });
  assert.deepEqual(await handleMemberNotification(member, 'leave', store), { ok: false, reason: 'disabled' });
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].allowedMentions.parse, []);
});

test('notification outbox retries transient delivery errors and marks successful sends complete', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightmare-notify-outbox-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let time = 50_000, attempts = 0;
  const store = createNotificationStore(path.join(dir, 'notifications.json'), { now: () => time });
  const guildId = '12345678901234567', channelId = '12345678901234568';
  const channel = { isTextBased: () => true, async send() { attempts++; if (attempts === 1) throw new Error('temporary API failure'); } };
  const guild = { id: guildId, channels: { cache: new Map([[channelId, channel]]) } };
  store.configure(guildId, { channelId, roleId: null, joins: false, leaves: false });
  await assert.rejects(deliverNotification(guild, store, 'manual:stable-key', 'announcement'), /temporary API failure/);
  assert.equal(store.pending().length, 0, 'retry waits for the exponential backoff');
  time += 5_000;
  await retryPendingNotifications({ guilds: { cache: new Map([[guildId, guild]]) } }, store);
  assert.equal(attempts, 2);
  assert.equal(store.pending().length, 0);
  assert.deepEqual(store.claim(guildId, 'manual:stable-key'), { ok: false, reason: 'duplicate' });
});
