'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyLevelUpDeliveryError,
  isSafeReadRetry,
  retryIdempotentRead,
  sendLevelUpOnce
} = require('../level-up-delivery');

test('level-up read retries transient network failures because the operation is idempotent', async () => {
  let calls = 0;
  const result = await retryIdempotentRead(async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('read ECONNABORTED'), { code: 'ECONNABORTED' });
    return 'channel';
  }, { delayMs: 0 });
  assert.equal(result, 'channel');
  assert.equal(calls, 2);
  assert.equal(isSafeReadRetry(Object.assign(new Error('reset'), { code: 'ECONNRESET' })), true);
});

test('level-up read does not retry permanent API errors', async () => {
  let calls = 0;
  const error = Object.assign(new Error('Missing Permissions'), { status: 403, code: 50013 });
  await assert.rejects(retryIdempotentRead(async () => { calls++; throw error; }, { delayMs: 0 }), error);
  assert.equal(calls, 1);
  assert.equal(classifyLevelUpDeliveryError(error), 'permanent-or-resource');
});

test('level-up message send is attempted once for an ambiguous ECONNABORTED result', async () => {
  let calls = 0;
  const error = Object.assign(new Error('read ECONNABORTED'), { code: 'ECONNABORTED' });
  await assert.rejects(sendLevelUpOnce({ async send() { calls++; throw error; } }, { content: 'mock' }), error => error.deliveryClass === 'transient-ambiguous');
  assert.equal(calls, 1);
  assert.equal(classifyLevelUpDeliveryError(error), 'transient-ambiguous');
});

test('rate limits and server failures are classified without making sends retry automatically', () => {
  assert.equal(classifyLevelUpDeliveryError({ status: 429 }), 'transient-rejected');
  assert.equal(classifyLevelUpDeliveryError({ status: 503 }), 'server-error-ambiguous');
  assert.equal(isSafeReadRetry({ status: 429 }), false, 'wait for Discord retry-after policy instead of retrying early');
  assert.equal(isSafeReadRetry({ status: 503 }), true);
});
