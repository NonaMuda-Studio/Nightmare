'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType } = require('discord.js');
const { createTemporaryVoiceService } = require('../temporary-voice');

function fixture({ move = async () => {}, deleteFailure = null } = {}) {
  let createCount = 0;
  let deleteCount = 0;
  const category = { id: 'voice-category', type: ChannelType.GuildCategory };
  const room = { id: 'temp-room', members: { size: 1 }, async delete() { deleteCount++; if (deleteFailure) throw deleteFailure; } };
  const guild = { id: 'guild', channels: { async create(payload) { createCount++; room.payload = payload; return room; } } };
  const member = { id: 'member', voice: { async setChannel(channel) { await move(channel); } } };
  const service = createTemporaryVoiceService({ logger: { error() {} } });
  return { service, guild, member, category, room, counts: () => ({ createCount, deleteCount }) };
}

test('concurrent duplicate trigger events create one room per guild/member', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ move: async () => gate });
  const first = f.service.createRoom({ guild: f.guild, member: f.member, category: f.category, name: '🔊・Member', permissionOverwrites: [] });
  const second = await f.service.createRoom({ guild: f.guild, member: f.member, category: f.category, name: '🔊・Member', permissionOverwrites: [] });
  assert.deepEqual(second, { created: false, reason: 'already-creating' });
  assert.equal(f.counts().createCount, 1);
  release();
  const result = await first;
  assert.equal(result.moved, true);
  assert.equal(f.service.isManagedRoom(f.room.id), true);
});

test('failed member move cleans an empty managed room and never manages permanent rooms', async () => {
  const f = fixture({ move: async () => { throw new Error('mock move denied'); } });
  // A newly created room is empty when Discord rejects the member move.
  f.room.members.size = 0;
  const result = await f.service.createRoom({ guild: f.guild, member: f.member, category: f.category, name: '🔊・Member', permissionOverwrites: [] });
  assert.equal(result.moved, false);
  assert.equal(f.counts().deleteCount, 1);
  assert.equal(f.service.isManagedRoom(f.room.id), false);
  const permanent = { id: 'permanent-room', members: { size: 0 }, async delete() { throw new Error('must not delete'); } };
  assert.equal(await f.service.cleanupEmptyRoom(permanent), false);
});

test('failed empty-room deletion retains tracking and can be retried on a later voice event', async () => {
  const f = fixture({ deleteFailure: new Error('mock API failure') });
  const result = await f.service.createRoom({ guild: f.guild, member: f.member, category: f.category, name: '🔊・Member', permissionOverwrites: [] });
  assert.equal(result.moved, true);
  f.room.members.size = 0;
  assert.equal(await f.service.cleanupEmptyRoom(f.room), false);
  assert.equal(f.service.isManagedRoom(f.room.id), true);
  f.room.delete = async () => { f.counts().deleteCount++; };
  assert.equal(await f.service.cleanupEmptyRoom(f.room), true);
  assert.equal(f.service.isManagedRoom(f.room.id), false);
});

test('invalid inputs do not create a room', async () => {
  const f = fixture();
  assert.equal((await f.service.createRoom({ guild: f.guild, member: null, category: f.category })).reason, 'invalid-input');
  assert.equal(f.counts().createCount, 0);
});
