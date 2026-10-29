'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createInteractionDiagnostics, errorResponseAction } = require('../interaction-diagnostics');

function fakeInteraction({ createdTimestamp = 1_000, commandName = 'adventure', customId } = {}) {
  return {
    createdTimestamp, commandName, customId, deferred: false, replied: false, responded: false,
    isChatInputCommand() { return Boolean(this.commandName); }, isAutocomplete() { return false; },
    async deferReply() { this.deferred = true; },
    async reply() { this.replied = true; },
    async respond() { this.responded = true; }
  };
}

test('interaction diagnostics report slow entry and acknowledgment age/latency without payload data', async () => {
  let wall = 3_000, mono = 10; const logs = [];
  const eventLoopMonitor = { max: 0, enable() {}, reset() { this.max = 0; } };
  const diagnostics = createInteractionDiagnostics({ now: () => wall, monotonicNow: () => mono, logger: line => logs.push(line), slowMs: 500, eventLoopMonitor });
  const interaction = fakeInteraction(); interaction.deferReply = async () => { mono += 800; interaction.deferred = true; }; diagnostics.instrument(interaction, 'component-listener');
  mono += 800;
  diagnostics.instrument(interaction, 'command-dispatcher');
  await interaction.deferReply();
  assert.ok(logs.some(line => line.includes('received kind=command name=/adventure ageAtListenerMs=2000') && line.includes('localLoopMaxDelayMs=0.0')));
  assert.ok(logs.some(line => line.includes('listener-delay') && line.includes('delayMs=800.0')));
  assert.ok(logs.some(line => line.includes('acknowledged') && line.includes('method=deferReply') && line.includes('handlerDelayMs=0.0') && line.includes('latencyMs=800.0')));
  assert.ok(logs.every(line => !line.includes('token') && !line.includes('credential')));
});

test('interaction diagnostics separate a measured local event-loop stall from unexplained age', () => {
  const logs = [], eventLoopMonitor = { max: 8_000_000_000, enable() {}, reset() { this.max = 0; } };
  const diagnostics = createInteractionDiagnostics({ now: () => 10_000, monotonicNow: () => 1, logger: line => logs.push(line), slowMs: 500, eventLoopMonitor });
  const interaction = fakeInteraction({ createdTimestamp: 1_937 });
  diagnostics.instrument(interaction, 'component-listener');
  assert.ok(logs.some(line => line.includes('ageAtListenerMs=8063') && line.includes('localLoopMaxDelayMs=8000.0') && line.includes('ageBeyondMaxLoopDelayMs=63.0')));
});

test('failed/expired acknowledgment is recorded and a second initial response is visible', async () => {
  let wall = 2_000; const logs = [];
  const diagnostics = createInteractionDiagnostics({ now: () => wall, monotonicNow: () => 1, logger: line => logs.push(line), slowMs: 500 });
  const interaction = fakeInteraction({ commandName: undefined, customId: 'nightmare_announce:confirm:private-draft-id' });
  interaction.deferReply = async () => { const error = new Error('Unknown interaction'); error.code = 10062; throw error; };
  const state = diagnostics.instrument(interaction, 'command-dispatcher');
  await assert.rejects(interaction.deferReply(), error => error.code === 10062);
  assert.equal(state.ackStatus, 'failed'); assert.equal(state.ackErrorCode, 10062);
  await interaction.reply();
  assert.ok(logs.some(line => line.includes('acknowledgment-failed') && line.includes('handlerDelayMs=0.0') && line.includes('code=10062')));
  assert.ok(logs.some(line => line.includes('duplicate-ack-attempt')));
  assert.ok(logs.every(line => !line.includes('private-draft-id')));
});

test('autocomplete fallback can tell pre-ack failures from an expired respond attempt', async () => {
  let wall = 1_000; const logs = [];
  const diagnostics = createInteractionDiagnostics({ now: () => wall, monotonicNow: () => 1, logger: line => logs.push(line) });
  const interaction = fakeInteraction({ commandName: undefined });
  interaction.isAutocomplete = () => true;
  interaction.respond = async () => { const error = new Error('Unknown interaction'); error.code = 10062; throw error; };
  const state = diagnostics.instrument(interaction, 'command-dispatcher');
  await assert.rejects(interaction.respond([]));
  assert.equal(state.attempts, 1); assert.equal(state.ackStatus, 'failed');
  assert.ok(logs.some(line => line.includes('method=respond') && line.includes('code=10062')));
});

test('dispatcher error response policy edits only a confirmed defer and never retries failed or expired acknowledgments', () => {
  const error = Object.assign(new Error('Unknown interaction'), { code: 10062 });
  assert.equal(errorResponseAction({ deferred: true }, { attempts: 1, ackStatus: 'failed' }, error), 'none');
  assert.equal(errorResponseAction({ deferred: true }, { attempts: 1, ackStatus: 'acknowledged' }, new Error('later work failed')), 'edit');
  assert.equal(errorResponseAction({ replied: true }, { attempts: 1, ackStatus: 'acknowledged' }, new Error('later work failed')), 'none');
  assert.equal(errorResponseAction({}, { attempts: 0, ackStatus: 'none' }, new Error('pre-ack failure')), 'reply');
  assert.equal(errorResponseAction({}, { attempts: 1, ackStatus: 'pending' }, new Error('ack outcome ambiguous')), 'none');
});
