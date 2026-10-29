'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SKIP_COMMAND_REGISTRATION_ENV, registerCommandsUnlessSkipped } = require('../command-registration');

test('exact skip flag prevents slash-command registration and reports the skip', async () => {
  let calls = 0;
  const logs = [];
  const result = await registerCommandsUnlessSkipped({
    env: { [SKIP_COMMAND_REGISTRATION_ENV]: '1' },
    register: async () => { calls++; },
    logger: { log: message => logs.push(message) }
  });
  assert.deepEqual(result, { registered: false, skipped: true });
  assert.equal(calls, 0);
  assert.ok(logs.some(message => message.includes(`${SKIP_COMMAND_REGISTRATION_ENV}=1`)));
});

test('unset or non-exact skip values preserve the existing registration path', async () => {
  for (const env of [{}, { [SKIP_COMMAND_REGISTRATION_ENV]: '0' }, { [SKIP_COMMAND_REGISTRATION_ENV]: 'true' }]) {
    let calls = 0;
    const result = await registerCommandsUnlessSkipped({ env, register: async () => { calls++; }, logger: { log() {} } });
    assert.deepEqual(result, { registered: true, skipped: false });
    assert.equal(calls, 1);
  }
});

test('registration callback errors propagate to the existing startup error handler', async () => {
  await assert.rejects(registerCommandsUnlessSkipped({ env: {}, register: async () => { throw new Error('mock REST failure'); } }), /mock REST failure/);
});
