'use strict';

const SKIP_COMMAND_REGISTRATION_ENV = 'NIGHTMARE_SKIP_COMMAND_REGISTRATION';

async function registerCommandsUnlessSkipped({ env = process.env, register, logger = console } = {}) {
  if (env[SKIP_COMMAND_REGISTRATION_ENV] === '1') {
    logger.log?.('[COMMANDS] Registrasi slash command dilewati karena NIGHTMARE_SKIP_COMMAND_REGISTRATION=1.');
    return { registered: false, skipped: true };
  }
  if (typeof register !== 'function') throw new TypeError('Callback registrasi command wajib tersedia.');
  await register();
  return { registered: true, skipped: false };
}

module.exports = { SKIP_COMMAND_REGISTRATION_ENV, registerCommandsUnlessSkipped };
