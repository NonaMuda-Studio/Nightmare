#!/usr/bin/env node
'use strict';

const path = require('node:path');
const dotenv = require('dotenv');
const { REST } = require('discord.js');
const { buildSetupCommand, validateSetupCommandSchema } = require('../setup-command-schema');
const { TEST_GUILD_ID, syncSetupGuildCommand } = require('../setup-command-sync');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(PROJECT_ROOT, '.env');
const SNOWFLAKE_PATTERN = /\b\d{17,20}\b/g;
const DISCORD_TOKEN_PATTERN = /\b(?:mfa\.[\w-]{20,}|[\w-]{20,}\.[\w-]{6,}\.[\w-]{20,})\b/g;

function parseArgs(args) {
  const parsed = { mode: null, guildId: TEST_GUILD_ID, confirmedGuildId: null };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--dry-run') {
      if (parsed.mode) throw new Error('Pilih hanya satu mode: --dry-run atau --apply.');
      parsed.mode = 'dry-run';
    } else if (arg === '--apply') {
      if (parsed.mode) throw new Error('Pilih hanya satu mode: --dry-run atau --apply.');
      parsed.mode = 'apply';
    } else if (arg === '--guild' || arg === '--confirm-guild') {
      const value = args[++index];
      if (!value) throw new Error(`Nilai wajib setelah ${arg}.`);
      if (arg === '--guild') parsed.guildId = value;
      else parsed.confirmedGuildId = value;
    } else {
      throw new Error(`Argumen tidak dikenal: ${arg}`);
    }
  }
  if (!parsed.mode) throw new Error('Mode wajib: gunakan --dry-run atau --apply.');
  return parsed;
}

function validateTargetOptions(options) {
  if (options.guildId !== TEST_GUILD_ID || options.mode === 'apply' && options.confirmedGuildId !== TEST_GUILD_ID) {
    throw new Error(`Target dibatasi ke guild uji ${TEST_GUILD_ID}; apply juga memerlukan --confirm-guild ${TEST_GUILD_ID}.`);
  }
  return options;
}

function loadEnvironment({ env = process.env, projectRoot = PROJECT_ROOT, dotenvImpl = dotenv } = {}) {
  const envFile = path.join(path.resolve(projectRoot), '.env');
  // Work on a copy so only the two required values are imported. Empty shell
  // variables count as missing, while non-empty exported values take priority.
  const dotenvEnv = { ...env };
  for (const name of ['DISCORD_CLIENT_ID', 'DISCORD_TOKEN']) {
    if (typeof dotenvEnv[name] !== 'string' || !dotenvEnv[name].trim()) delete dotenvEnv[name];
  }
  const result = dotenvImpl.config({ path: envFile, quiet: true, override: false, processEnv: dotenvEnv });
  // An absent .env is valid when the required variables were exported by the caller.
  if (result?.error && result.error.code !== 'ENOENT') {
    const error = new Error(`Gagal membaca file environment proyek (code=${result.error.code || 'unknown'}).`);
    error.stage = 'dotenv-load';
    throw error;
  }
  for (const name of ['DISCORD_CLIENT_ID', 'DISCORD_TOKEN']) {
    if (typeof env[name] !== 'string' || !env[name].trim()) {
      if (typeof dotenvEnv[name] === 'string' && dotenvEnv[name].trim()) env[name] = dotenvEnv[name];
    }
  }
  return { env, envFile };
}

function validateEnvironment(env) {
  const missing = [];
  if (typeof env.DISCORD_CLIENT_ID !== 'string' || !env.DISCORD_CLIENT_ID.trim()) missing.push('DISCORD_CLIENT_ID');
  if (typeof env.DISCORD_TOKEN !== 'string' || !env.DISCORD_TOKEN.trim()) missing.push('DISCORD_TOKEN');
  if (missing.length) throw new Error(`Environment belum lengkap: ${missing.join(', ')}.`);
  if (!/^\d{17,20}$/.test(env.DISCORD_CLIENT_ID)) throw new Error('DISCORD_CLIENT_ID tidak memiliki format application ID yang valid. Nilainya tidak ditampilkan.');
  return { applicationId: env.DISCORD_CLIENT_ID, token: env.DISCORD_TOKEN };
}

function sanitizedMessage(message) {
  return String(message || 'Tidak ada pesan error.')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL disembunyikan]')
    .replace(/\b(authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n]*/gi, '$1=[disembunyikan]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [disembunyikan]')
    .replace(/([\"']?(?:authorization|proxy-authorization|cookie|set-cookie|token|access[_-]?token|client[_-]?secret|DISCORD_TOKEN|DISCORD_CLIENT_ID)[\"']?\s*[:=]\s*[\"']?)[^\"'\s,;}]+/gi, '$1[disembunyikan]')
    .replace(DISCORD_TOKEN_PATTERN, '[token disembunyikan]')
    .replace(SNOWFLAKE_PATTERN, '[ID disembunyikan]')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .slice(0, 400);
}

function safeError(error) {
  const name = /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(error?.name || '') ? error.name : 'Error';
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status ?? 0);
  const httpStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 'none';
  const code = error?.code;
  const discordCode = Number.isInteger(code) ? code : 'none';
  const errorCode = typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'none';
  const stage = /^[a-z][a-z0-9-]{0,40}$/.test(error?.stage || '') ? error.stage : 'unknown';
  return `stage=${stage} type=${name} httpStatus=${httpStatus} discordCode=${discordCode} errorCode=${errorCode} message=${sanitizedMessage(error?.message)}`;
}

function addStage(error, stage) {
  if (error && typeof error === 'object' && error.stage) return error;
  const wrapped = new Error(error?.message || String(error));
  wrapped.name = error?.name || 'Error';
  wrapped.code = error?.code;
  wrapped.status = error?.status ?? error?.statusCode ?? error?.response?.status;
  wrapped.stage = stage;
  wrapped.cause = error;
  return wrapped;
}

async function runSyncSetupCli({
  args = process.argv.slice(2),
  env = process.env,
  projectRoot = PROJECT_ROOT,
  dotenvImpl = dotenv,
  restFactory = () => new REST({ version: '10' }),
  setupCommand = buildSetupCommand().toJSON(),
  logger = console
} = {}) {
  let stage = 'arguments';
  try {
    const options = validateTargetOptions(parseArgs(args));
    stage = 'dotenv-load';
    loadEnvironment({ env, projectRoot, dotenvImpl });
    stage = 'environment-validation';
    const { applicationId, token } = validateEnvironment(env);
    stage = 'schema-validation';
    const validatedSetupCommand = validateSetupCommandSchema(setupCommand);
    stage = 'rest-configuration';
    const rest = restFactory().setToken(token);
    stage = 'guild-command-sync';
    return await syncSetupGuildCommand({
      rest,
      applicationId,
      guildId: options.guildId,
      mode: options.mode,
      confirmedGuildId: options.confirmedGuildId,
      setupCommand: validatedSetupCommand,
      logger
    });
  } catch (error) {
    throw addStage(error, stage);
  }
}

if (require.main === module) {
  runSyncSetupCli().catch(error => {
    console.error(`Sinkronisasi dihentikan: ${safeError(error)}.`);
    process.exitCode = 1;
  });
}

module.exports = {
  PROJECT_ROOT,
  ENV_FILE,
  parseArgs,
  validateTargetOptions,
  loadEnvironment,
  validateEnvironment,
  sanitizedMessage,
  safeError,
  runSyncSetupCli
};
