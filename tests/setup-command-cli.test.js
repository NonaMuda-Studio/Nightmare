'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Routes } = require('discord.js');
const { buildSetupCommand } = require('../setup-command-schema');
const { TEST_GUILD_ID } = require('../setup-command-sync');
const {
  PROJECT_ROOT, loadEnvironment, safeError, runSyncSetupCli
} = require('../scripts/sync-setup-guild-command');

const APP_ID = '1563771473821306999';
const TOKEN = 'header.payload.signature-token-value-that-must-never-appear';

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightmare-command-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function fakeRest({ get, put } = {}) {
  const calls = { get: [], put: [] };
  const rest = {
    calls,
    setToken(value) { assert.equal(value, TOKEN); return this; },
    async get(route) { calls.get.push(route); return get ? get(route) : []; },
    async put(route, payload) { calls.put.push({ route, payload }); return put ? put(route, payload) : payload.body; }
  };
  return rest;
}

test('dotenv file resolves from project root and dry-run GET uses only target guild route', async t => {
  const root = tempRoot(t);
  fs.writeFileSync(path.join(root, '.env'), `DISCORD_CLIENT_ID=${APP_ID}\nDISCORD_TOKEN=${TOKEN}\n`);
  const env = {};
  const load = loadEnvironment({ env, projectRoot: root });
  assert.equal(load.envFile, path.join(root, '.env'));
  assert.equal(env.DISCORD_CLIENT_ID, APP_ID);
  assert.equal(env.DISCORD_TOKEN, TOKEN);
  const mixedEnv = { DISCORD_CLIENT_ID: '', DISCORD_TOKEN: 'non-empty-shell-token' };
  loadEnvironment({ env: mixedEnv, projectRoot: root });
  assert.equal(mixedEnv.DISCORD_CLIENT_ID, APP_ID, 'empty exported variables may be filled from project .env');
  assert.equal(mixedEnv.DISCORD_TOKEN, 'non-empty-shell-token', 'non-empty exported variables take precedence');

  const rest = fakeRest();
  const logs = [];
  await runSyncSetupCli({
    args: ['--dry-run', '--guild', TEST_GUILD_ID], env, projectRoot: root,
    restFactory: () => rest,
    logger: { log: line => logs.push(line) }
  });
  assert.deepEqual(rest.calls.get, [Routes.applicationGuildCommands(APP_ID, TEST_GUILD_ID)]);
  assert.equal(rest.calls.put.length, 0);
  assert.ok(logs.every(line => !line.includes(TOKEN) && !line.includes(APP_ID)));
});

test('missing environment reports only required variable names before REST setup', async () => {
  let restCreated = false;
  await assert.rejects(runSyncSetupCli({
    args: ['--dry-run'], env: {}, dotenvImpl: { config() { return { error: Object.assign(new Error('missing'), { code: 'ENOENT' }) }; } },
    restFactory() { restCreated = true; throw new Error('must not create REST'); }
  }), error => {
    const output = safeError(error);
    assert.match(output, /stage=environment-validation/);
    assert.match(output, /DISCORD_CLIENT_ID, DISCORD_TOKEN/);
    assert.doesNotMatch(output, /must not create REST/);
    return true;
  });
  assert.equal(restCreated, false);
});

test('invalid application ID and invalid schema stop before any guild GET', async t => {
  const root = tempRoot(t);
  let getCount = 0;
  let restCount = 0;
  const rest = fakeRest();
  await assert.rejects(runSyncSetupCli({
    args: ['--dry-run'], env: { DISCORD_CLIENT_ID: 'not-an-id', DISCORD_TOKEN: TOKEN }, projectRoot: root,
    restFactory: () => { restCount++; return rest; }
  }), error => { assert.equal(error.stage, 'environment-validation'); return true; });
  await assert.rejects(runSyncSetupCli({
    args: ['--dry-run'], env: { DISCORD_CLIENT_ID: APP_ID, DISCORD_TOKEN: TOKEN }, projectRoot: root,
    setupCommand: { ...buildSetupCommand().toJSON(), options: [] },
    restFactory: () => { restCount++; return { ...rest, async get() { getCount++; } }; }
  }), error => { assert.equal(error.stage, 'schema-validation'); return true; });
  assert.equal(restCount, 0, 'invalid application ID and schema are rejected before REST client construction');
  assert.equal(getCount, 0);
});

test('GET failure reports safe stage, HTTP status, Discord code, and sanitized message without PUT', async t => {
  const root = tempRoot(t);
  const env = { DISCORD_CLIENT_ID: APP_ID, DISCORD_TOKEN: TOKEN };
  const rest = fakeRest({ get: async () => { throw Object.assign(new Error(`403 Forbidden https://discord.test/api Authorization: Bearer ${TOKEN} application ${APP_ID}`), { name: 'DiscordAPIError', status: 403, code: 50001 }); } });
  let thrown;
  try {
    await runSyncSetupCli({ args: ['--dry-run'], env, projectRoot: root, restFactory: () => rest, logger: { log() {} } });
  } catch (error) { thrown = error; }
  assert.ok(thrown);
  const output = safeError(thrown);
  assert.match(output, /stage=guild-command-fetch/);
  assert.match(output, /httpStatus=403/);
  assert.match(output, /discordCode=50001/);
  assert.match(output, /URL disembunyikan/);
  assert.doesNotMatch(output, /discord\.test|Authorization:|Bearer|signature-token|1563771473821306999/);
  const structuredSecretError = safeError(new Error(`request failed {\"token\":\"${TOKEN}\",\"client_secret\":\"secret-value\"}`));
  assert.doesNotMatch(structuredSecretError, new RegExp(TOKEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(structuredSecretError, /secret-value/);
  assert.equal(rest.calls.put.length, 0);
});

test('dry-run GET failure never falls through to PUT', async () => {
  let putCalls = 0;
  const rest = {
    async get() { throw Object.assign(new Error('temporary read ECONNRESET'), { code: 'ECONNRESET' }); },
    async put() { putCalls++; }
  };
  const { syncSetupGuildCommand } = require('../setup-command-sync');
  await assert.rejects(syncSetupGuildCommand({ rest, applicationId: APP_ID, guildId: TEST_GUILD_ID, mode: 'dry-run', setupCommand: buildSetupCommand().toJSON() }), error => error.stage === 'guild-command-fetch');
  assert.equal(putCalls, 0);
});

test('dotenv path used by the CLI is anchored to the script project, not process cwd', () => {
  assert.equal(path.basename(PROJECT_ROOT), 'fallen-bot');
  assert.equal(path.resolve(PROJECT_ROOT, 'scripts', 'sync-setup-guild-command.js'), path.resolve(__dirname, '..', 'scripts', 'sync-setup-guild-command.js'));
});
