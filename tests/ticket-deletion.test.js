'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTicketStore } = require('../nightmare-services');
const { createTicketDeletionScheduler, DELETION_DELAY_MS } = require('../ticket-deletion');

function fakeTimers(initialTime = 10_000) {
  let time = initialTime, nextId = 0; const tasks = new Map();
  return {
    now: () => time,
    set(fn, delay) { const id = ++nextId; tasks.set(id, { fn, at: time + delay }); return id; },
    clear(id) { tasks.delete(id); },
    get count() { return tasks.size; },
    async advance(ms) {
      time += ms;
      while (true) {
        const next = [...tasks.entries()].filter(([, task]) => task.at <= time).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        tasks.delete(next[0]); await next[1].fn();
      }
    },
    restart() { tasks.clear(); }
  };
}

function fixture(t, clock = fakeTimers()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightmare-ticket-delete-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'tickets.json');
  const store = createTicketStore(file, { now: clock.now });
  const guildId = '12345678901234567', userId = '12345678901234568', channelId = '12345678901234569';
  store.configure(guildId, { staffRoleId: '12345678901234570' });
  store.create({ guildId, userId, channelId });
  return { dir, file, store, clock, guildId, userId, channelId };
}

test('ticket closes at 60 seconds only after its transcript is durably saved', async t => {
  const f = fixture(t); const ticket = f.store.setStatus(f.guildId, f.channelId, 'closed');
  assert.equal(ticket.deleteAt, f.clock.now() + DELETION_DELAY_MS);
  const deleted = [];
  const channel = {
    messages: { async fetch() { return new Map([['m', { createdTimestamp: f.clock.now(), author: { username: 'member' }, cleanContent: 'help', attachments: new Map() }]]); } },
    async delete() { assert.match(f.store.transcript(f.guildId, f.channelId), /help/); deleted.push(f.clock.now()); }
  };
  const scheduler = createTicketDeletionScheduler({ store: f.store, client: { channels: { async fetch() { return channel; } } }, now: f.clock.now, setTimeoutFn: f.clock.set, clearTimeoutFn: f.clock.clear });
  scheduler.schedule(f.guildId, f.channelId); scheduler.schedule(f.guildId, f.channelId);
  assert.equal(scheduler.timerCount, 1, 'repeat close handling does not create duplicate timers');
  await f.clock.advance(59_999); assert.deepEqual(deleted, []);
  await f.clock.advance(1); assert.deepEqual(deleted, [ticket.deleteAt]);
  assert.equal(f.store.getByChannel(f.guildId, f.channelId).deletionStatus, 'deleted');
});

test('reopening a closed ticket cancels its pending timer and stale callback cannot delete it', async t => {
  const f = fixture(t); f.store.setStatus(f.guildId, f.channelId, 'closed'); f.store.saveTranscript(f.guildId, f.channelId, 'saved');
  let deleted = 0;
  const scheduler = createTicketDeletionScheduler({ store: f.store, client: { channels: { async fetch() { return { async delete() { deleted++; } }; } } }, now: f.clock.now, setTimeoutFn: f.clock.set, clearTimeoutFn: f.clock.clear });
  scheduler.schedule(f.guildId, f.channelId); assert.equal(scheduler.timerCount, 1);
  f.store.setStatus(f.guildId, f.channelId, 'open'); scheduler.cancel(f.guildId, f.channelId);
  await f.clock.advance(DELETION_DELAY_MS);
  assert.equal(deleted, 0); assert.equal(scheduler.timerCount, 0);
  assert.equal(f.store.getByChannel(f.guildId, f.channelId).deleteAt, null);
});

test('scheduler recovers a persisted close deadline after restart', async t => {
  const f = fixture(t); f.store.setStatus(f.guildId, f.channelId, 'closed'); f.store.saveTranscript(f.guildId, f.channelId, 'pre-saved transcript');
  const originalDeadline = f.store.getByChannel(f.guildId, f.channelId).deleteAt;
  const deleted = [];
  const client = { channels: { async fetch() { return { async delete() { deleted.push(f.clock.now()); } }; } } };
  const first = createTicketDeletionScheduler({ store: f.store, client, now: f.clock.now, setTimeoutFn: f.clock.set, clearTimeoutFn: f.clock.clear });
  first.schedule(f.guildId, f.channelId); f.clock.restart();
  const afterRestartStore = createTicketStore(f.file, { now: f.clock.now });
  const restarted = createTicketDeletionScheduler({ store: afterRestartStore, client, now: f.clock.now, setTimeoutFn: f.clock.set, clearTimeoutFn: f.clock.clear });
  assert.equal(restarted.recover(), 1); assert.equal(restarted.timerCount, 1);
  await f.clock.advance(originalDeadline - f.clock.now());
  assert.deepEqual(deleted, [originalDeadline]);
});

test('failed deletion is persisted and retried; missing channel is treated as already removed', async t => {
  const f = fixture(t); f.store.setStatus(f.guildId, f.channelId, 'closed'); f.store.saveTranscript(f.guildId, f.channelId, 'transcript');
  let attempts = 0;
  const scheduler = createTicketDeletionScheduler({ store: f.store, client: { channels: { async fetch() { return { async delete() { attempts++; if (attempts === 1) { const error = new Error('Missing Permissions'); error.code = 50013; throw error; } } }; } } }, now: f.clock.now, setTimeoutFn: f.clock.set, clearTimeoutFn: f.clock.clear, retryMs: 5_000 });
  scheduler.schedule(f.guildId, f.channelId); await f.clock.advance(DELETION_DELAY_MS);
  const failed = f.store.getByChannel(f.guildId, f.channelId);
  assert.equal(failed.deletionStatus, 'pending'); assert.equal(failed.deletionAttempts, 1); assert.equal(scheduler.timerCount, 1);
  await f.clock.advance(5_000);
  assert.equal(attempts, 2); assert.equal(f.store.getByChannel(f.guildId, f.channelId).deletionStatus, 'deleted');

  const another = f.store.create({ guildId: f.guildId, userId: '12345678901234571', channelId: '12345678901234572' });
  f.store.setStatus(f.guildId, another.channelId, 'closed'); f.store.saveTranscript(f.guildId, another.channelId, 'saved');
  const missing = createTicketDeletionScheduler({ store: f.store, client: { channels: { async fetch() { const error = new Error('Unknown Channel'); error.code = 10003; throw error; } } }, now: f.clock.now, setTimeoutFn: f.clock.set, clearTimeoutFn: f.clock.clear });
  missing.schedule(f.guildId, another.channelId); await f.clock.advance(DELETION_DELAY_MS);
  assert.equal(f.store.getByChannel(f.guildId, another.channelId).deletionStatus, 'deleted');
});

test('open or invalid ticket records are never scheduled for channel deletion', t => {
  const f = fixture(t); const scheduler = createTicketDeletionScheduler({ store: f.store, client: { channels: { async fetch() { assert.fail('must not fetch an open ticket'); } } }, now: f.clock.now, setTimeoutFn: f.clock.set, clearTimeoutFn: f.clock.clear });
  assert.equal(scheduler.schedule(f.guildId, f.channelId), false);
  assert.equal(scheduler.schedule(f.guildId, '12345678901234571'), false);
  assert.equal(scheduler.timerCount, 0);
});
