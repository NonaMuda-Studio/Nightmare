'use strict';

const { Routes } = require('discord.js');
const { validateSetupCommandSchema } = require('./setup-command-schema');

const TEST_GUILD_ID = '1563771473821306930';
const WRITABLE_COMMAND_FIELDS = Object.freeze([
  'name', 'name_localizations', 'description', 'description_localizations', 'options',
  'default_member_permissions', 'dm_permission', 'default_permission', 'nsfw', 'type',
  'integration_types', 'contexts'
]);

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function toWritableCommand(command) {
  const writable = {};
  for (const field of WRITABLE_COMMAND_FIELDS) {
    if (Object.hasOwn(command, field)) writable[field] = cloneJson(command[field]);
  }
  return writable;
}

function validateTargetGuild(guildId) {
  if (guildId !== TEST_GUILD_ID) throw new Error(`Target dibatasi ke guild uji ${TEST_GUILD_ID}.`);
  return guildId;
}

function validateApplicationId(applicationId) {
  if (typeof applicationId !== 'string' || !/^\d{17,20}$/.test(applicationId)) throw new Error('DISCORD_CLIENT_ID wajib berisi application ID Discord yang valid.');
  return applicationId;
}

function errorAtStage(error, stage) {
  if (error && typeof error === 'object' && error.stage) return error;
  const wrapped = new Error(error?.message || 'Operasi REST gagal.');
  wrapped.name = error?.name || 'Error';
  wrapped.code = error?.code;
  wrapped.status = error?.status ?? error?.statusCode ?? error?.response?.status;
  wrapped.stage = stage;
  wrapped.cause = error;
  return wrapped;
}

function buildSetupGuildCommandPlan(existingCommands, setupCommand) {
  validateSetupCommandSchema(setupCommand);
  if (!Array.isArray(existingCommands)) throw new TypeError('Daftar command guild tidak valid.');
  const setupMatches = existingCommands.filter(command => command?.name === 'setup');
  if (setupMatches.length > 1) throw new Error('Guild memiliki lebih dari satu command /setup; hentikan untuk tinjauan manual.');
  const preserved = existingCommands.filter(command => command?.name !== 'setup');
  const commands = existingCommands.map(command => command?.name === 'setup' ? setupCommand : toWritableCommand(command));
  if (setupMatches.length === 0) commands.push(setupCommand);
  return Object.freeze({
    commands: Object.freeze(commands),
    preservedNames: Object.freeze(preserved.map(command => command.name)),
    setupAction: setupMatches.length ? 'replace' : 'add',
    existingCount: existingCommands.length,
    resultingCount: commands.length,
    priorSetup: setupMatches[0] ? toWritableCommand(setupMatches[0]) : null,
    nextSetup: setupCommand
  });
}

function setupSummary(command) {
  const template = command.options?.find(option => option.name === 'template');
  return {
    name: command.name,
    description: command.description,
    template: template ? {
      type: template.type === 3 ? 'string' : String(template.type),
      required: template.required === true,
      description: template.description,
      choices: (template.choices || []).map(choice => ({ name: choice.name, value: choice.value }))
    } : null
  };
}

async function syncSetupGuildCommand({ rest, applicationId, guildId = TEST_GUILD_ID, mode, confirmedGuildId, setupCommand, logger = console } = {}) {
  validateTargetGuild(guildId);
  validateApplicationId(applicationId);
  if (!['dry-run', 'apply'].includes(mode)) throw new Error('Mode wajib dry-run atau apply.');
  if (mode === 'apply' && confirmedGuildId !== TEST_GUILD_ID) throw new Error(`Apply memerlukan --confirm-guild ${TEST_GUILD_ID}.`);
  validateSetupCommandSchema(setupCommand);
  if (!rest || typeof rest.get !== 'function' || typeof rest.put !== 'function') throw new TypeError('REST client harus menyediakan get dan put.');

  const route = Routes.applicationGuildCommands(applicationId, guildId);
  let existing;
  try { existing = await rest.get(route); }
  catch (error) { throw errorAtStage(error, 'guild-command-fetch'); }
  const plan = buildSetupGuildCommandPlan(existing, setupCommand);
  logger.log?.(`Target guild uji: ${guildId}`);
  logger.log?.(`Mode: ${mode}; command sebelum=${plan.existingCount}, sesudah=${plan.resultingCount}; /setup=${plan.setupAction}.`);
  logger.log?.(`Schema /setup sebelumnya: ${plan.priorSetup ? JSON.stringify(setupSummary(plan.priorSetup)) : '(belum ada)'}`);
  logger.log?.(`Schema /setup tujuan: ${JSON.stringify(setupSummary(plan.nextSetup))}`);
  logger.log?.(`Command guild lain dipertahankan (${plan.preservedNames.length}): ${plan.preservedNames.length ? plan.preservedNames.map(name => '/' + name).join(', ') : '(tidak ada)'}`);
  if (mode === 'dry-run') {
    logger.log?.('Dry-run selesai; tidak ada perubahan dikirim.');
    return { applied: false, route, ...plan };
  }
  let result;
  try { result = await rest.put(route, { body: plan.commands }); }
  catch (error) { throw errorAtStage(error, 'guild-command-update'); }
  logger.log?.('Sinkronisasi /setup ke guild uji berhasil. Command global tidak disentuh.');
  return { applied: true, route, result, ...plan };
}

module.exports = { TEST_GUILD_ID, WRITABLE_COMMAND_FIELDS, validateTargetGuild, validateApplicationId, errorAtStage, buildSetupGuildCommandPlan, setupSummary, syncSetupGuildCommand };
