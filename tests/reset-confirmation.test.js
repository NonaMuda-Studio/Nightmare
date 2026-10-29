'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createResetConfirmationGuard } = require('../reset-confirmation');

const guildId = '12345678901234567';
const ownerId = '12345678901234568';

async function processMockConfirmation(guard, id, resetOperation) {
  const claim = guard.claim(id, ownerId, guildId);
  if (!claim.claimed) return claim;
  try {
    await resetOperation();
    guard.finish(id, 'completed');
    return { claimed: true, status: 'completed' };
  } catch (error) {
    guard.finish(id, 'failed');
    throw error;
  }
}

test('same reset confirmation cannot start a concurrent or repeated destructive operation', async () => {
  const ids = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'];
  const guard = createResetConfirmationGuard({ createId: () => ids.shift() });
  const id = guard.issue({ guildId, ownerId });
  let startReset;
  let resetCalls = 0;
  const first = processMockConfirmation(guard, id, () => {
    resetCalls++;
    return new Promise(resolve => { startReset = resolve; });
  });

  const concurrent = await processMockConfirmation(guard, id, async () => { resetCalls++; });
  assert.deepEqual(concurrent, { claimed: false, status: 'running' });
  assert.equal(resetCalls, 1, 'concurrent click must not invoke reset twice');

  startReset();
  assert.deepEqual(await first, { claimed: true, status: 'completed' });
  const repeated = await processMockConfirmation(guard, id, async () => { resetCalls++; });
  assert.deepEqual(repeated, { claimed: false, status: 'completed' });
  assert.equal(resetCalls, 1, 'completed confirmation stays consumed');
});

test('reset confirmation remains owner/guild bound and failed work requires a fresh confirmation', async () => {
  const ids = [
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  ];
  const guard = createResetConfirmationGuard({ createId: () => ids.shift() });
  const failedId = guard.issue({ guildId, ownerId });
  assert.deepEqual(guard.claim(failedId, '12345678901234569', guildId), { claimed: false, status: 'unauthorized' });
  assert.deepEqual(guard.claim(failedId, ownerId, '12345678901234570'), { claimed: false, status: 'unauthorized' });

  await assert.rejects(processMockConfirmation(guard, failedId, async () => { throw new Error('mock reset failure'); }), /mock reset failure/);
  assert.deepEqual(guard.claim(failedId, ownerId, guildId), { claimed: false, status: 'failed' });

  const retryId = guard.issue({ guildId, ownerId });
  assert.notEqual(retryId, failedId);
  assert.deepEqual(await processMockConfirmation(guard, retryId, async () => {}), { claimed: true, status: 'completed' });
});

test('a rejected component acknowledgment releases its claim before reset work begins', () => {
  const guard = createResetConfirmationGuard({ createId: () => 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' });
  const id = guard.issue({ guildId, ownerId });
  assert.equal(guard.claim(id, ownerId, guildId).claimed, true);
  assert.equal(guard.release(id), true);
  assert.equal(guard.get(id).status, 'pending');
  assert.equal(guard.claim(id, ownerId, guildId).claimed, true);
});

test('resetserver component handler issues a bound token and claims it before reset API calls', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const handlerStart = source.indexOf("const resetAction = interaction.customId.match(/^nightmare_reset_");
  const commandStart = source.indexOf("if (interaction.commandName === 'resetserver')");
  assert.ok(handlerStart >= 0 && commandStart > handlerStart);
  const handler = source.slice(handlerStart, commandStart);
  assert.match(handler, /interaction\.user\.id !== confirmation\.ownerId/);
  assert.match(handler, /memberPermissions\?\.has\(PermissionFlagsBits\.Administrator\)/);
  assert.ok(handler.indexOf('resetConfirmationGuard.claim(') < handler.indexOf('await interaction.deferUpdate()'));
  assert.ok(handler.indexOf('await interaction.deferUpdate()') < handler.indexOf('guild.channels.fetch()'));
  assert.match(handler, /resetConfirmationGuard\.finish\(confirmationId, 'completed'\)/);
  assert.match(handler, /resetConfirmationGuard\.finish\(confirmationId, 'failed'\)/);
  const command = source.slice(commandStart, source.indexOf("if (interaction.commandName === 'resetpreview')", commandStart));
  assert.match(command, /resetConfirmationGuard\.issue\(\{ guildId: interaction\.guildId, ownerId: interaction\.user\.id \}\)/);
  assert.match(command, /nightmare_reset_confirm:' \+ confirmationId/);
  assert.match(command, /nightmare_reset_cancel:' \+ confirmationId/);
});
