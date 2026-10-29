'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Routes } = require('discord.js');
const { buildSetupCommand, validateSetupCommandSchema } = require('../setup-command-schema');
const {
  TEST_GUILD_ID, buildSetupGuildCommandPlan, syncSetupGuildCommand, validateTargetGuild
} = require('../setup-command-sync');
const { parseArgs, validateTargetOptions } = require('../scripts/sync-setup-guild-command');

const APPLICATION_ID = '1563771473821306999';
const setupCommand = validateSetupCommandSchema(buildSetupCommand().toJSON());
const otherCommands = [
  { id: 'remote-id-one', application_id: APPLICATION_ID, guild_id: TEST_GUILD_ID, version: 'v1', name: 'ping', description: 'Ping bot', type: 1, options: [] },
  { id: 'remote-id-two', application_id: APPLICATION_ID, guild_id: TEST_GUILD_ID, version: 'v2', name: 'ticket', description: 'Ticket bot', type: 1, options: [{ type: 1, name: 'close', description: 'Close ticket' }], default_member_permissions: '32' }
];

function fakeRest(existing = otherCommands) {
  const calls = { get: [], put: [] };
  return {
    calls,
    async get(route) { calls.get.push(route); return structuredClone(existing); },
    async put(route, body) { calls.put.push({ route, body }); return body.body; }
  };
}

test('shared /setup schema has required string template choices and optional staff role', () => {
  const command = setupCommand;
  assert.equal(command.name, 'setup');
  const template = command.options.find(option => option.name === 'template');
  assert.equal(template.type, 3);
  assert.equal(template.required, true);
  assert.ok(template.description.length > 0);
  assert.deepEqual(template.choices.map(({ name, value }) => ({ name, value })), [
    { name: 'Large Community', value: 'large' },
    { name: 'Medium Community', value: 'medium' },
    { name: 'Small Community', value: 'small' }
  ]);
  const staffRole = command.options.find(option => option.name === 'staff_role');
  assert.equal(staffRole.type, 8);
  assert.equal(staffRole.required, false);
});

test('plan replaces only /setup and retains all other guild command schemas', () => {
  const oldSetup = { id: 'old-setup-id', application_id: APPLICATION_ID, guild_id: TEST_GUILD_ID, version: 'old-version', name: 'setup', description: 'Old setup', type: 1, options: [] };
  const existing = [otherCommands[0], oldSetup, otherCommands[1]];
  const plan = buildSetupGuildCommandPlan(existing, setupCommand);
  assert.equal(plan.setupAction, 'replace');
  assert.deepEqual(plan.preservedNames, ['ping', 'ticket']);
  assert.deepEqual(plan.commands, [otherCommands[0] && { name: 'ping', description: 'Ping bot', options: [], type: 1 }, setupCommand, { name: 'ticket', description: 'Ticket bot', options: [{ type: 1, name: 'close', description: 'Close ticket' }], default_member_permissions: '32', type: 1 }]);
});

test('plan appends /setup when missing without changing the other commands', () => {
  const plan = buildSetupGuildCommandPlan(otherCommands, setupCommand);
  assert.equal(plan.setupAction, 'add');
  assert.deepEqual(plan.commands.slice(0, 2), [
    { name: 'ping', description: 'Ping bot', options: [], type: 1 },
    { name: 'ticket', description: 'Ticket bot', options: [{ type: 1, name: 'close', description: 'Close ticket' }], default_member_permissions: '32', type: 1 }
  ]);
  assert.equal(plan.commands[2].name, 'setup');
});

test('dry-run fetches the test guild and never sends a command update', async () => {
  const rest = fakeRest();
  const logs = [];
  const result = await syncSetupGuildCommand({ rest, applicationId: APPLICATION_ID, guildId: TEST_GUILD_ID, mode: 'dry-run', setupCommand, logger: { log: line => logs.push(line) } });
  assert.equal(result.applied, false);
  assert.deepEqual(rest.calls.get, [Routes.applicationGuildCommands(APPLICATION_ID, TEST_GUILD_ID)]);
  assert.equal(rest.calls.put.length, 0);
  assert.ok(logs.some(line => line.includes('/ping') && line.includes('/ticket')));
  assert.ok(logs.some(line => line.includes('tidak ada perubahan dikirim')));
});

test('apply requires explicit confirmation and updates only the guild route with preserved commands', async () => {
  const rest = fakeRest();
  const result = await syncSetupGuildCommand({ rest, applicationId: APPLICATION_ID, guildId: TEST_GUILD_ID, mode: 'apply', confirmedGuildId: TEST_GUILD_ID, setupCommand, logger: { log() {} } });
  assert.equal(result.applied, true);
  const expectedRoute = Routes.applicationGuildCommands(APPLICATION_ID, TEST_GUILD_ID);
  assert.deepEqual(rest.calls.get, [expectedRoute]);
  assert.equal(rest.calls.put.length, 1);
  assert.equal(rest.calls.put[0].route, expectedRoute);
  assert.equal(rest.calls.put[0].route.includes('/guilds/'), true);
  assert.deepEqual(rest.calls.put[0].body.body.slice(0, 2), [
    { name: 'ping', description: 'Ping bot', options: [], type: 1 },
    { name: 'ticket', description: 'Ticket bot', options: [{ type: 1, name: 'close', description: 'Close ticket' }], default_member_permissions: '32', type: 1 }
  ]);
  assert.equal(rest.calls.put[0].body.body[2].name, 'setup');
});

test('target, confirmation, schema, and duplicate setup validation fail before REST requests', async () => {
  assert.equal(validateTargetGuild(TEST_GUILD_ID), TEST_GUILD_ID);
  assert.throws(() => validateTargetGuild('1563771473821306931'), /Target dibatasi/);
  assert.throws(() => parseArgs(['--dry-run', '--apply']), /Pilih hanya satu mode/);
  assert.throws(() => parseArgs([]), /Mode wajib/);
  assert.throws(() => validateTargetOptions(parseArgs(['--apply', '--guild', TEST_GUILD_ID])), /--confirm-guild/);
  assert.throws(() => validateTargetOptions(parseArgs(['--dry-run', '--guild', '1'])), /Target dibatasi/);

  const rest = fakeRest();
  await assert.rejects(syncSetupGuildCommand({ rest, applicationId: APPLICATION_ID, guildId: '1563771473821306931', mode: 'dry-run', setupCommand }), /Target dibatasi/);
  await assert.rejects(syncSetupGuildCommand({ rest, applicationId: APPLICATION_ID, guildId: TEST_GUILD_ID, mode: 'apply', setupCommand }), /--confirm-guild/);
  await assert.rejects(syncSetupGuildCommand({ rest, applicationId: APPLICATION_ID, guildId: TEST_GUILD_ID, mode: 'dry-run', setupCommand: { ...setupCommand, options: [] } }), /Schema \/setup tidak valid/);
  assert.equal(rest.calls.get.length, 0);
  assert.equal(rest.calls.put.length, 0);
  assert.throws(() => buildSetupGuildCommandPlan([...otherCommands, { name: 'setup' }, { name: 'setup' }], setupCommand), /lebih dari satu/);
});
